import { describe, expect, it, vi } from 'vitest';
import { isSameDayInShanghai, SchedulerService } from './scheduler.js';
import { AccountStore } from './accounts.js';
import { AccountPool } from './pool.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('SchedulerService', () => {
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

    const updated = scheduler.updateConfig({
      autoCheckin: { enabled: false, time: '09:30', intervalMinutes: 60 },
    });
    expect(updated.autoCheckin.enabled).toBe(false);
    expect(updated.autoCheckin.time).toBe('09:30');

    const status = scheduler.getStatus();
    expect(status.autoCheckin.enabled).toBe(false);
    scheduler.stop();
  });

  it('checkinAll 跳过 checkinEnabled 为 false 的账号', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmcode-test-'));
    const store = new AccountStore({ filePath: join(dir, 'accounts.json') });
    const origHome = process.env.MMCODE_HOME;
    process.env.MMCODE_HOME = dir;
    try {
      const { mkdirSync, writeFileSync } = await import('node:fs');
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
});
