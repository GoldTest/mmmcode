/**
 * session 识别测试。
 *
 * 守三件事：
 *   ① **显式 id 优先**：客户端带了 session id 就用它（头或 body 都认）；
 *   ② **推导稳定**：同样的「密钥+模型+首条用户消息」必须推出同一个 key；
 *   ③ **上下文能穿过 core 的归一** —— 这是最容易出错的地方：
 *      core 的 Anthropic 入站归一会**丢弃未识别的顶层字段**，
 *      所以 Anthropic 路线只能靠 system 里的哨兵把上下文带过去。
 */

import { describe, expect, it } from 'vitest';
import { anthropicToOpenAiBody } from 'waygate-core';
import {
  CTX_FIELD,
  decodeSentinel,
  encodeSentinel,
  extractRequestContext,
  findExplicitSessionId,
  firstUserText,
  resolveSessionKey,
  SENTINEL_PREFIX,
} from './session.js';

const BODY = {
  model: 'MiniMax-M3',
  messages: [{ role: 'user' as const, content: '你好，帮我看下这段代码' }],
};

describe('显式 session id', () => {
  it('从请求头里认 x-session-id / x-session / x-conversation-id', () => {
    expect(findExplicitSessionId({ 'x-session-id': 'abc' }, null)).toBe('abc');
    expect(findExplicitSessionId({ 'x-session': 'def' }, null)).toBe('def');
    expect(findExplicitSessionId({ 'x-conversation-id': 'ghi' }, null)).toBe('ghi');
  });

  it('从 body 里认 session_id / conversation_id', () => {
    expect(findExplicitSessionId({}, { session_id: 's1' })).toBe('s1');
    expect(findExplicitSessionId({}, { conversation_id: 'c1' })).toBe('c1');
  });

  it('显式 id 优先于推导', () => {
    const key = resolveSessionKey({ sessionId: 'explicit-1', keyId: 'k1' }, BODY);
    expect(key).toBe('s:explicit-1');
  });

  it('显式 id 长度被截断（防止超长 id 撑爆内存）', () => {
    const long = 'x'.repeat(500);
    const key = resolveSessionKey({ sessionId: long }, BODY);
    expect(key.length).toBeLessThanOrEqual(130);
  });
});

describe('推导 session key', () => {
  it('同样的输入推出同一个 key（多轮对话首条用户消息恒定）', () => {
    const a = resolveSessionKey({ keyId: 'k1' }, BODY);
    const b = resolveSessionKey({ keyId: 'k1' }, BODY);
    expect(a).toBe(b);
    expect(a.startsWith('d:')).toBe(true);
  });

  it('不同入站密钥 → 不同 key（不同客户端不串号）', () => {
    const a = resolveSessionKey({ keyId: 'k1' }, BODY);
    const b = resolveSessionKey({ keyId: 'k2' }, BODY);
    expect(a).not.toBe(b);
  });

  it('首条用户消息变了 → key 变（换了话题就是新会话）', () => {
    const other = { model: 'MiniMax-M3', messages: [{ role: 'user' as const, content: '换个话题' }] };
    expect(resolveSessionKey({ keyId: 'k1' }, BODY)).not.toBe(resolveSessionKey({ keyId: 'k1' }, other));
  });

  it('firstUserText 取第一条 user 消息（跳过 system）', () => {
    const messages = [
      { role: 'system' as const, content: '系统提示' },
      { role: 'user' as const, content: '第一句' },
      { role: 'assistant' as const, content: '回复' },
      { role: 'user' as const, content: '第二句' },
    ];
    expect(firstUserText(messages)).toBe('第一句');
  });
});

describe('上下文穿过 core 的归一', () => {
  it('★ OpenAI 路线：顶层字段被 core 保留 → 能取回上下文', () => {
    /* core 的 OpenAI 路径：body = { ...raw, model, messages } —— 未知字段保留。 */
    const raw = { ...BODY, [CTX_FIELD]: { sessionId: 'sess-9', keyId: 'k1', reqId: 'r1' } };
    const normalized = { ...raw, model: raw.model, messages: raw.messages };
    const { ctx, body } = extractRequestContext(normalized);
    expect(ctx.sessionId).toBe('sess-9');
    expect(ctx.keyId).toBe('k1');
    expect(ctx.reqId).toBe('r1');
    /* 运输痕迹被擦掉 —— 不会发到上游。 */
    expect((body as Record<string, unknown>)[CTX_FIELD]).toBeUndefined();
  });

  it('★ Anthropic 路线：system 哨兵能穿过 core 的归一被取回', () => {
    const sentinel = encodeSentinel({ sessionId: 'sess-anthropic', keyId: 'k2', reqId: 'r2' });
    const raw = {
      model: 'MiniMax-M3',
      system: `${sentinel}\n\n你是助手`,
      messages: [{ role: 'user', content: '你好' }],
    };

    /* core 的 Anthropic 归一：只认 system/messages/tools…，未知顶层字段会被丢弃。 */
    const normalized = anthropicToOpenAiBody(raw as never) as never;
    const { ctx, body } = extractRequestContext(normalized);

    expect(ctx.sessionId).toBe('sess-anthropic');
    expect(ctx.keyId).toBe('k2');
    expect(ctx.reqId).toBe('r2');
    /* 哨兵被摘掉，用户提示词原样留下。 */
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const system = messages.find((m) => m.role === 'system');
    expect(system?.content).toBe('你是助手');
    expect(String(system?.content)).not.toContain(SENTINEL_PREFIX);
  });

  it('哨兵单独占 system 时整条摘掉，不留空消息', () => {
    const sentinel = encodeSentinel({ sessionId: 'only' });
    const raw = { model: 'M', system: sentinel, messages: [{ role: 'user', content: 'hi' }] };
    const normalized = anthropicToOpenAiBody(raw as never) as never;
    const { ctx, body } = extractRequestContext(normalized);
    expect(ctx.sessionId).toBe('only');
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages.some((m) => String(m.content).includes(SENTINEL_PREFIX))).toBe(false);
  });

  it('哨兵可逆（base64url 不含 ]，不会与内容里的 ]] 撞车）', () => {
    const ctx = { sessionId: 'a]b]]c', keyId: 'k' };
    const sentinel = encodeSentinel(ctx);
    const decoded = decodeSentinel(`前面${sentinel}后面`);
    expect(decoded).not.toBeNull();
    expect(decoded?.ctx.sessionId).toBe('a]b]]c');
    expect(decoded?.rest).toBe('前面后面');
  });

  it('没有上下文时原样返回（不报错）', () => {
    const { ctx, body } = extractRequestContext({ ...BODY });
    expect(ctx).toEqual({});
    expect(body.messages).toHaveLength(1);
  });
});
