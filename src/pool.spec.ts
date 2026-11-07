/**
 * 账号池测试 —— 自动切换策略的核心。
 *
 * 守三件事：
 *   ① **粘性**：默认一直用同一个账号（额度消耗最低）；
 *   ② **故障转移**：某个号 401/429 后，**下一个**请求自动换号；
 *   ③ **冷却是持久化的**：服务重启后仍记得「这个号刚被顶掉」，不重复撞墙。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore, accountDir } from './accounts.js';
import { AccountPool, COOLDOWN_RATE_LIMITED_MS, COOLDOWN_UNAUTHORIZED_MS } from './pool.js';

let root = '';
const origHome = process.env.MMCODE_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mmcode-pool-'));
  process.env.MMCODE_HOME = root;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.MMCODE_HOME;
  else process.env.MMCODE_HOME = origHome;
  rmSync(root, { recursive: true, force: true });
});

/** 造一个已登录的账号。 */
function seed(name: string, region: 'cn' | 'global' = 'cn'): void {
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

describe('选号', () => {
  it('没登录的账号不参与切换（没凭证就没法服务请求）', () => {
    const store = new AccountStore();
    store.upsert('ghost'); /* 只有条目，没有 credential.json */
    seed('real');
    const pool = new AccountPool(store);
    expect(pool.available().map((a) => a.record.name)).toEqual(['real']);
  });

  it('停用的账号不参与切换', () => {
    const store = new AccountStore();
    seed('a1');
    seed('a2');
    store.upsert('a1');
    store.upsert('a2');
    store.update('a1', { enabled: false });
    const pool = new AccountPool(store);
    expect(pool.available().map((a) => a.record.name)).toEqual(['a2']);
  });

  it('★ 粘性：默认一直返回同一个账号', async () => {
    const store = new AccountStore();
    seed('a1');
    seed('a2');
    store.setActive('a1');
    const pool = new AccountPool(store);
    const first = await pool.acquire();
    const second = await pool.acquire();
    expect(first?.record.name).toBe('a1');
    expect(second?.record.name).toBe('a1');
  });

  it('粘性账号不可用时自动落到别的账号，并把粘性指针挪过去', async () => {
    const store = new AccountStore();
    seed('a1');
    seed('a2');
    store.setActive('a1');
    const pool = new AccountPool(store);
    const a1 = pool.get('a1')!;
    pool.reportFailure(a1, 'unauthorized', 'HTTP 401');
    const picked = await pool.acquire();
    expect(picked?.record.name).toBe('a2');
    expect(store.activeName()).toBe('a2');
  });

  it('严格轮询：轮流取号', async () => {
    const store = new AccountStore();
    seed('a1');
    seed('a2');
    store.setStrategy('round-robin');
    const pool = new AccountPool(store);
    const names: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const a = await pool.acquire();
      if (a) names.push(a.record.name);
    }
    expect(names).toEqual(['a1', 'a2', 'a1', 'a2']);
  });

  it('一个可用账号都没有时返回 null', async () => {
    const store = new AccountStore();
    const pool = new AccountPool(store);
    expect(await pool.acquire()).toBeNull();
  });
});

describe('失败归类与冷却', () => {
  it('401/403 → unauthorized；429 → rate_limited；其余 → error', () => {
    expect(AccountPool.classify(401)).toBe('unauthorized');
    expect(AccountPool.classify(403)).toBe('unauthorized');
    expect(AccountPool.classify(429)).toBe('rate_limited');
    expect(AccountPool.classify(500)).toBe('error');
    expect(AccountPool.classify(502)).toBe('error');
  });

  it('★ 401 后该号进入冷却，不再被选中', async () => {
    const store = new AccountStore();
    seed('a1');
    seed('a2');
    store.setActive('a1');
    const pool = new AccountPool(store);
    pool.reportFailure(pool.get('a1')!, 'unauthorized', 'HTTP 401');
    expect(pool.available().map((a) => a.record.name)).toEqual(['a2']);
  });

  it('冷却时长符合预期（401 半小时、429 一分钟）', () => {
    const store = new AccountStore();
    seed('a1');
    const pool = new AccountPool(store);
    const a1 = pool.get('a1')!;
    const before = Date.now();
    pool.reportFailure(a1, 'unauthorized', 'x');
    const until = store.get('a1')!.disabledUntil!;
    expect(until - before).toBeGreaterThanOrEqual(COOLDOWN_UNAUTHORIZED_MS - 1000);
    pool.reportFailure(a1, 'rate_limited', 'x');
    const until2 = store.get('a1')!.disabledUntil!;
    expect(until2 - before).toBeGreaterThanOrEqual(COOLDOWN_RATE_LIMITED_MS - 1000);
  });

  it('★ 冷却是**持久**的：新实例读到的还是冷却中', () => {
    const store = new AccountStore();
    seed('a1');
    seed('a2');
    store.setActive('a1');
    const pool = new AccountPool(store);
    pool.reportFailure(pool.get('a1')!, 'unauthorized', 'HTTP 401');

    /* 新进程：注册表从磁盘读，冷却状态还在。 */
    const store2 = new AccountStore();
    const pool2 = new AccountPool(store2);
    expect(pool2.available().map((a) => a.record.name)).toEqual(['a2']);
  });

  it('成功后清冷却、标健康、记使用时间', () => {
    const store = new AccountStore();
    seed('a1');
    const pool = new AccountPool(store);
    const a1 = pool.get('a1')!;
    pool.reportFailure(a1, 'unauthorized', 'x');
    pool.reportSuccess(a1);
    const rec = store.get('a1')!;
    expect(rec.health).toBe('healthy');
    expect(rec.disabledUntil).toBeUndefined();
    expect(rec.lastUsedAt).toBeGreaterThan(0);
  });
});
