/**
 * 内存回归测试 —— 守住「容器不再被吃穿」。
 *
 * 这些测试守的是**具体的有界性**，而不是抽象的「不许涨」：
 *   ① 请求日志：单条裁剪 + 总字节闸 ⇒ 留存量与**请求体大小无关**；
 *   ② 中转快照：条数封顶（每条含完整请求体，最容易失控）；
 *   ③ session 绑定：LRU 封顶（唯一真正无界增长的 Map）；
 *   ④ 额度刷新：失败账号退避（不发请求）+ 调度器防重入（不叠加轮次）；
 *   ⑤ 账本解析：形状变了 → 抛错而**不是**返回 0（否则误冻结账号）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestStore, type RequestRecord } from './requests.js';
import { clipRecord, clipValue } from './clip.js';
import { AccountPool, MAX_SESSION_BINDINGS, MAX_TRANSIT_ENTRIES } from './pool.js';
import { AccountStore, accountDir } from './accounts.js';
import {
  InMemoryCreditsBackoff,
  refreshCreditsForAll,
  CREDITS_BACKOFF_BASE_MS,
} from './credits-refresh.js';
import { SchedulerService } from './scheduler.js';

let root = '';
const origHome = process.env.MMCODE_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mmcode-mem-'));
  process.env.MMCODE_HOME = root;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.MMCODE_HOME;
  else process.env.MMCODE_HOME = origHome;
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** 造一个「体积极大」的请求记录 —— 模拟 Claude Code 的大上下文。 */
function bigRecord(id: string, sizeKb: number): RequestRecord {
  return {
    id,
    timestamp: Date.now(),
    method: 'POST',
    path: '/v1/messages',
    stream: true,
    status: 200,
    durationMs: 100,
    input: {
      messages: Array.from({ length: 50 }, (_, i) => ({
        role: 'user',
        content: 'x'.repeat(sizeKb * 10),
      })),
      raw: 'y'.repeat(sizeKb * 1024),
    },
    output: {
      text: 'z'.repeat(sizeKb * 512),
      raw: 'w'.repeat(sizeKb * 1024),
    },
    transit: {
      upstream: 'https://agent.minimax.cn/mavis/api/v1/llm/v1/messages',
      account: 'a1',
      protocol: 'anthropic',
      payload: { messages: [{ role: 'user', content: 'v'.repeat(sizeKb * 1024) }] },
    },
  };
}

describe('裁剪', () => {
  it('超长字符串被截断且留标记', () => {
    const out = clipValue({ s: 'a'.repeat(100_000) }) as { s: string };
    expect(out.s.length).toBeLessThan(100_000);
    expect(out.s).toContain('已截断');
  });

  it('超长数组被截断且标注省略了多少项', () => {
    const out = clipValue({ arr: Array.from({ length: 500 }, (_, i) => i) }) as {
      arr: unknown[];
    };
    expect(out.arr.length).toBeLessThanOrEqual(101);
    const marker = out.arr[out.arr.length - 1] as { __truncated?: boolean; omitted?: number };
    expect(marker.__truncated).toBe(true);
    expect(marker.omitted).toBeGreaterThan(0);
  });

  it('★ 单条记录裁进预算内（哪怕原始体几十 MB）', () => {
    const { value, bytes } = clipRecord(bigRecord('r1', 512));
    /* 512KB × 多处 ⇒ 原始体上兆；裁完必须落到预算（48KB）内。 */
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
    expect(value.id).toBe('r1');
    /* 形状不变 —— 管理页照样能 JSON.stringify 出来。 */
    expect(() => JSON.stringify(value)).not.toThrow();
  });
});

describe('请求日志的字节闸', () => {
  it('★ 留存量与请求体大小**无关** —— 大请求不会撑爆内存', () => {
    const store = new RequestStore();
    for (let i = 0; i < 20; i += 1) {
      store.add(bigRecord(`big-${i}`, 512));
    }
    const stats = store.stats();
    /* 20 条 × 上兆的原始体 ⇒ 未经裁剪会是 20MB+；裁剪 + 预算闸后必须远小于此。 */
    expect(stats.estimatedMemoryBytes).toBeLessThan(4 * 1024 * 1024);
    /* 条数上限仍然生效。 */
    expect(stats.cachedCount).toBeLessThanOrEqual(200);
  });

  it('★ 字节预算触发时淘汰最旧的记录', () => {
    const store = new RequestStore();
    /* 预算取下限 4MB；每条裁剪后约 25KB ⇒ 需要 200+ 条才撑破。 */
    store.updateConfig({ maxBytes: 4 * 1024 * 1024, maxItems: 5000 });
    for (let i = 0; i < 300; i += 1) {
      store.add(bigRecord(`r-${i}`, 256));
    }
    const stats = store.stats();
    expect(stats.estimatedMemoryBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    /* 最新的必须还在，最旧的必须被淘汰。 */
    expect(store.get('r-299')).toBeDefined();
    expect(store.get('r-0')).toBeUndefined();
  });

  it('统计里的内存估算走记账，不逐条 stringify', () => {
    const store = new RequestStore();
    store.add(bigRecord('x', 128));
    expect(store.stats().estimatedMemoryBytes).toBeGreaterThan(0);
  });
});

describe('池内 Map 的上限', () => {
  function seedAccount(name: string): void {
    const dir = accountDir(name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'credential.json'),
      JSON.stringify({
        accessToken: `mmoat_${name}`,
        refreshToken: `mmort_${name}`,
        expiresAt: Date.now() + 3_600_000,
        region: 'cn',
      }),
    );
  }

  it('★ 中转快照条数封顶（每条含完整请求体 —— 最易失控的一处）', () => {
    const store = new AccountStore();
    seedAccount('a1');
    store.upsert('a1');
    const pool = new AccountPool(store);

    const bigPayload = { messages: [{ role: 'user', content: 'x'.repeat(200_000) }] };
    for (let i = 0; i < MAX_TRANSIT_ENTRIES + 50; i += 1) {
      pool.recordRequestTransit(`req-${i}`, {
        upstream: 'https://up',
        account: 'a1',
        protocol: 'anthropic',
        payload: bigPayload,
      });
    }
    /* 再加一条，看总量被裁掉多少 —— 用「最早的查不到」验证。 */
    pool.recordRequestTransit('req-latest', {
      upstream: 'https://up',
      account: 'a1',
      protocol: 'anthropic',
      payload: bigPayload,
    });
    expect(pool.getRequestTransit('req-latest')).not.toBeNull();
    expect(pool.getRequestTransit('req-0')).toBeNull();
  });

  it('★ 中转 payload 被截断（不留完整请求体）', () => {
    const store = new AccountStore();
    seedAccount('a1');
    store.upsert('a1');
    const pool = new AccountPool(store);
    pool.recordRequestTransit('req-big', {
      upstream: 'https://up',
      account: 'a1',
      protocol: 'anthropic',
      payload: { text: 'x'.repeat(500_000) },
    });
    const got = pool.getRequestTransit('req-big');
    const payload = got?.payload as { text?: string };
    expect((payload?.text ?? '').length).toBeLessThan(500_000);
  });

  it('★ session 绑定表封顶（LRU）—— 唯一真正无界增长的 Map', () => {
    const store = new AccountStore();
    seedAccount('a1');
    store.upsert('a1');
    const pool = new AccountPool(store);

    /* 造远超上限的 session。 */
    const total = MAX_SESSION_BINDINGS + 100;
    for (let i = 0; i < total; i += 1) {
      pool.acquireForSession(`s-${i}`);
    }
    /* 再访问一次最早的（把它变成「最近用过」），随后再挤一个进去。 */
    pool.acquireForSession('s-0');
    pool.acquireForSession('s-final');

    const counts = pool.sessionCounts();
    const totalBound = Object.values(counts).reduce((s, n) => s + n, 0);
    expect(totalBound).toBeLessThanOrEqual(MAX_SESSION_BINDINGS);
    /* LRU：刚用过的 s-0 应当还在。 */
    expect(pool.boundAccount('s-0')).toBe('a1');
  });
});

describe('额度刷新的退避与防重入', () => {
  function seedAccount(name: string): void {
    const dir = accountDir(name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'credential.json'),
      JSON.stringify({
        accessToken: `mmoat_${name}`,
        refreshToken: `mmort_${name}`,
        expiresAt: Date.now() + 3_600_000,
        region: 'cn',
      }),
    );
  }

  it('★ 失败账号进入退避 —— 下一轮**不发请求**', async () => {
    const store = new AccountStore();
    seedAccount('a1');
    store.upsert('a1');
    const pool = new AccountPool(store);

    let calls = 0;
    /* HTTP 500 = 上游故障（不可重试的失败）。 */
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return new Response('{}', { status: 500 });
      }),
    );

    const backoff = new InMemoryCreditsBackoff();
    const sleep = vi.fn(async () => {});
    const opts = { backoff, sleep, random: () => 0.5, staggerMs: 0 };

    /* 第一轮：上游故障 ⇒ 抛错。 */
    const first = await refreshCreditsForAll(pool, undefined, opts);
    expect(first[0]?.ok).toBe(false);
    expect(calls).toBeGreaterThan(0);
    const afterFirst = calls;

    /* 第二轮：退避窗口内 ⇒ 跳过，**一个请求都不发**。 */
    const second = await refreshCreditsForAll(pool, undefined, opts);
    expect(second[0]?.skipped).toBe(true);
    expect(calls).toBe(afterFirst);
  });

  it('★ 失败账号不会被按阈值冻结（读不懂账本 ≠ 余额 0）', async () => {
    const store = new AccountStore();
    seedAccount('a1');
    store.upsert('a1');
    store.setCreditsThreshold(100);
    const pool = new AccountPool(store);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ base_resp: { status_code: 0 }, details: 'shape-changed' }), {
          status: 200,
        }),
      ),
    );

    await refreshCreditsForAll(pool, undefined, {
      backoff: new InMemoryCreditsBackoff(),
      sleep: async () => {},
      random: () => 0.5,
      staggerMs: 0,
    });
    /* ★ 账号必须**没被冻结** —— 这是旧实现里最致命的一个 bug。 */
    expect(store.get('a1')?.frozen).not.toBe(true);
  });

  it('退避窗口随连续失败次数加长', () => {
    const backoff = new InMemoryCreditsBackoff();
    const now = 1_000_000;
    expect(backoff.shouldSkip('a1', now)).toBe(false);
    backoff.recordFailure('a1', now);
    expect(backoff.shouldSkip('a1', now)).toBe(true);
    expect(backoff.remainingMs('a1', now)).toBe(CREDITS_BACKOFF_BASE_MS);
    backoff.recordFailure('a1', now);
    expect(backoff.remainingMs('a1', now)).toBe(CREDITS_BACKOFF_BASE_MS * 2);
    backoff.recordSuccess('a1');
    expect(backoff.shouldSkip('a1', now)).toBe(false);
  });

  it('★ 调度器防重入：并发调用只跑一轮', async () => {
    const store = new AccountStore();
    seedAccount('a1');
    store.upsert('a1');
    const pool = new AccountPool(store);
    const scheduler = new SchedulerService(pool, { configPath: join(root, 'sched.json') });

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        await gate;
        return new Response(JSON.stringify({ base_resp: { status_code: 0 }, details: [] }), { status: 200 });
      }),
    );

    /* 同时发起两轮 —— 第二轮应当被防重入挡下。 */
    const first = scheduler.checkCreditsAll();
    const second = await scheduler.checkCreditsAll();
    expect(second).toEqual([]); // 被挡下
    expect(calls).toBe(1);
    release();
    await first;
    scheduler.stop();
  });
});
