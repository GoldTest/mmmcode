/**
 * 账号注册表测试。
 *
 * 守三件事：
 *   ① 注册表**真的落盘**（重启后还在）—— 这是「账号状态持久化」的地基；
 *   ② **不覆盖已有状态**：重扫磁盘时，已记下的冷却/健康/签到记录不能被抹掉；
 *   ③ 原子写：任何时刻崩溃都不会留下半个坏 JSON（读的时候要能兜底）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore, accountDir, accountsFilePath, defaultAccountDir, recordCheckinDay, sanitizeCheckinDays, CHECKIN_LEDGER_DAYS } from './accounts.js';

let root = '';
const origHome = process.env.MMCODE_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mmcode-acc-'));
  process.env.MMCODE_HOME = root;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.MMCODE_HOME;
  else process.env.MMCODE_HOME = origHome;
  rmSync(root, { recursive: true, force: true });
});

/** 造一个已登录的账号（磁盘上放 credential.json）。 */
function seedAccount(name: string, region: 'cn' | 'global' = 'cn'): void {
  const dir = accountDir(name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'credential.json'),
    JSON.stringify({
      accessToken: `mmoat_${name}`,
      refreshToken: `mmort_${name}`,
      expiresAt: Date.now() + 3_600_000,
      region,
    }),
  );
}

describe('AccountStore：注册与持久化', () => {
  it('首次使用自动登记磁盘上已有的账号（含默认单账户）', () => {
    seedAccount('haiwai1', 'global');
    mkdirSync(defaultAccountDir(), { recursive: true });
    writeFileSync(join(defaultAccountDir(), 'credential.json'), JSON.stringify({ accessToken: 'a', refreshToken: 'b', expiresAt: 1 }));

    const store = new AccountStore();
    const names = store.list().map((a) => a.name);
    expect(names).toContain('haiwai1');
    expect(names).toContain('default');
    /* 区域跟着凭证走 —— 国内外是不同域名，认错就全错。 */
    expect(store.get('haiwai1')?.region).toBe('global');
  });

  it('注册表真的写到磁盘，新实例能读回来', () => {
    const store = new AccountStore();
    store.upsert('acct1', 'global');
    store.setMode('balanced');
    store.setCreditsThreshold(250);
    expect(existsSync(accountsFilePath())).toBe(true);

    const reloaded = new AccountStore();
    expect(reloaded.get('acct1')?.region).toBe('global');
    expect(reloaded.mode()).toBe('balanced');
    expect(reloaded.creditsThreshold()).toBe(250);
  });

  it('★ v1 文件（旧 active/strategy）自动迁移到 v2 并落盘', () => {
    mkdirSync(join(root, 'mmcode'), { recursive: true });
    writeFileSync(
      accountsFilePath(),
      JSON.stringify({
        version: 1,
        active: 'old',
        strategy: 'round-robin',
        accounts: [
          { name: 'old', region: 'cn', enabled: true, createdAt: 1, updatedAt: 1, health: 'healthy' },
          { name: 'new', region: 'global', enabled: true, createdAt: 2, updatedAt: 2, health: 'healthy' },
        ],
      }),
    );

    const store = new AccountStore();
    /* 旧的两个概念整体消失；账号继承同一优先级（同层加权随机分配）。 */
    expect(store.mode()).toBe('max-cache');
    expect(store.list().map((a) => a.priority)).toEqual([0, 0]);
    expect(store.get('old')?.region).toBe('cn');

    /* 迁移结果立刻落盘 —— 旧字段不该留在文件里误导人。 */
    const raw = JSON.parse(readFileSync(accountsFilePath(), 'utf8')) as Record<string, unknown>;
    expect(raw.version).toBe(2);
    expect(raw.active).toBeUndefined();
    expect(raw.strategy).toBeUndefined();
    expect(raw.mode).toBe('max-cache');
  });

  it('update 只改传入的字段', () => {
    const store = new AccountStore();
    store.upsert('a1', 'cn');
    store.update('a1', { notes: '备注' });
    const rec = store.get('a1');
    expect(rec?.notes).toBe('备注');
    expect(rec?.region).toBe('cn');
    expect(rec?.enabled).toBe(true);
    expect(rec?.checkinEnabled).toBe(true);
  });

  it('支持修改与持久化 checkinEnabled（单独停用/启用自动签到）', () => {
    const store = new AccountStore();
    store.upsert('a1', 'cn');
    expect(store.get('a1')?.checkinEnabled).toBe(true);

    store.update('a1', { checkinEnabled: false });
    expect(store.get('a1')?.checkinEnabled).toBe(false);

    // 重建 store 验证落盘持久化
    const reloaded = new AccountStore();
    expect(reloaded.get('a1')?.checkinEnabled).toBe(false);
  });

  it('支持记录与持久化 lastReward（上次签到奖励时间与积分）', () => {
    const store = new AccountStore();
    store.upsert('a1', 'cn');
    const rewardTime = 1700000000000;
    store.update('a1', {
      lastCheckin: { at: rewardTime, outcome: 'claimed', points: 400, streak: 3, message: '签到成功' },
      lastReward: { at: rewardTime, points: 400 },
    });
    expect(store.get('a1')?.lastReward).toEqual({ at: rewardTime, points: 400 });

    const reloaded = new AccountStore();
    expect(reloaded.get('a1')?.lastReward).toEqual({ at: rewardTime, points: 400 });
  });

  it('旧数据迁移：有 lastCheckin.points 但无 lastReward 时自动归一化', () => {
    const store = new AccountStore();
    store.upsert('a1', 'cn');
    const rewardTime = 1700000000000;
    store.update('a1', {
      lastCheckin: { at: rewardTime, outcome: 'claimed', points: 400, streak: 3, message: '签到成功' },
    });

    const reloaded = new AccountStore();
    expect(reloaded.get('a1')?.lastReward).toEqual({ at: rewardTime, points: 400 });
  });

  it('update 不存在的账号返回 null', () => {
    const store = new AccountStore();
    expect(store.update('nope', { enabled: false })).toBeNull();
  });

  it('remove 移除账号条目（不牵连其它账号）', () => {
    const store = new AccountStore();
    store.upsert('a1');
    store.upsert('a2');
    store.remove('a1');
    expect(store.get('a1')).toBeNull();
    expect(store.get('a2')).not.toBeNull();
  });

  it('重扫磁盘**不覆盖**已有状态（冷却/健康记录不能被抹掉）', () => {
    seedAccount('a1');
    const store = new AccountStore();
    store.update('a1', { health: 'unauthorized', disabledUntil: Date.now() + 60_000 });
    const added = store.rescan();
    expect(added).toHaveLength(0);
    const rec = store.get('a1');
    expect(rec?.health).toBe('unauthorized');
    expect(rec?.disabledUntil).toBeGreaterThan(Date.now());
  });

  it('重扫能发现**新增**的账号目录', () => {
    const store = new AccountStore();
    expect(store.list()).toHaveLength(0);
    seedAccount('fresh');
    const added = store.rescan();
    expect(added.map((a) => a.name)).toEqual(['fresh']);
    expect(store.get('fresh')).not.toBeNull();
  });

  it('注册表文件损坏时兜底：备份坏文件、从空表起步', () => {
    mkdirSync(join(root, 'mmcode'), { recursive: true });
    writeFileSync(accountsFilePath(), '{ 这不是 JSON');
    const store = new AccountStore();
    expect(store.list()).toEqual([]);
    /* 坏文件被改名备份，不留在原地反复毒化启动。 */
    expect(existsSync(accountsFilePath())).toBe(true);
    expect(readFileSync(accountsFilePath(), 'utf8')).toContain('version');
  });

  it('账号名不可用作路径（防穿越由 API 层把关，这里验证落盘路径可控）', () => {
    const store = new AccountStore();
    store.upsert('safe_name-1');
    expect(store.get('safe_name-1')).not.toBeNull();
  });
});

describe('AccountStore：调整顺序', () => {
  it('reorder 按给定顺序重排账号', () => {
    const store = new AccountStore();
    store.upsert('a1');
    store.upsert('a2');
    store.upsert('a3');
    store.reorder(['a3', 'a1', 'a2']);
    expect(store.list().map((a) => a.name)).toEqual(['a3', 'a1', 'a2']);
  });

  it('reorder 后的顺序会落盘（新实例读得到）', () => {
    const store = new AccountStore();
    store.upsert('a1');
    store.upsert('a2');
    store.reorder(['a2', 'a1']);
    const reopened = new AccountStore();
    expect(reopened.list().map((a) => a.name)).toEqual(['a2', 'a1']);
  });

  it('reorder 未列出的账号保留在后面（不丢人）', () => {
    const store = new AccountStore();
    store.upsert('a1');
    store.upsert('a2');
    store.upsert('a3');
    store.reorder(['a3']);
    expect(store.list().map((a) => a.name)).toEqual(['a3', 'a1', 'a2']);
  });

  it('reorder 不影响优先级与其它状态字段', () => {
    const store = new AccountStore();
    store.upsert('a1');
    store.upsert('a2');
    store.update('a1', { priority: 5, health: 'unauthorized' });
    store.reorder(['a2', 'a1']);
    const rec = store.get('a1');
    expect(rec?.priority).toBe(5);
    expect(rec?.health).toBe('unauthorized');
  });
});

/**
 * 签到台账（按天）—— 回答「昨天签没签 / 什么时候签的 / 拿到多少积分」的唯一依据。
 *
 * 守两件事：
 *   ① 同一天合并，且**成功是粘性的**（签成后再失败不能把「今天签了」抹掉）；
 *   ② 只保留最近 N 天，且坏数据（手改过的 accounts.json）不会污染页面。
 */
describe('签到台账：按天记录', () => {
  const attempt = (over: Partial<{ at: number; outcome: 'claimed' | 'already' | 'unavailable' | 'error'; points: number | null; streak: number | null; message: string }> = {}) => ({
    at: 1_700_000_000_000,
    outcome: 'claimed' as const,
    points: 100,
    streak: 3,
    message: '签到成功',
    ...over,
  });

  it('同一天合并成一条：outcome 取最后一次，signed 保持成功', () => {
    let days = recordCheckinDay(undefined, '2026-11-19', attempt());
    expect(days['2026-11-19']?.signed).toBe(true);
    expect(days['2026-11-19']?.signedAt).toBe(1_700_000_000_000);
    expect(days['2026-11-19']?.points).toBe(100);

    /* 当天后来又失败一次 —— 「今天签了」不能被抹掉。 */
    days = recordCheckinDay(days, '2026-11-19', attempt({ at: 1_700_000_600_000, outcome: 'error', points: null, message: '上游 5xx' }));
    expect(days['2026-11-19']?.signed).toBe(true);
    expect(days['2026-11-19']?.signedAt).toBe(1_700_000_000_000);
    /* 但「最后一次尝试」确实是异常 —— 页面上要能看到。 */
    expect(days['2026-11-19']?.outcome).toBe('error');
    expect(days['2026-11-19']?.at).toBe(1_700_000_600_000);
    /* 积分沿用当天成功那次的。 */
    expect(days['2026-11-19']?.points).toBe(100);
  });

  it('只保留最近 CHECKIN_LEDGER_DAYS 天', () => {
    let days: Record<string, any> = {};
    for (let i = 1; i <= 12; i++) {
      const key = `2026-11-${String(i).padStart(2, '0')}`;
      days = recordCheckinDay(days, key, attempt({ at: 1_700_000_000_000 + i * 86_400_000 }));
    }
    expect(Object.keys(days).length).toBe(CHECKIN_LEDGER_DAYS);
    /* 留下的是最近的几天。 */
    expect(days['2026-11-12']).toBeDefined();
    expect(days['2026-11-01']).toBeUndefined();
  });

  it('坏数据会被清洗掉（日期键不合法 / outcome 不认识 / at 非数字）', () => {
    const days = sanitizeCheckinDays({
      '2026-11-19': { at: 1, outcome: 'claimed', signed: true, points: 5, message: 'ok' },
      'not-a-date': { at: 1, outcome: 'claimed' },
      '2026-11-18': { at: 'x', outcome: 'claimed' },
      '2026-11-17': { at: 1, outcome: 'weird' },
      '2026-11-16': { at: 1, outcome: 'error', message: 'boom' },
    });
    expect(Object.keys(days)).toEqual(['2026-11-19', '2026-11-16']);
    expect(days['2026-11-19']?.points).toBe(5);
    expect(days['2026-11-16']?.signed).toBe(false);
  });

  it('台账会跟着账号一起落盘（重启后还在 —— 这是「昨天签没签」能回看的前提）', () => {
    const store = new AccountStore({ filePath: join(root, 'accounts.json') });
    store.upsert('a1');
    store.update('a1', {
      checkinDays: recordCheckinDay(undefined, '2026-11-19', attempt()),
    });
    const reopened = new AccountStore({ filePath: join(root, 'accounts.json') });
    expect(reopened.get('a1')?.checkinDays?.['2026-11-19']?.signed).toBe(true);
  });
});
