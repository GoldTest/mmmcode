import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore, accountDir } from './accounts.js';
import { AccountPool } from './pool.js';
import { probeAccount, probeAllAccounts, warmupAccount, warmupAllAccounts } from './probe.js';
import { RequestStore } from './requests.js';

let root = '';
const origHome = process.env.MMCODE_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mmcode-probe-'));
  process.env.MMCODE_HOME = root;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.MMCODE_HOME;
  else process.env.MMCODE_HOME = origHome;
  rmSync(root, { recursive: true, force: true });
});

function seedAccount(store: AccountStore, name: string, region: 'cn' | 'global' = 'cn'): void {
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
  store.upsert(name, region);
}

function sseResponse(events: string[], delayMs = 0): Promise<Response> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      for (const ev of events) {
        controller.enqueue(encoder.encode(ev));
      }
      controller.close();
    },
  });
  return Promise.resolve(
    new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }),
  );
}

describe('预热功能 (warmupAccount / warmupAllAccounts)', () => {
  it('调用 count_tokens 不占 token 让接口返回一次，并记录耗时', async () => {
    const store = new AccountStore();
    seedAccount(store, 'acc1');
    const pool = new AccountPool(store);
    const acc = pool.get('acc1')!;

    let capturedUrl = '';
    const mockFetch: typeof fetch = async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ input_tokens: 4 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const res = await warmupAccount(pool, acc, { fetchImpl: mockFetch });
    expect(res.ok).toBe(true);
    expect(capturedUrl).toContain('/mavis/api/v1/llm/v1/messages/count_tokens');
    const updated = pool.get('acc1')!;
    expect(updated.record.lastWarmup?.ok).toBe(true);
    expect(updated.record.lastWarmup?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('未登录账号预热直接跳过', async () => {
    const store = new AccountStore();
    store.upsert('ghost');
    const pool = new AccountPool(store);
    const acc = pool.get('ghost')!;
    const res = await warmupAccount(pool, acc);
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe(true);
  });

  it('批量预热所有已登录且启用账号', async () => {
    const store = new AccountStore();
    seedAccount(store, 'a1');
    seedAccount(store, 'a2');
    store.upsert('ghost');

    const pool = new AccountPool(store);
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ input_tokens: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const results = await warmupAllAccounts(pool, { fetchImpl: mockFetch });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('预热请求会写进请求列表，来源标为 warmup', async () => {
    const store = new AccountStore();
    seedAccount(store, 'acc1');
    const pool = new AccountPool(store);
    const requests = new RequestStore();

    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ input_tokens: 4 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    await warmupAccount(pool, pool.get('acc1')!, { fetchImpl: mockFetch, requests });

    const list = requests.list();
    expect(list.total).toBe(1);
    const item = list.items[0]!;
    expect(item.source).toBe('warmup');
    expect(item.account).toBe('acc1');
    expect(item.status).toBe(200);
    expect(item.path).toContain('count_tokens');
    /* 中转信息要能看到上游地址与请求体（不含令牌）。 */
    expect(item.transit?.upstream).toBeTruthy();
    expect(item.transit?.payload).toMatchObject({ model: 'MiniMax-M3' });
    /* 预热是 0 token，不能记进消耗统计。 */
    expect(item.output?.usage).toBeUndefined();
  });

  it('预热失败也会留痕（状态码与错误信息都在列表里）', async () => {
    const store = new AccountStore();
    seedAccount(store, 'acc1');
    const pool = new AccountPool(store);
    const requests = new RequestStore();

    const mockFetch: typeof fetch = async () => new Response('too many requests', { status: 429 });

    const res = await warmupAccount(pool, pool.get('acc1')!, { fetchImpl: mockFetch, requests });
    expect(res.ok).toBe(false);

    const item = requests.list().items[0]!;
    expect(item.source).toBe('warmup');
    expect(item.status).toBe(429);
    expect(item.error).toContain('429');
  });
});

describe('测活功能 (probeAccount / probeAllAccounts)', () => {
  it('首字返回在阈值内：状态正常，且可自动解除先前的限流标记', async () => {
    const store = new AccountStore();
    seedAccount(store, 'fast');
    store.update('fast', {
      rateLimited: true,
      rateLimitReason: '之前疑似限流',
      health: 'rate_limited',
    });

    const pool = new AccountPool(store);
    expect(pool.available()).toHaveLength(0);

    const mockFetch: typeof fetch = () =>
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"1"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      ]);

    const res = await probeAccount(pool, pool.get('fast')!, {
      fetchImpl: mockFetch,
      suspectedMs: 200,
      pauseMs: 400,
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe('ok');
    expect(res.rateLimited).toBe(false);
    expect(res.paused).toBe(false);

    const updated = pool.get('fast')!;
    expect(updated.record.rateLimited).toBe(false);
    expect(updated.record.health).toBe('healthy');
    expect(pool.available().map((a) => a.record.name)).toEqual(['fast']);
  });

  it('首字超过 20s 警戒阈值（模拟为 60ms）：标记疑似被限流，且不再进行调度', async () => {
    const store = new AccountStore();
    seedAccount(store, 'slow');
    const pool = new AccountPool(store);

    const mockFetch: typeof fetch = () =>
      sseResponse(
        [
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        ],
        60,
      );

    const res = await probeAccount(pool, pool.get('slow')!, {
      fetchImpl: mockFetch,
      suspectedMs: 30,
      pauseMs: 300,
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe('suspected');
    expect(res.rateLimited).toBe(true);
    expect(res.paused).toBe(false);

    const updated = pool.get('slow')!;
    expect(updated.record.enabled).toBe(true);
    expect(updated.record.rateLimited).toBe(true);
    expect(updated.record.health).toBe('rate_limited');
    /* 被限流的账号不再参与调度 */
    expect(pool.available()).toHaveLength(0);
    expect(pool.unavailableReason(updated)).toContain('限流');
  });

  it('首字超过 30s 暂停阈值（模拟为 90ms）：直接暂停掉账号并标记限流', async () => {
    const store = new AccountStore();
    seedAccount(store, 'very-slow');
    const pool = new AccountPool(store);

    const mockFetch: typeof fetch = () =>
      sseResponse(
        [
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        ],
        90,
      );

    const res = await probeAccount(pool, pool.get('very-slow')!, {
      fetchImpl: mockFetch,
      suspectedMs: 30,
      pauseMs: 60,
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe('paused');
    expect(res.rateLimited).toBe(true);
    expect(res.paused).toBe(true);

    const updated = pool.get('very-slow')!;
    expect(updated.record.enabled).toBe(false);
    expect(updated.record.rateLimited).toBe(true);
    expect(pool.available()).toHaveLength(0);
  });

  it('批量测活：返回每个账号的测活结果并应用对应状态', async () => {
    const store = new AccountStore();
    seedAccount(store, 'ok-acc');
    seedAccount(store, 'slow-acc');
    const pool = new AccountPool(store);

    const mockFetch: typeof fetch = (_input, init) => {
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      if (auth.includes('slow-acc')) {
        return sseResponse(
          [
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"1"}}\n\n',
          ],
          60,
        );
      }
      return sseResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"1"}}\n\n',
      ]);
    };

    const results = await probeAllAccounts(pool, {
      fetchImpl: mockFetch,
      suspectedMs: 30,
      pauseMs: 300,
    });

    expect(results).toHaveLength(2);
    const okItem = results.find((r) => r.account === 'ok-acc')!;
    const slowItem = results.find((r) => r.account === 'slow-acc')!;
    expect(okItem.status).toBe('ok');
    expect(slowItem.status).toBe('suspected');
    expect(pool.available().map((a) => a.record.name)).toEqual(['ok-acc']);
  });

  it('测活请求会写进请求列表，来源标为 probe', async () => {
    const store = new AccountStore();
    seedAccount(store, 'fast');
    const pool = new AccountPool(store);
    const requests = new RequestStore();

    const mockFetch: typeof fetch = () =>
      sseResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      ]);

    const res = await probeAccount(pool, pool.get('fast')!, {
      fetchImpl: mockFetch,
      suspectedMs: 200,
      pauseMs: 400,
      requests,
    });
    expect(res.ok).toBe(true);

    const list = requests.list();
    expect(list.total).toBe(1);
    const item = list.items[0]!;
    expect(item.source).toBe('probe');
    expect(item.account).toBe('fast');
    expect(item.status).toBe(200);
    expect(item.stream).toBe(true);
    expect(item.firstByteMs).not.toBeNull();
    expect(item.transit?.upstream).toBeTruthy();
  });

  it('测活遇到上游 429 也会留痕', async () => {
    const store = new AccountStore();
    seedAccount(store, 'limited');
    const pool = new AccountPool(store);
    const requests = new RequestStore();

    const mockFetch: typeof fetch = async () => new Response('rate limited', { status: 429 });

    const res = await probeAccount(pool, pool.get('limited')!, {
      fetchImpl: mockFetch,
      suspectedMs: 200,
      pauseMs: 400,
      requests,
    });
    expect(res.status).toBe('suspected');

    const item = requests.list().items[0]!;
    expect(item.source).toBe('probe');
    expect(item.status).toBe(429);
    expect(item.error).toContain('429');
  });
});
