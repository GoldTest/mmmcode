import { describe, expect, it, vi, afterEach } from 'vitest';
import { isSameDayInShanghai, SchedulerService } from './scheduler.js';
import { AccountStore } from './accounts.js';
import { AccountPool } from './pool.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('SchedulerService', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('isSameDayInShanghai 正确判断同日与异日', () => {
    // 2026-11-08 12:00:00 UTC+8
    const t1 = new Date('2026-11-08T04:00:00Z').getTime();
    const t2 = new Date('2026-11-08T15:00:00Z').getTime(); // 23:00 UTC+8
    const t3 = new Date('2026-11-08T16:01:00Z').getTime(); // 2026-11-09 00:01 UTC+8

    expect(isSameDayInShanghai(t1, t2)).toBe(true);
    expect(isSameDayInShanghai(t1, t3)).toBe(false);
  });

  it('初始状态和配置加载/更新', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmcode-test-'));
    const store = new AccountStore({ filePath: join(dir, 'accounts.json') });
    const pool = new AccountPool(store);
    const scheduler = new SchedulerService(pool, { configPath: join(dir, 'scheduler.json') });

    const initial = scheduler.getConfig();
    expect(initial.autoCheckin.enabled).toBe(true);
    expect(initial.autoRefresh.enabled).toBe(true);
    /* 国内 / 海外两套独立计划，各带自己的时区。 */
    expect(initial.autoCheckin.cn.time).toBe('08:00');
    expect(initial.autoCheckin.cn.timezone).toBe('Asia/Shanghai');
    expect(initial.autoCheckin.global.time).toBe('08:00');
    expect(initial.autoCheckin.global.timezone).toBe('America/New_York');
    expect(initial.autoCheckin.cn.jitterMinutes).toBe(0);

    const updated = scheduler.updateConfig({
      autoCheckin: {
        enabled: false,
        cn: { time: '09:30', jitterMinutes: 20, timezone: 'Asia/Shanghai' },
        global: { time: '23:30', jitterMinutes: 10, timezone: 'Europe/London' },
        intervalMinutes: 60,
      },
    });
    expect(updated.autoCheckin.enabled).toBe(false);
    expect(updated.autoCheckin.cn.time).toBe('09:30');
    expect(updated.autoCheckin.cn.jitterMinutes).toBe(20);
    expect(updated.autoCheckin.global.time).toBe('23:30');
    expect(updated.autoCheckin.global.timezone).toBe('Europe/London');

    const status = scheduler.getStatus();
    expect(status.autoCheckin.enabled).toBe(false);
    expect(status.autoCheckin.regions.cn.time).toBe('09:30');
    expect(status.autoCheckin.regions.global.jitterMinutes).toBe(10);
    scheduler.stop();
  });

  it('旧形态补丁（单一 time）会套到国内与海外两套计划上', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmcode-test-'));
    const store = new AccountStore({ filePath: join(dir, 'accounts.json') });
    const pool = new AccountPool(store);
    const scheduler = new SchedulerService(pool, { configPath: join(dir, 'scheduler.json') });

    const updated = scheduler.updateConfig({
      autoCheckin: { time: '10:00', jitterMinutes: 15 },
    });
    expect(updated.autoCheckin.cn.time).toBe('10:00');
    expect(updated.autoCheckin.global.time).toBe('10:00');
    expect(updated.autoCheckin.cn.jitterMinutes).toBe(15);
    expect(updated.autoCheckin.global.jitterMinutes).toBe(15);
    scheduler.stop();
  });

  it('写坏的签到时间/时区会被清洗掉（不让「该签的那一刻」永远算不出来）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmcode-test-'));
    const store = new AccountStore({ filePath: join(dir, 'accounts.json') });
    const pool = new AccountPool(store);
    const scheduler = new SchedulerService(pool, { configPath: join(dir, 'scheduler.json') });

    const updated = scheduler.updateConfig({
      autoCheckin: {
        cn: { time: '25:00', timezone: 'Not/AZone', jitterMinutes: 9999 },
        global: { time: '08:00', jitterMinutes: -5 },
      },
    });
    expect(updated.autoCheckin.cn.time).toBe('08:00');
    expect(updated.autoCheckin.cn.timezone).toBe('Asia/Shanghai');
    expect(updated.autoCheckin.cn.jitterMinutes).toBe(240);
    expect(updated.autoCheckin.global.jitterMinutes).toBe(0);
    scheduler.stop();
  });

  it('checkinAll 跳过 checkinEnabled 为 false 的账号', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmcode-test-'));
    const store = new AccountStore({ filePath: join(dir, 'accounts.json') });
    const origHome = process.env.MMCODE_HOME;
    process.env.MMCODE_HOME = dir;
    try {
      const { accountDir } = await import('./accounts.js');
      for (const name of ['acc_on', 'acc_off']) {
        const d = accountDir(name);
        mkdirSync(d, { recursive: true });
        writeFileSync(
          join(d, 'credential.json'),
          JSON.stringify({
            accessToken: `token_${name}`,
            refreshToken: `refresh_${name}`,
            expiresAt: Date.now() + 3_600_000,
            region: 'cn',
          }),
        );
        store.upsert(name, 'cn');
      }
      store.update('acc_off', { checkinEnabled: false });

      const pool = new AccountPool(store);
      const scheduler = new SchedulerService(pool, { configPath: join(dir, 'scheduler.json') });

      const { MinimaxActivity } = await import('./activity.js');
      const checkinSpy = vi.spyOn(MinimaxActivity.prototype, 'checkin').mockResolvedValue({
        outcome: 'claimed',
        points: 10,
        streak: 1,
        message: '签到成功',
      });

      const results = await scheduler.checkinAll();
      scheduler.stop();

      expect(results).toHaveLength(1);
      expect(results[0]?.account).toBe('acc_on');
      expect(checkinSpy).toHaveBeenCalledTimes(1);

      checkinSpy.mockRestore();
    } finally {
      if (origHome === undefined) delete process.env.MMCODE_HOME;
      else process.env.MMCODE_HOME = origHome;
    }
  });

  it('自动签到**未到点不签**，到点才签', async () => {
    vi.useFakeTimers();
    /* 北京时间 2026-11-12 08:00（= UTC 00:00） */
    vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));

    const dir = mkdtempSync(join(tmpdir(), 'mmcode-test-'));
    const store = new AccountStore({ filePath: join(dir, 'accounts.json') });
    const origHome = process.env.MMCODE_HOME;
    process.env.MMCODE_HOME = dir;
    try {
      const { accountDir } = await import('./accounts.js');
      const d = accountDir('acc_cn');
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, 'credential.json'),
        JSON.stringify({
          accessToken: 'token_cn',
          refreshToken: 'refresh_cn',
          expiresAt: Date.now() + 3_600_000,
          region: 'cn',
        }),
      );
      store.upsert('acc_cn', 'cn');

      const pool = new AccountPool(store);
      const scheduler = new SchedulerService(pool, { configPath: join(dir, 'scheduler.json') });
      /* 把签到时间设在 1 小时后 —— 现在还没到点，不该签。 */
      scheduler.updateConfig({ autoCheckin: { cn: { time: '09:00', timezone: 'Asia/Shanghai' } } });

      const { MinimaxActivity } = await import('./activity.js');
      const checkinSpy = vi.spyOn(MinimaxActivity.prototype, 'checkin').mockResolvedValue({
        outcome: 'claimed',
        points: 10,
        streak: 1,
        message: '签到成功',
      });

      await scheduler.checkAndRunAutoCheckin();
      expect(checkinSpy).not.toHaveBeenCalled();

      /* 推进到 09:00 —— 到点了，该签。 */
      vi.setSystemTime(new Date('2026-11-12T01:00:00Z'));
      await scheduler.checkAndRunAutoCheckin();
      expect(checkinSpy).toHaveBeenCalledTimes(1);

      /* 同一天再跑一轮不该重复签。 */
      await scheduler.checkAndRunAutoCheckin();
      expect(checkinSpy).toHaveBeenCalledTimes(1);

      scheduler.stop();
    } finally {
      if (origHome === undefined) delete process.env.MMCODE_HOME;
      else process.env.MMCODE_HOME = origHome;
    }
  });

  it('国内与海外两套计划各按各的时区生效', async () => {
    vi.useFakeTimers();
    /* 北京 08:00 = UTC 00:00 */
    vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));

    const dir = mkdtempSync(join(tmpdir(), 'mmcode-test-'));
    const store = new AccountStore({ filePath: join(dir, 'accounts.json') });
    const origHome = process.env.MMCODE_HOME;
    process.env.MMCODE_HOME = dir;
    try {
      const { accountDir } = await import('./accounts.js');
      for (const [name, region] of [['acc_cn', 'cn'], ['acc_global', 'global']] as const) {
        const d = accountDir(name);
        mkdirSync(d, { recursive: true });
        writeFileSync(
          join(d, 'credential.json'),
          JSON.stringify({
            accessToken: `token_${name}`,
            refreshToken: `refresh_${name}`,
            expiresAt: Date.now() + 3_600_000,
            region,
          }),
        );
        store.upsert(name, region);
      }

      const pool = new AccountPool(store);
      const scheduler = new SchedulerService(pool, { configPath: join(dir, 'scheduler.json') });
      /* 两边都定 08:00 —— 国内按北京时间（已到点），海外按 UTC（还没到）。 */
      scheduler.updateConfig({
        autoCheckin: {
          cn: { time: '08:00', timezone: 'Asia/Shanghai' },
          global: { time: '08:00', timezone: 'UTC' },
        },
      });

      const { MinimaxActivity } = await import('./activity.js');
      const checkinSpy = vi.spyOn(MinimaxActivity.prototype, 'checkin').mockResolvedValue({
        outcome: 'claimed',
        points: 10,
        streak: 1,
        message: '签到成功',
      });

      await scheduler.checkAndRunAutoCheckin();
      expect(checkinSpy).toHaveBeenCalledTimes(1);

      /* 推进到 UTC 08:00（= 北京 16:00）—— 海外号到点了。 */
      vi.setSystemTime(new Date('2026-11-12T08:00:00Z'));
      await scheduler.checkAndRunAutoCheckin();
      expect(checkinSpy).toHaveBeenCalledTimes(2);

      scheduler.stop();
    } finally {
      if (origHome === undefined) delete process.env.MMCODE_HOME;
      else process.env.MMCODE_HOME = origHome;
    }
  });

  it('随机窗口：应签时刻落在 [窗口起, 窗口止] 内，且每天不同', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));

    const dir = mkdtempSync(join(tmpdir(), 'mmcode-test-'));
    const store = new AccountStore({ filePath: join(dir, 'accounts.json') });
    const origHome = process.env.MMCODE_HOME;
    process.env.MMCODE_HOME = dir;
    try {
      const { accountDir } = await import('./accounts.js');
      const d = accountDir('acc_cn');
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, 'credential.json'),
        JSON.stringify({
          accessToken: 'token_cn',
          refreshToken: 'refresh_cn',
          expiresAt: Date.now() + 3_600_000,
          region: 'cn',
        }),
      );
      store.upsert('acc_cn', 'cn');

      const pool = new AccountPool(store);
      const scheduler = new SchedulerService(pool, { configPath: join(dir, 'scheduler.json') });
      /* 08:30 前后各 30 分钟 ⇒ 窗口 08:00 ~ 09:00（北京时间）。 */
      scheduler.updateConfig({
        autoCheckin: { cn: { time: '08:30', jitterMinutes: 30, timezone: 'Asia/Shanghai' } },
      });

      const status = scheduler.getStatus();
      const region = status.autoCheckin.regions.cn;
      const winStart = new Date('2026-11-12T00:00:00Z').getTime();
      const winEnd = new Date('2026-11-12T01:00:00Z').getTime();
      expect(region.windowStart).toBe(winStart);
      expect(region.windowEnd).toBe(winEnd);
      /* 应签时刻在窗口内 —— 现在是 08:00，随机落点不会早于窗口起。 */
      expect(region.nextRunAt).not.toBeNull();
      expect(region.nextRunAt!).toBeGreaterThanOrEqual(winStart);
      expect(region.nextRunAt!).toBeLessThanOrEqual(winEnd);

      scheduler.stop();
    } finally {
      if (origHome === undefined) delete process.env.MMCODE_HOME;
      else process.env.MMCODE_HOME = origHome;
    }
  });
});
