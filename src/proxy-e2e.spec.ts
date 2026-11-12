/**
 * 反代链路端到端测试（纯 Anthropic 协议版）。
 *
 * 重点守五件事：
 *   ① 原生 Anthropic `/v1/messages`（及 `/messages`）流式与非流式透传，保留 `system` blocks、`cache_control`、`thinking`、`tools`；
 *   ② 原生 `/v1/messages/count_tokens`（及 `/messages/count_tokens`）透传与请求记录；
 *   ③ 同一 session 先调 `count_tokens` 再调 `/v1/messages` 一对一绑定同一个账号（含显式 `x-session-id` / `metadata` 与无显式 id 的推导绑定），
 *      并遵守 `max-cache` 锁定与 `balanced` 换号规则；
 *   ④ OpenAI `/v1/chat/completions` 与 `/chat/completions` 彻底下线，返回 404 Anthropic `not_found_error`；
 *   ⑤ 用量记账与缓存命中率准确，且 `count_tokens` 不虚增 `InsightsLedger` 与 `output.usage`。
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

/** 上游请求记录。 */
interface UpstreamCapture {
  url: string;
  accountToken: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * 只打桩**上游**调用（agent.minimax.cn），其余（测试自己打反代的那一跳）走真 fetch。
 */
function stubUpstream(
  customHandler?: (cap: UpstreamCapture, callIndex: number) => Response | Promise<Response>,
): UpstreamCapture[] {
  const realFetch = globalThis.fetch;
  const captures: UpstreamCapture[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('minimax')) {
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        const auth = hdrs['authorization'] ?? hdrs['Authorization'] ?? '';
        const cap: UpstreamCapture = {
          url: href,
          accountToken: auth.replace(/^Bearer\s+/i, ''),
          headers: hdrs,
          body: String(init?.body ?? ''),
        };
        captures.push(cap);
        if (customHandler) {
          return await customHandler(cap, captures.length);
        }
        if (href.endsWith('/count_tokens')) {
          return new Response(JSON.stringify({ input_tokens: 437 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return sseResponse();
      }
      return realFetch(url as never, init);
    }),
  );
  return captures;
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

/** 发一条 Anthropic `/v1/messages`（或自定义路径）请求。 */
async function postAnthropic(
  h: Harness,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${h.port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': h.key,
      'anthropic-version': '2023-06-01',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

const MESSAGES_BODY = {
  model: 'MiniMax-M3',
  max_tokens: 1024,
  stream: true,
  system: '你是一个助手',
  messages: [{ role: 'user', content: '帮我写个函数' }],
};

const COUNT_BODY = {
  model: 'MiniMax-M3',
  system: '你是一个助手',
  messages: [{ role: 'user', content: '帮我写个函数' }],
  tools: [
    {
      name: 'get_weather',
      description: 'Get weather',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  ],
};

describe('反代端到端：纯 Anthropic 协议与下线 OpenAI 协议', () => {
  it('★ OpenAI /v1/chat/completions 与 /chat/completions 均返回 404 Anthropic not_found_error', async () => {
    const h = await startHarness(['a1']);
    stubUpstream();

    for (const path of ['/v1/chat/completions', '/chat/completions']) {
      const res = await fetch(`http://127.0.0.1:${h.port}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${h.key}`,
        },
        body: JSON.stringify({ model: 'MiniMax-M3', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(404);
      const err = (await res.json()) as { type: string; error: { type: string; message: string } };
      expect(err.type).toBe('error');
      expect(err.error.type).toBe('not_found_error');
      expect(err.error.message).toContain('Anthropic');
    }
    await h.close();
  });

  it('入站密钥缺失/错误返回 401 Anthropic 错误；/healthz 无需鉴权；/v1/models 返回模型列表', async () => {
    const h = await startHarness(['a1']);
    stubUpstream();

    const health = await fetch(`http://127.0.0.1:${h.port}/healthz`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

    const unauth = await fetch(`http://127.0.0.1:${h.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-wrong' },
      body: JSON.stringify(MESSAGES_BODY),
    });
    expect(unauth.status).toBe(401);
    const err = (await unauth.json()) as { type: string; error: { type: string } };
    expect(err.type).toBe('error');
    expect(err.error.type).toBe('authentication_error');

    const models = await fetch(`http://127.0.0.1:${h.port}/v1/models`, {
      headers: { 'x-api-key': h.key },
    });
    expect(models.status).toBe(200);
    const modelsJson = (await models.json()) as { data: Array<{ id: string }> };
    expect(modelsJson.data.length).toBeGreaterThan(0);

    await h.close();
  });

  it('★ 原生字段（system blocks / cache_control / thinking / tools）无哨兵污染直通上游', async () => {
    const h = await startHarness(['a1']);
    const captures = stubUpstream();

    const richBody = {
      model: 'MiniMax-M3',
      max_tokens: 2048,
      stream: true,
      system: [{ type: 'text', text: '你是一个助手', cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'enabled', budget_tokens: 1024 },
      tools: COUNT_BODY.tools,
      messages: [{ role: 'user', content: 'hi' }],
    };

    const res = await postAnthropic(h, '/v1/messages', richBody, {
      'x-session-id': 'sess-rich',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    });
    expect(res.status).toBe(200);
    expect(captures).toHaveLength(1);

    const sent = JSON.parse(captures[0]!.body) as typeof richBody;
    expect(captures[0]!.body).not.toContain('mmcode-ctx');
    expect(captures[0]!.body).not.toContain('mmcode_ctx');
    expect(sent.system).toEqual(richBody.system);
    expect(sent.thinking).toEqual(richBody.thinking);
    expect(sent.tools).toEqual(richBody.tools);
    expect(captures[0]!.headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');

    await h.close();
  });
});

describe('反代端到端：count_tokens 透传与 session 一对一绑定', () => {
  it('★ POST /v1/messages/count_tokens 与 /messages/count_tokens 原生透传并清理 session_id', async () => {
    const h = await startHarness(['a1']);
    const captures = stubUpstream();

    const r1 = await postAnthropic(h, '/v1/messages/count_tokens', {
      ...COUNT_BODY,
      session_id: 'ct-strip-me',
    });
    expect(r1.status).toBe(200);
    expect(JSON.parse(r1.text)).toEqual({ input_tokens: 437 });

    const r2 = await postAnthropic(h, '/messages/count_tokens', COUNT_BODY);
    expect(r2.status).toBe(200);
    expect(JSON.parse(r2.text)).toEqual({ input_tokens: 437 });

    expect(captures).toHaveLength(2);
    expect(captures[0]!.url).toContain('/mavis/api/v1/llm/v1/messages/count_tokens');
    const sent0 = JSON.parse(captures[0]!.body) as Record<string, unknown>;
    expect(sent0).not.toHaveProperty('session_id');
    expect(sent0.tools).toEqual(COUNT_BODY.tools);

    await h.close();
  });

  it('★ 核心场景：新会话先 count_tokens 再 /v1/messages（无显式 session id），1:1 命中同一个账号', async () => {
    const h = await startHarness(['a1', 'a2']);
    const captures = stubUpstream();

    /* 连续测 10 个不同首句的会话，确认每次 count_tokens -> messages(turn1) -> messages(turn2) 都是一对一同一账号 */
    const seenAccounts = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const prompt = `新会话首句-${i}`;
      const ct = await postAnthropic(h, '/v1/messages/count_tokens', {
        model: 'MiniMax-M3',
        system: '你是助手',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        tools: COUNT_BODY.tools,
      });
      expect(ct.status).toBe(200);
      const tokenAfterCt = captures[captures.length - 1]!.accountToken;

      const m1 = await postAnthropic(h, '/v1/messages', {
        model: 'MiniMax-M3',
        max_tokens: 1024,
        stream: true,
        system: '你是助手',
        messages: [{ role: 'user', content: prompt }],
      });
      expect(m1.status).toBe(200);
      const tokenAfterM1 = captures[captures.length - 1]!.accountToken;

      const m2 = await postAnthropic(h, '/v1/messages', {
        model: 'MiniMax-M3',
        max_tokens: 1024,
        stream: true,
        system: '你是助手',
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: '你好' },
          { role: 'user', content: '继续下一问' },
        ],
      });
      expect(m2.status).toBe(200);
      const tokenAfterM2 = captures[captures.length - 1]!.accountToken;

      expect(tokenAfterM1).toBe(tokenAfterCt);
      expect(tokenAfterM2).toBe(tokenAfterCt);
      seenAccounts.add(tokenAfterCt);
    }

    /* 多个独立会话会随机分散到不同账号，但每个会话内部严格一对一绑定 */
    expect(seenAccounts.size).toBeGreaterThan(1);
    await h.close();
  });

  it('★ Claude Code metadata.user_id (__session_<id>) 与 metadata.session_id 也能在 count_tokens -> messages 间 1:1 绑定', async () => {
    const h = await startHarness(['a1', 'a2']);
    const captures = stubUpstream();

    await postAnthropic(h, '/v1/messages/count_tokens', {
      ...COUNT_BODY,
      metadata: { user_id: 'user_demo__session_cc-session-42' },
    });
    const token1 = captures[0]!.accountToken;

    await postAnthropic(h, '/messages', {
      ...MESSAGES_BODY,
      messages: [{ role: 'user', content: '哪怕首句文本变了但同一 Claude Code session' }],
      metadata: { user_id: 'user_demo__session_cc-session-42' },
    });
    const token2 = captures[1]!.accountToken;

    await postAnthropic(h, '/v1/messages', {
      ...MESSAGES_BODY,
      metadata: { session_id: 'cc-session-42' },
    });
    const token3 = captures[2]!.accountToken;

    expect(token2).toBe(token1);
    expect(token3).toBe(token1);
    await h.close();
  });

  it('★ max-cache 模式：count_tokens 绑定某账号后，该账号 401 时拒绝迁移并返回 502', async () => {
    const h = await startHarness(['a1', 'a2'], 'max-cache');
    const captures = stubUpstream((cap) => {
      if (cap.url.endsWith('/count_tokens')) {
        return new Response(JSON.stringify({ input_tokens: 100 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('unauthorized', { status: 401 });
    });

    const ct = await postAnthropic(h, '/v1/messages/count_tokens', COUNT_BODY, {
      'x-session-id': 'sess-locked',
    });
    expect(ct.status).toBe(200);
    const boundToken = captures[0]!.accountToken;

    const msg = await postAnthropic(h, '/v1/messages', MESSAGES_BODY, {
      'x-session-id': 'sess-locked',
    });
    expect(msg.status).toBe(502);
    expect(msg.text).toMatch(/最大缓存|重新授权/);
    /* 只打到了原绑定账号，未尝试第二个号 */
    expect(captures).toHaveLength(2);
    expect(captures[1]!.accountToken).toBe(boundToken);
    await h.close();
  });

  it('★ balanced 模式：count_tokens 绑定某账号后，该账号 429 时无缝滑到另一个可用账号并更新绑定', async () => {
    const h = await startHarness(['a1', 'a2'], 'balanced');
    let boundToken = '';
    const captures = stubUpstream((cap) => {
      if (cap.url.endsWith('/count_tokens')) {
        boundToken = cap.accountToken;
        return new Response(JSON.stringify({ input_tokens: 100 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (cap.accountToken === boundToken) {
        return new Response('quota exceeded', { status: 429 });
      }
      return sseResponse();
    });

    const ct = await postAnthropic(h, '/v1/messages/count_tokens', COUNT_BODY, {
      'x-session-id': 'sess-balanced',
    });
    expect(ct.status).toBe(200);

    const msg = await postAnthropic(h, '/v1/messages', MESSAGES_BODY, {
      'x-session-id': 'sess-balanced',
    });
    expect(msg.status).toBe(200);
    expect(captures).toHaveLength(3);
    expect(captures[2]!.accountToken).not.toBe(boundToken);

    /* 后续同一 session 复用新绑定的账号 */
    await postAnthropic(h, '/v1/messages', MESSAGES_BODY, {
      'x-session-id': 'sess-balanced',
    });
    expect(captures[3]!.accountToken).toBe(captures[2]!.accountToken);
    await h.close();
  });
});

describe('反代端到端：用量记账与请求详情', () => {
  it('★ token 用量与缓存命中率记到了服务账号名下，且 count_tokens 不虚增用量', async () => {
    const h = await startHarness(['a1']);
    stubUpstream();

    await postAnthropic(h, '/v1/messages/count_tokens', COUNT_BODY, { 'x-session-id': 'sess-U' });
    await postAnthropic(h, '/v1/messages', MESSAGES_BODY, { 'x-session-id': 'sess-U' });
    await new Promise((r) => setTimeout(r, 50));

    /* InsightsLedger 只记对话请求（1 次），不记 count_tokens */
    const snapshot = h.insights.snapshot();
    expect(snapshot.length).toBe(1);
    const used = snapshot[0]!;
    /* prompt = input(120) + cache_read(40) = 160；输出 30；命中率 = 40/160 = 25% */
    expect(used.requests).toBe(1);
    expect(used.promptTokens).toBe(160);
    expect(used.completionTokens).toBe(30);
    expect(used.cachedTokens).toBe(40);
    expect(used.totalTokens).toBe(190);
    expect(used.cacheHitRate).toBeCloseTo(0.25, 5);
    expect(used.name).toBe('a1');

    /* RequestStore 两条都记录，但 count_tokens 不带 output.usage */
    const items = h.requests.list().items;
    expect(items).toHaveLength(2);
    const msgLog = items.find((i) => i.path === '/v1/messages');
    const ctLog = items.find((i) => i.path === '/v1/messages/count_tokens');

    expect(msgLog?.output?.usage?.cached_tokens).toBe(40);
    expect(msgLog?.output?.usage?.cache_hit_rate).toBeCloseTo(0.25, 5);
    expect(msgLog?.transit?.upstream).toContain('/mavis/api/v1/llm/v1/messages');
    expect(msgLog?.transit?.protocol).toBe('anthropic');
    expect(typeof msgLog?.firstByteMs).toBe('number');
    expect(msgLog!.firstByteMs!).toBeGreaterThanOrEqual(0);
    expect(msgLog!.firstByteMs!).toBeLessThanOrEqual(msgLog!.durationMs);

    expect(ctLog?.status).toBe(200);
    expect(ctLog?.account).toBe('a1');
    expect(ctLog?.transit?.upstream).toContain('/mavis/api/v1/llm/v1/messages/count_tokens');
    expect(ctLog?.output?.usage).toBeUndefined();
    expect(ctLog?.output?.raw).toEqual({ input_tokens: 437 });

    await h.close();
  });
});
