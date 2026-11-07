/**
 * 适配器的**自动换号**测试（反代最关键的健壮性）。
 *
 * 背景：MiniMax 同一账号只能有一个有效会话 —— 上游 401 通常意味着
 * 「这个号在别处登过」，光重试没用，**必须换号**。
 *
 * 守四件事：
 *   ① 401 → 自动换下一个号并把坏号标记掉；
 *   ② 429 → 同样换号；
 *   ③ **5xx 不换号**（上游整体故障，换号只会把所有号都标记成坏）；
 *   ④ 全部账号都失败 → 报错说人话。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore, accountDir } from './accounts.js';
import { AccountPool } from './pool.js';
import { createMmcodeAdapter } from './adapter.js';

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
    'data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"MiniMax-M3","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
    'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n' +
    'event: message_stop\n' +
    'data: {"type":"message_stop"}\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** 造一个带 N 个已登录账号的适配器。 */
function makeAdapter(names: string[]) {
  const store = new AccountStore();
  for (const n of names) {
    seed(n);
    store.upsert(n, 'cn');
  }
  store.setActive(names[0] ?? '');
  const pool = new AccountPool(store);
  const adapter = createMmcodeAdapter({ pool, log: () => {} });
  return { store, pool, adapter };
}

const BODY = { model: 'MiniMax-M3', messages: [{ role: 'user' as const, content: 'hi' }] };

describe('自动换号', () => {
  it('★ 第一个号 401 → 自动换第二个号并成功返回', async () => {
    const { store, adapter } = makeAdapter(['a1', 'a2']);
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return calls === 1 ? new Response('unauthorized', { status: 401 }) : sseResponse();
      }),
    );

    const result = await adapter.chat(BODY, new AbortController().signal);
    expect(result.status).toBe(200);
    expect(calls).toBe(2);

    /* 坏号被标记为 unauthorized 并进入冷却 —— 不会被反复撞。 */
    const a1 = store.get('a1')!;
    expect(a1.health).toBe('unauthorized');
    expect(a1.disabledUntil).toBeGreaterThan(Date.now());
  });

  it('429 → 换号', async () => {
    const { store, adapter } = makeAdapter(['a1', 'a2']);
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return calls === 1 ? new Response('slow down', { status: 429 }) : sseResponse();
      }),
    );
    const result = await adapter.chat(BODY, new AbortController().signal);
    expect(result.status).toBe(200);
    expect(store.get('a1')!.health).toBe('rate_limited');
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
    await expect(adapter.chat(BODY, new AbortController().signal)).rejects.toThrow(/500/);
    expect(calls).toBe(1);
    /* 账号没被惩罚 —— 500 不是账号的错。 */
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
    const result = await adapter.chat(BODY, new AbortController().signal);
    expect(result.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('全部账号都 401 → 报错（而不是静默返回一个坏流）', async () => {
    const { adapter } = makeAdapter(['a1', 'a2']);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await expect(adapter.chat(BODY, new AbortController().signal)).rejects.toThrow(/401|鉴权/);
  });

  it('没有可用账号 → 报错说人话', async () => {
    const store = new AccountStore();
    const pool = new AccountPool(store);
    const adapter = createMmcodeAdapter({ pool, log: () => {} });
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse()));
    await expect(adapter.chat(BODY, new AbortController().signal)).rejects.toThrow(/没有可用账号|未登录/);
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
    await expect(adapter.chat(BODY, ac.signal)).rejects.toThrow();
    expect(store.get('a1')!.health).not.toBe('error');
  });
});
