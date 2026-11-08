/**
 * 账号池测试 —— 调度模型的核心。
 *
 * 守五件事：
 *   ① **优先级分层**：新 session 落在最高可用层；高层全不可用了才下沉；
 *   ② **同层随机**：同层之内没有先后顺序；
 *   ③ **额度冻结**：余额低于阈值的账号不参与调度，余额恢复即解冻；
 *   ④ **session 绑定**：同一 session 拿回同一账号（保住上游缓存）；
 *   ⑤ **两种模式**：最大缓存模式下绑定账号不可用 ⇒ 不迁移；平衡模式 ⇒ 无缝滑动。
 *
 * 另外守住老行为：失败归类、冷却时长、**冷却是持久的**（重启后仍记得）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore, accountDir } from './accounts.js';
import {
  AccountPool,
  COOLDOWN_RATE_LIMITED_MS,
  COOLDOWN_UNAUTHORIZED_MS,
  classifyFailure,
} from './pool.js';

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

/** 造一个已登录 + 指定优先级的账号（**用同一个 store** —— 否则写不进同一份注册表）。 */
function seedWithPriority(store: AccountStore, name: string, priority: number): void {
  seed(name);
  store.upsert(name);
  store.update(name, { priority });
}

describe('可用性', () => {
  it('没登录的账号不参与调度（没凭证就没法服务请求）', () => {
    const store = new AccountStore();
    store.upsert('ghost'); /* 只有条目，没有 credential.json */
    seed('real');
    const pool = new AccountPool(store);
    expect(pool.available().map((a) => a.record.name)).toEqual(['real']);
  });

  it('停用的账号不参与调度', () => {
    const store = new AccountStore();
    seed('a1');
    seed('a2');
    store.upsert('a1');
    store.upsert('a2');
    store.update('a1', { enabled: false });
    const pool = new AccountPool(store);
    expect(pool.available().map((a) => a.record.name)).toEqual(['a2']);
  });

  it('一个可用账号都没有时给出「没有可用账号」', () => {
    const store = new AccountStore();
    const pool = new AccountPool(store);
    const result = pool.acquireForSession('s1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-account');
  });
});

describe('优先级分层', () => {
  it('★ 新 session 落在**最高可用层**', () => {
    const store = new AccountStore();
    seedWithPriority(store, 'high', 0);
    seedWithPriority(store, 'low', 5);
    const pool = new AccountPool(store);
    const result = pool.acquireForSession('s-new');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.account.record.name).toBe('high');
  });

  it('★ 最高层全不可用时才下沉到下一层', () => {
    const store = new AccountStore();
    seedWithPriority(store, 'high', 0);
    seedWithPriority(store, 'low', 5);
    const pool = new AccountPool(store);
    /* 高层冻结 → 只能用低层。 */
    store.update('high', { frozen: true, frozenReason: '余额不足' });
    const result = pool.acquireForSession('s-new');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.account.record.name).toBe('low');
  });

  it('同层之内随机分配（不会固定落在同一个号上）', () => {
    const store = new AccountStore();
    seedWithPriority(store, 'a1', 0);
    seedWithPriority(store, 'a2', 0);
    const pool = new AccountPool(store);
    /* 多建几个 session，看是否覆盖到不止一个账号。
       随机性不能用「必然」断言 —— 但连续 40 次都撞同一个号的概率低到可以忽略。 */
    const picked = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const r = pool.acquireForSession(`s-${i}`);
      if (r.ok) picked.add(r.account.record.name);
    }
    expect(picked.size).toBeGreaterThan(1);
  });
});

describe('额度冻结', () => {
  it('★ 余额低于阈值 → 冻结，不参与调度', () => {
    const store = new AccountStore();
    seedWithPriority(store, 'a1', 0);
    seedWithPriority(store, 'a2', 1);
    const pool = new AccountPool(store);
    store.setCreditsThreshold(100);
    pool.applyCreditsBalance('a1', 42);
    expect(store.get('a1')?.frozen).toBe(true);
    expect(pool.available().map((a) => a.record.name)).toEqual(['a2']);
  });

  it('余额回到阈值以上 → 自动解冻', () => {
    const store = new AccountStore();
    seedWithPriority(store, 'a1', 0);
    const pool = new AccountPool(store);
    store.setCreditsThreshold(100);
    pool.applyCreditsBalance('a1', 42);
    expect(store.get('a1')?.frozen).toBe(true);
    pool.applyCreditsBalance('a1', 260);
    expect(store.get('a1')?.frozen).toBe(false);
    expect(pool.available().map((a) => a.record.name)).toEqual(['a1']);
  });

  it('429 → 额度冻结（带自愈窗口）', () => {
    const store = new AccountStore();
    seed('a1');
    const pool = new AccountPool(store);
    pool.reportFailure(pool.get('a1')!, 'rate_limited', '上游 HTTP 429');
    const rec = store.get('a1')!;
    expect(rec.frozen).toBe(true);
    expect(rec.frozenUntil).toBeGreaterThan(Date.now());
    expect(pool.available()).toHaveLength(0);
  });
});

describe('session 绑定', () => {
  it('★ 同一 session 拿回同一个账号（保住上游缓存）', () => {
    const store = new AccountStore();
    seedWithPriority(store, 'a1', 0);
    seedWithPriority(store, 'a2', 0);
    const pool = new AccountPool(store);
    const first = pool.acquireForSession('s-1');
    const second = pool.acquireForSession('s-1');
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.account.record.name).toBe(first.account.record.name);
      expect(second.slid).toBe(false);
    }
  });

  it('不同 session 各自绑定（可能落在不同账号上）', () => {
    const store = new AccountStore();
    seedWithPriority(store, 'a1', 0);
    seedWithPriority(store, 'a2', 0);
    const pool = new AccountPool(store);
    const names = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const r = pool.acquireForSession(`s-${i}`);
      if (r.ok) names.add(r.account.record.name);
    }
    expect(names.size).toBeGreaterThan(1);
    expect(Object.keys(pool.sessionCounts()).length).toBeGreaterThan(1);
  });
});

describe('两种模式', () => {
  it('★ 最大缓存模式：绑定账号不可用 → **不迁移**，报 pinned', () => {
    const store = new AccountStore();
    seedWithPriority(store, 'a1', 0);
    seedWithPriority(store, 'a2', 1);
    const pool = new AccountPool(store);
    store.setMode('max-cache');

    const first = pool.acquireForSession('s-1');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const bound = first.account.record.name;

    /* 绑定账号额度耗尽。 */
    store.update(bound, { frozen: true, frozenReason: '余额不足' });

    const again = pool.acquireForSession('s-1');
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.reason).toBe('pinned');
      expect(again.pinnedAccount).toBe(bound);
      expect(again.detail).toMatch(/最大缓存/);
    }
  });

  it('★ 平衡模式：绑定账号额度耗尽 → **无缝滑动**到别的账号', () => {
    const store = new AccountStore();
    seedWithPriority(store, 'a1', 0);
    seedWithPriority(store, 'a2', 1);
    const pool = new AccountPool(store);
    store.setMode('balanced');

    const first = pool.acquireForSession('s-1');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const bound = first.account.record.name;

    store.update(bound, { frozen: true, frozenReason: '余额不足' });

    const again = pool.acquireForSession('s-1');
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.account.record.name).not.toBe(bound);
      expect(again.slid).toBe(true);
      /* 绑定跟着滑动 —— 下一轮还是这个新账号。 */
      const third = pool.acquireForSession('s-1');
      expect(third.ok && third.account.record.name).toBe(again.account.record.name);
    }
  });

  it('★ 绑定账号被删除 → 平衡模式滑到别的号；最大缓存模式报 pinned（不崩）', () => {
    const store = new AccountStore();
    seedWithPriority(store, 'a1', 0);
    seedWithPriority(store, 'a2', 1);
    const pool = new AccountPool(store);
    store.setMode('balanced');

    const first = pool.acquireForSession('s-del');
    expect(first.ok).toBe(true);
    const bound = first.ok ? first.account.record.name : '';

    /* 绑定账号被删掉了（注册表里没了）。 */
    store.remove(bound);
    const slid = pool.acquireForSession('s-del');
    expect(slid.ok).toBe(true);
    if (slid.ok) expect(slid.account.record.name).not.toBe(bound);

    /* 最大缓存模式下同一个场景要报错，而不是空指针崩掉。 */
    store.setMode('max-cache');
    const pinned = pool.acquireForSession('s-del2');
    pool.acquireForSession('s-del2');
    const other = pool.acquireForSession('s-del3');
    expect(other.ok).toBe(true);
    if (other.ok) {
      store.remove(other.account.record.name);
      const stuck = pool.acquireForSession('s-del3');
      expect(stuck.ok).toBe(false);
      if (!stuck.ok) expect(stuck.reason).toBe('pinned');
    }
    expect(pinned.ok).toBe(true);
  });

  it('平衡模式：额度可用时行为与最大缓存一致（不滑动）', () => {    const store = new AccountStore();
    seedWithPriority(store, 'a1', 0);
    seedWithPriority(store, 'a2', 1);
    const pool = new AccountPool(store);
    store.setMode('balanced');

    const first = pool.acquireForSession('s-1');
    const second = pool.acquireForSession('s-1');
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.account.record.name).toBe(first.account.record.name);
      expect(second.slid).toBe(false);
    }
  });
});

describe('失败归类与冷却', () => {
  it('401/403 → unauthorized；429 → rate_limited；其余 → error', () => {
    expect(classifyFailure(401)).toBe('unauthorized');
    expect(classifyFailure(403)).toBe('unauthorized');
    expect(classifyFailure(429)).toBe('rate_limited');
    expect(classifyFailure(500)).toBe('error');
    expect(classifyFailure(502)).toBe('error');
  });

  it('★ 401 后该号进入冷却，不再被选中', () => {
    const store = new AccountStore();
    seed('a1');
    seed('a2');
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

  it('手动解除冷却 + 冻结', () => {
    const store = new AccountStore();
    seed('a1');
    const pool = new AccountPool(store);
    pool.reportFailure(pool.get('a1')!, 'rate_limited', 'HTTP 429');
    expect(pool.available()).toHaveLength(0);
    pool.resetCooldown('a1');
    expect(store.get('a1')?.frozen).toBe(false);
    expect(pool.available().map((a) => a.record.name)).toEqual(['a1']);
  });
});
