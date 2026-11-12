/**
 * session 识别与清理测试（纯 Anthropic 协议版）。
 *
 * 守三件事：
 *   ① **显式 id 优先**：支持请求头、顶层字段、`metadata.session_id`、Claude Code `metadata.user_id`（`__session_<id>`）；
 *   ② **推导稳定**：同一个新会话先调 `/v1/messages/count_tokens` 再调 `/v1/messages`，必须推出同一个 session key；
 *   ③ **安全清理**：`stripSessionFields` 仅清理非 Anthropic 标准的会话字段，完整保留 `system`、`cache_control`、`thinking`、`metadata`。
 */

import { describe, expect, it } from 'vitest';
import {
  findExplicitSessionId,
  firstUserText,
  resolveSessionKey,
  stripSessionFields,
} from './session.js';

const BODY = {
  model: 'MiniMax-M3',
  messages: [{ role: 'user' as const, content: '你好，帮我看下这段代码' }],
};

describe('显式 session id', () => {
  it('从请求头里认 x-session-id / x-session / x-conversation-id / x-chat-id', () => {
    expect(findExplicitSessionId({ 'x-session-id': 'abc' }, null)).toBe('abc');
    expect(findExplicitSessionId({ 'x-session': 'def' }, null)).toBe('def');
    expect(findExplicitSessionId({ 'x-conversation-id': 'ghi' }, null)).toBe('ghi');
    expect(findExplicitSessionId({ 'x-chat-id': 'jkl' }, null)).toBe('jkl');
  });

  it('从 body 顶层认 session_id / sessionId / conversation_id / chat_id', () => {
    expect(findExplicitSessionId({}, { session_id: 's1' })).toBe('s1');
    expect(findExplicitSessionId({}, { sessionId: 's2' })).toBe('s2');
    expect(findExplicitSessionId({}, { conversation_id: 'c1' })).toBe('c1');
    expect(findExplicitSessionId({}, { chat_id: 'ch1' })).toBe('ch1');
  });

  it('从 Anthropic metadata.session_id 与 Claude Code metadata.user_id 提取会话 id', () => {
    expect(
      findExplicitSessionId({}, { metadata: { session_id: 'meta-sess-1' } }),
    ).toBe('meta-sess-1');

    expect(
      findExplicitSessionId(
        {},
        { metadata: { user_id: 'user_abc_account_xyz__session_cc-1234-abcd' } },
      ),
    ).toBe('cc-1234-abcd');
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
  it('count_tokens 与 messages 即使参数不同，只要入站密钥/模型/首条用户消息相同就推出同一个 key', () => {
    const countTokensBody = {
      model: 'MiniMax-M3',
      system: '你是代码助手',
      messages: [{ role: 'user' as const, content: [{ type: 'text', text: '你好，帮我看下这段代码' }] }],
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
    };
    const messagesBody = {
      model: 'MiniMax-M3',
      max_tokens: 4096,
      stream: true,
      system: '你是代码助手',
      messages: [
        { role: 'user' as const, content: '你好，帮我看下这段代码' },
        { role: 'assistant' as const, content: '好的，请发给我' },
        { role: 'user' as const, content: '第二轮补充' },
      ],
    };

    const a = resolveSessionKey({ keyId: 'k1' }, countTokensBody);
    const b = resolveSessionKey({ keyId: 'k1' }, messagesBody);
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

  it('firstUserText 兼容字符串、content blocks 与非文本块', () => {
    const messages = [
      { role: 'system' as const, content: '系统提示' },
      { role: 'user' as const, content: [{ type: 'text', text: '第一句' }] },
      { role: 'assistant' as const, content: '回复' },
      { role: 'user' as const, content: '第二句' },
    ];
    expect(firstUserText(messages)).toBe('第一句');

    const imageOnly = [
      { role: 'user' as const, content: [{ type: 'image', source: { type: 'base64', data: 'abc' } }] },
    ];
    expect(firstUserText(imageOnly)).toContain('image');
  });
});

describe('stripSessionFields 清理非标准会话字段', () => {
  it('移除顶层非标准会话字段，完整保留 Anthropic 原生字段', () => {
    const raw = {
      model: 'MiniMax-M3',
      max_tokens: 1024,
      session_id: 's1',
      sessionId: 's2',
      conversation_id: 'c1',
      chat_id: 'ch1',
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'enabled', budget_tokens: 2048 },
      metadata: { user_id: 'u1__session_abc' },
      messages: [{ role: 'user', content: 'hi' }],
    };

    const cleaned = stripSessionFields(raw);
    expect(cleaned).not.toHaveProperty('session_id');
    expect(cleaned).not.toHaveProperty('sessionId');
    expect(cleaned).not.toHaveProperty('conversation_id');
    expect(cleaned).not.toHaveProperty('chat_id');
    expect(cleaned.system).toEqual(raw.system);
    expect(cleaned.thinking).toEqual(raw.thinking);
    expect(cleaned.metadata).toEqual(raw.metadata);
  });
});
