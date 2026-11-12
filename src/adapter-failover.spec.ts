/**
 * 适配器的**自动换号**与 `messages` / `countTokens` 调度测试。
 *
 * 背景：MiniMax 同一账号只能有一个有效会话 —— 上游 401 通常意味着
 * 「这个号在别处登过」，光重试没用，**必须换号**。
 *
 * 守六件事：
 *   ① `messages` 与 `countTokens` 在 401 → 自动换下一个号并把坏号标记掉；
 *   ② 429 → 同样换号，且该号额度被冻结；
 *   ③ **5xx / 400 不换号**（上游整体故障或入参错误，换号只会把好号也标记掉）；
 *   ④ 全部账号都失败 / 没有可用账号 → 报错说人话；
 *   ⑤ 客户端断连 → 立刻抛出，不换号也不惩罚账号；
 *   ⑥ `countTokens` 与后续 `messages` 共用 session 一对一绑定；`max-cache` 模式下 401 不迁移。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore, accountDir } from './accounts.js';
import { AccountPool } from './pool.js';
import { createMmcodeAdapter } from './adapter.js';
import { InsightsLedger } from './insights.js';

let root = '';
const origHome = process.env.MMCODE_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mmcode-failover-'));
  process.env.MMCODE_HOME = root;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.MMCODE_HOME;
  else process.env.MMCODE_HOME = origHome;
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** 造一个已登录的账号（access token 有效期很长 → 不会触发刷新请求）。 */
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

/** 一段合法的 Anthropic SSE 响应体。 */
function sseResponse(): Response {
  const body =
    'event: message_start\n' +
    'data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"MiniMax-M3","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":5}}}\n\n' +
    'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n' +
    'event: message_delta\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n' +
    'event: message_stop\n' +
    'data: {"type":"message_stop"}\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** 一段合法的 count_tokens JSON 响应体。 */
function countTokensResponse(inputTokens = 437): Response {
  return new Response(JSON.stringify({ input_tokens: inputTokens }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** 造一个带 N 个已登录账号的适配器。 */
function makeAdapter(names: string[], mode: 'max-cache' | 'balanced' = 'balanced') {
  const store = new AccountStore();
  for (const n of names) {
    seed(n);
    store.upsert(n, 'cn');
  }
  store.setMode(mode);
  const pool = new AccountPool(store);
  const insights = new InsightsLedger();
  const adapter = createMmcodeAdapter({ pool, insights, log: () => {} });
  return { store, pool, insights, adapter };
}

const BODY = { model: 'MiniMax-M3', stream: true, messages: [{ role: 'user' as const, content: 'hi' }] };
const COUNT_BODY = { model: 'MiniMax-M3', messages: [{ role: 'user' as const, content: 'hi' }] };

describe('adapter.messages 自动换号', () => {
  it('★ 随机选中的号 401 → 自动换另一个号并成功返回', async () => {
    const { store, adapter } = makeAdapter(['a1', 'a2']);
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return calls === 1 ? new Response('unauthorized', { status: 401 }) : sseResponse();
      }),
    );

    const result = await adapter.messages(BODY, new AbortController().signal);
    expect(result.status).toBe(200);
    expect(result.stream).toBeDefined();
    expect(calls).toBe(2);

    const bad = ['a1', 'a2'].filter((n) => store.get(n)!.health === 'unauthorized');
    expect(bad).toHaveLength(1);
    expect(store.get(bad[0]!)!.disabledUntil).toBeGreaterThan(Date.now());
  });

  it('429 → 换号，且该号额度被冻结', async () => {
    const { store, adapter } = makeAdapter(['a1', 'a2']);
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return calls === 1 ? new Response('slow down', { status: 429 }) : sseResponse();
      }),
    );
    const result = await adapter.messages(BODY, new AbortController().signal);
    expect(result.status).toBe(200);
    const limited = ['a1', 'a2'].filter((n) => store.get(n)!.health === 'rate_limited');
    expect(limited).toHaveLength(1);
    expect(store.get(limited[0]!)!.frozen).toBe(true);
  });

  it('★ 5xx 不换号（上游整体故障，换号只会把好号也标记掉）', async () => {
    const { store, adapter } = makeAdapter(['a1', 'a2']);
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return new Response('upstream boom', { status: 500 });
      }),
    );
    await expect(adapter.messages(BODY, new AbortController().signal)).rejects.toThrow(/500/);
    expect(calls).toBe(1);
    expect(store.get('a1')!.health).not.toBe('error');
    expect(store.get('a2')!.health).not.toBe('error');
  });

  it('网络不可达 → 换号重试', async () => {
    const { adapter } = makeAdapter(['a1', 'a2']);
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('ECONNRESET');
        return sseResponse();
      }),
    );
    const result = await adapter.messages(BODY, new AbortController().signal);
    expect(result.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('全部账号都 401 → 报错（而不是静默返回一个坏流）', async () => {
    const { adapter } = makeAdapter(['a1', 'a2']);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await expect(adapter.messages(BODY, new AbortController().signal)).rejects.toThrow(/401|鉴权/);
  });

  it('没有可用账号 → 报错说人话', async () => {
    const store = new AccountStore();
    const pool = new AccountPool(store);
    const adapter = createMmcodeAdapter({ pool, log: () => {} });
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse()));
    await expect(adapter.messages(BODY, new AbortController().signal)).rejects.toThrow(/没有可用账号|未登录/);
  });

  it('客户端断连 → 立刻抛出，不换号也不惩罚账号', async () => {
    const { store, adapter } = makeAdapter(['a1', 'a2']);
    const ac = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        ac.abort();
        throw new Error('The operation was aborted');
      }),
    );
    await expect(adapter.messages(BODY, ac.signal)).rejects.toThrow();
    expect(store.get('a1')!.health).not.toBe('error');
  });

  it('★ 最大缓存模式：账号 401 时不迁移，直接报错说清楚', async () => {
    const { adapter } = makeAdapter(['a1', 'a2'], 'max-cache');
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return new Response('unauthorized', { status: 401 });
      }),
    );

    await expect(adapter.messages(BODY, new AbortController().signal)).rejects.toThrow(/最大缓存|重新授权/);
    expect(calls).toBe(1);
  });

  it('非流式请求但上游返回 SSE 时，聚合成标准 Anthropic Message JSON 并记账', async () => {
    const { adapter, insights } = makeAdapter(['a1']);
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse()));

    const res = await adapter.messages({ ...BODY, stream: false }, new AbortController().signal);
    expect(res.status).toBe(200);
    expect(res.stream).toBeUndefined();
    const parsed = JSON.parse(res.bodyText ?? '{}') as {
      type: string;
      content: Array<{ type: string; text: string }>;
      stop_reason: string;
      usage: { input_tokens: number; cache_read_input_tokens: number; output_tokens: number };
    };
    expect(parsed.type).toBe('message');
    expect(parsed.content[0]?.text).toBe('你好');
    expect(parsed.stop_reason).toBe('end_turn');
    expect(insights.totals().requests).toBe(1);
    expect(insights.totals().cachedTokens).toBe(5);
  });
});

describe('adapter.countTokens 自动换号与 session 一对一绑定', () => {
  it('countTokens 401 / 429 自动换号并遵守 5xx 不换号', async () => {
    const { store, adapter } = makeAdapter(['a1', 'a2']);
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return calls === 1 ? new Response('unauthorized', { status: 401 }) : countTokensResponse(437);
      }),
    );

    const res = await adapter.countTokens(COUNT_BODY, new AbortController().signal, { sessionId: 'ct-1' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.bodyText)).toEqual({ input_tokens: 437 });
    expect(calls).toBe(2);
    expect(['a1', 'a2'].filter((n) => store.get(n)!.health === 'unauthorized')).toHaveLength(1);

    /* 5xx 不换号 */
    let boomCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        boomCalls += 1;
        return new Response('boom', { status: 503 });
      }),
    );
    await expect(
      adapter.countTokens(COUNT_BODY, new AbortController().signal, { sessionId: 'ct-5xx' }),
    ).rejects.toThrow(/503/);
    expect(boomCalls).toBe(1);
  });

  it('★ 先 countTokens 再 messages：同一 session 一对一命中同一账号，且 countTokens 不虚增 insights', async () => {
    const { pool, insights, adapter } = makeAdapter(['a1', 'a2'], 'max-cache');
    const seenAuths: string[] = [];
    const seenUrls: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const href = String(url);
        seenUrls.push(href);
        const h = init?.headers as Record<string, string>;
        seenAuths.push(h.authorization);
        if (href.endsWith('/count_tokens')) return countTokensResponse(256);
        return sseResponse();
      }),
    );

    const ctRes = await adapter.countTokens(
      COUNT_BODY,
      new AbortController().signal,
      { keyId: 'k1' },
    );
    expect(JSON.parse(ctRes.bodyText)).toEqual({ input_tokens: 256 });
    const accountAfterCount = pool.getLastUsedAccount();

    /* count_tokens 不计入 insights */
    expect(insights.totals().requests).toBe(0);

    const msgRes = await adapter.messages(
      { ...BODY, max_tokens: 1024 },
      new AbortController().signal,
      { keyId: 'k1' },
    );
    const reader = msgRes.stream!.getReader();
    while (!(await reader.read()).done) {
      // drain stream
    }
    const accountAfterMsg = pool.getLastUsedAccount();

    expect(accountAfterCount).toBeTruthy();
    expect(accountAfterMsg).toBe(accountAfterCount);
    expect(seenAuths[0]).toBe(seenAuths[1]);
    expect(seenUrls[0]).toContain('/mavis/api/v1/llm/v1/messages/count_tokens');
    expect(seenUrls[1]).toContain('/mavis/api/v1/llm/v1/messages');
    expect(insights.totals().requests).toBe(1);
  });
});
