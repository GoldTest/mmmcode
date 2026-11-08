/**
 * 反代链路端到端测试 —— 验「上下文注入 → core 归一 → 适配器选号」整条链。
 *
 * 这是本次改造里**最容易静默出错**的一段：
 *   客户端请求 → 反代层（提取 session id、注入上下文）→ 内部 core（协议归一）
 *   → 适配器（按 session 选号）。
 *
 * 中间隔着 core 的 Anthropic 入站归一 —— 它会**丢弃未识别的顶层字段**，
 * 所以上下文能不能活着穿过它，必须用真链路验，不能靠单测各测各的。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore, accountDir } from './accounts.js';
import { AccountPool } from './pool.js';
import { KeyRegistry } from './keys.js';
import { createMmcodeAdapter } from './adapter.js';
import { startProxyServer } from './proxy.js';
import { InsightsLedger } from './insights.js';
import { RequestStore } from './requests.js';

let root = '';
const origHome = process.env.MMCODE_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mmcode-e2e-'));
  process.env.MMCODE_HOME = root;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.MMCODE_HOME;
  else process.env.MMCODE_HOME = origHome;
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** 造一个已登录的账号。 */
function seed(name: string): void {
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

/** 一段合法的 Anthropic SSE 响应体（带权威 usage，含缓存命中）。 */
function sseResponse(): Response {
  const body =
    'event: message_start\n' +
    'data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"MiniMax-M3","content":[],"stop_reason":null,"usage":{"input_tokens":120,"output_tokens":0,"cache_read_input_tokens":40}}}\n\n' +
    'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n' +
    'event: message_delta\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":30}}\n\n' +
    'event: message_stop\n' +
    'data: {"type":"message_stop"}\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * 只打桩**上游**调用（agent.minimax.cn），其余（测试自己打反代的那一跳）走真 fetch。
 *
 * 直接全局替换 fetch 会把「测试 → 反代」这一跳也拦掉 —— 请求根本到不了服务。
 */
function stubUpstream(inspect?: (body: string) => void): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('minimax')) {
        if (inspect) inspect(String(init?.body ?? ''));
        return sseResponse();
      }
      return realFetch(url as never, init);
    }),
  );
}

interface Harness {
  port: number;
  key: string;
  pool: AccountPool;
  insights: InsightsLedger;
  requests: RequestStore;
  close(): Promise<void>;
}

/** 起一个反代服务（真实 HTTP 链路），上游 fetch 被打桩。 */
async function startHarness(names: string[], mode: 'max-cache' | 'balanced' = 'max-cache'): Promise<Harness> {
  const store = new AccountStore();
  for (const n of names) {
    seed(n);
    store.upsert(n, 'cn');
  }
  store.setMode(mode);
  const pool = new AccountPool(store, { log: () => {} });
  const insights = new InsightsLedger();
  const requests = new RequestStore(join(root, 'requests-config.json'));
  const adapter = createMmcodeAdapter({ pool, log: () => {}, insights });
  const keys = new KeyRegistry();
  const key = keys.create('测试密钥').key;

  const handle = await startProxyServer({
    host: '127.0.0.1',
    port: 0,
    adapter,
    keys,
    pool,
    requests,
    log: () => {},
  });
  return { port: handle.port, key, pool, insights, requests, close: () => handle.close() };
}

/** 发一条聊天请求，返回状态码与文本。 */
async function chat(
  h: Harness,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${h.port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${h.key}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

const BODY = { model: 'MiniMax-M3', messages: [{ role: 'user', content: '帮我写个函数' }] };

describe('反代端到端：session 上下文', () => {
  it('★ OpenAI 路线：同一 x-session-id 的两次请求落在同一账号', async () => {
    const h = await startHarness(['a1', 'a2']);
    stubUpstream();

    await chat(h, BODY, { 'x-session-id': 'sess-A' });
    const first = h.pool.getLastUsedAccount();
    await chat(h, BODY, { 'x-session-id': 'sess-A' });
    const second = h.pool.getLastUsedAccount();

    expect(first).toBeTruthy();
    expect(second).toBe(first);
    await h.close();
  });

  it('★ OpenAI 路线：不同 session id 可以落在不同账号', async () => {
    const h = await startHarness(['a1', 'a2']);
    stubUpstream();

    const used = new Set<string>();
    for (let i = 0; i < 30; i += 1) {
      await chat(h, BODY, { 'x-session-id': `sess-${i}` });
      used.add(h.pool.getLastUsedAccount() ?? '');
    }
    expect(used.size).toBeGreaterThan(1);
    await h.close();
  });

  it('★ Anthropic 路线：上下文穿过 core 归一，session 仍然粘住', async () => {
    const h = await startHarness(['a1', 'a2']);
    stubUpstream();

    const anthropicBody = {
      model: 'MiniMax-M3',
      system: '你是一个助手',
      messages: [{ role: 'user', content: '帮我写个函数' }],
      max_tokens: 1024,
    };

    const first = await fetch(`http://127.0.0.1:${h.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': h.key, 'x-session-id': 'sess-AN' },
      body: JSON.stringify(anthropicBody),
    });
    expect(first.status).toBe(200);
    await first.text();
    const account1 = h.pool.getLastUsedAccount();

    const second = await fetch(`http://127.0.0.1:${h.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': h.key, 'x-session-id': 'sess-AN' },
      body: JSON.stringify(anthropicBody),
    });
    expect(second.status).toBe(200);
    await second.text();
    const account2 = h.pool.getLastUsedAccount();

    expect(account1).toBeTruthy();
    expect(account2).toBe(account1);
    await h.close();
  });

  it('★ 请求体里的 session_id 也能被认出来', async () => {
    const h = await startHarness(['a1', 'a2']);
    stubUpstream();

    await chat(h, { ...BODY, session_id: 'body-sess' });
    const first = h.pool.getLastUsedAccount();
    await chat(h, { ...BODY, session_id: 'body-sess' });
    expect(h.pool.getLastUsedAccount()).toBe(first);
    await h.close();
  });

  it('★ 哨兵不会漏到上游（system 里没有内部标记）', async () => {
    const h = await startHarness(['a1']);
    let upstreamBody = '';
    stubUpstream((body) => {
      upstreamBody = body;
    });

    await fetch(`http://127.0.0.1:${h.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': h.key, 'x-session-id': 'sess-X' },
      body: JSON.stringify({ model: 'MiniMax-M3', system: '你是一个助手', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(upstreamBody).not.toContain('mmcode-ctx');
    expect(upstreamBody).not.toContain('mmcode_ctx');
    /* 用户提示词原样保留。 */
    expect(upstreamBody).toContain('你是一个助手');
    await h.close();
  });
});

describe('反代端到端：用量记账', () => {
  it('★ token 用量记到了服务该请求的账号名下', async () => {
    const h = await startHarness(['a1', 'a2']);
    stubUpstream();

    await chat(h, BODY, { 'x-session-id': 'sess-U' });
    /* 等流结束（usage 在流末尾采集）。 */
    await new Promise((r) => setTimeout(r, 50));

    const snapshot = h.insights.snapshot();
    expect(snapshot.length).toBe(1);
    const used = snapshot[0]!;
    /* prompt = input(120) + cache_read(40) = 160；输出 30。 */
    expect(used.requests).toBe(1);
    expect(used.promptTokens).toBe(160);
    expect(used.completionTokens).toBe(30);
    expect(used.cachedTokens).toBe(40);
    expect(used.totalTokens).toBe(190);
    expect(used.name).toBe(h.pool.getLastUsedAccount());
    await h.close();
  });

  it('★ 缓存命中率：台账与请求日志都带上', async () => {
    const h = await startHarness(['a1']);
    stubUpstream();

    await chat(h, BODY, { 'x-session-id': 'sess-C' });
    await new Promise((r) => setTimeout(r, 50));

    /* 命中率 = 缓存命中(40) / 输入(160) = 25%。 */
    const snapshot = h.insights.snapshot();
    expect(snapshot[0]!.cacheHitRate).toBeCloseTo(0.25, 5);
    expect(h.insights.totals().cacheHitRate).toBeCloseTo(0.25, 5);

    /* 请求日志里也要有（请求详情弹窗显示它）。 */
    const logged = h.requests.list().items[0];
    expect(logged?.output?.usage?.cached_tokens).toBe(40);
    expect(logged?.output?.usage?.cache_hit_rate).toBeCloseTo(0.25, 5);
    await h.close();
  });

  it('★ 请求日志带首字符时间与中转信息', async () => {
    const h = await startHarness(['a1']);
    stubUpstream();

    await chat(h, BODY, { 'x-session-id': 'sess-T' });
    await new Promise((r) => setTimeout(r, 50));

    const logged = h.requests.list().items[0];
    /* 首字符时间：收到请求 → 第一个响应字节。 */
    expect(typeof logged?.firstByteMs).toBe('number');
    expect(logged!.firstByteMs!).toBeGreaterThanOrEqual(0);
    expect(logged!.firstByteMs!).toBeLessThanOrEqual(logged!.durationMs);

    /* 中转：上游地址 / 账号 / 协议 / 转译后实际发给上游的请求体。 */
    expect(logged?.transit?.upstream).toContain('agent.minimax.cn');
    expect(logged?.transit?.account).toBe('a1');
    expect(logged?.transit?.protocol).toBe('anthropic');
    const payload = logged?.transit?.payload as { messages?: unknown[]; model?: string };
    expect(Array.isArray(payload?.messages)).toBe(true);
    expect(payload?.model).toBe('MiniMax-M3');
    await h.close();
  });

  it('★ Anthropic 路线：请求日志也带缓存命中率（core 重编码会丢缓存字段）', async () => {
    const h = await startHarness(['a1']);
    stubUpstream();

    const res = await fetch(`http://127.0.0.1:${h.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': h.key },
      body: JSON.stringify({ model: 'MiniMax-M3', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    await res.text();
    await new Promise((r) => setTimeout(r, 50));

    const logged = h.requests.list().items[0];
    expect(logged?.output?.usage?.cached_tokens).toBe(40);
    expect(logged?.output?.usage?.cache_hit_rate).toBeCloseTo(0.25, 5);
    await h.close();
  });
});
