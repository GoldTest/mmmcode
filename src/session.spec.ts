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
  it('从请求头里认 x-mavis-session-id / mavis-session-id / x-session-id / x-session / session-id / sessionid / x-conversation-id / x-chat-id', () => {
    expect(findExplicitSessionId({ 'x-mavis-session-id': 'mvs_1322562df5b8486995046c23890295af' }, null)).toBe(
      'mvs_1322562df5b8486995046c23890295af',
    );
    expect(findExplicitSessionId({ 'mavis-session-id': 'mvs_custom' }, null)).toBe('mvs_custom');
    expect(findExplicitSessionId({ 'x-session-id': 'abc' }, null)).toBe('abc');
    expect(findExplicitSessionId({ 'x-session': 'def' }, null)).toBe('def');
    expect(findExplicitSessionId({ 'session-id': 's_id' }, null)).toBe('s_id');
    expect(findExplicitSessionId({ sessionid: 'sid_hdr' }, null)).toBe('sid_hdr');
    expect(findExplicitSessionId({ 'x-conversation-id': 'ghi' }, null)).toBe('ghi');
    expect(findExplicitSessionId({ 'x-chat-id': 'jkl' }, null)).toBe('jkl');
    /* 大小写不敏感兜底 */
    expect(findExplicitSessionId({ 'X-Mavis-Session-Id': 'mvs_upper' }, null)).toBe('mvs_upper');
  });

  it('从 body 顶层认 session_id / sessionId / sessionid / conversation_id / chat_id / mavis_session_id', () => {
    expect(findExplicitSessionId({}, { session_id: 's1' })).toBe('s1');
    expect(findExplicitSessionId({}, { sessionId: 's2' })).toBe('s2');
    expect(findExplicitSessionId({}, { sessionid: 's3' })).toBe('s3');
    expect(findExplicitSessionId({}, { mavis_session_id: 'mvs_body' })).toBe('mvs_body');
    expect(findExplicitSessionId({}, { conversation_id: 'c1' })).toBe('c1');
    expect(findExplicitSessionId({}, { chat_id: 'ch1' })).toBe('ch1');
  });

  it('从 Anthropic metadata.session_id、metadata.sessionid 与 Claude Code metadata.user_id 提取会话 id', () => {
    expect(
      findExplicitSessionId({}, { metadata: { session_id: 'meta-sess-1' } }),
    ).toBe('meta-sess-1');
    expect(
      findExplicitSessionId({}, { metadata: { sessionid: 'meta-sess-2' } }),
    ).toBe('meta-sess-2');
    expect(
      findExplicitSessionId({}, { metadata: { sessionId: 'meta-sess-3' } }),
    ).toBe('meta-sess-3');

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

  it('★ agentic 多轮对话中 tool_result 不影响 session key 稳定性', () => {
    /* 第 1 轮：用户发问 */
    const round1 = {
      model: 'MiniMax-M3',
      messages: [
        { role: 'user' as const, content: '帮我看看 src/pool.ts' },
      ],
    };
    /* 第 2 轮：assistant 调用工具后，tool_result 排在 messages 最前面（模拟截断） */
    const round2 = {
      model: 'MiniMax-M3',
      messages: [
        { role: 'user' as const, content: '帮我看看 src/pool.ts' },
        { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'src/pool.ts' } }] },
        { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '// 文件内容...' }] },
      ],
    };
    /* 第 3 轮：又一轮工具调用 */
    const round3 = {
      model: 'MiniMax-M3',
      messages: [
        { role: 'user' as const, content: '帮我看看 src/pool.ts' },
        { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'src/pool.ts' } }] },
        { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '// 文件内容...' }] },
        { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'tu2', name: 'edit_file', input: { path: 'src/pool.ts' } }] },
        { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'tu2', content: '编辑成功' }] },
      ],
    };

    const key1 = resolveSessionKey({ keyId: 'k1' }, round1);
    const key2 = resolveSessionKey({ keyId: 'k1' }, round2);
    const key3 = resolveSessionKey({ keyId: 'k1' }, round3);
    expect(key1).toBe(key2);
    expect(key1).toBe(key3);
  });

  it('★ 消息历史被截断后，首条变成 tool_result 时仍然稳定', () => {
    /* 截断场景：客户端只保留最近几轮，第一条 user 消息变成了 tool_result */
    const truncated = {
      model: 'MiniMax-M3',
      messages: [
        { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'tu5', content: '某个工具结果' }] },
        { role: 'assistant' as const, content: '我来分析一下...' },
        { role: 'user' as const, content: '帮我看看 src/pool.ts' },
      ],
    };
    /* 即使截断了，只要后面还有人类 user 消息，key 就稳定。 */
    const original = {
      model: 'MiniMax-M3',
      messages: [
        { role: 'user' as const, content: '帮我看看 src/pool.ts' },
      ],
    };
    expect(resolveSessionKey({ keyId: 'k1' }, truncated)).toBe(resolveSessionKey({ keyId: 'k1' }, original));
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

  it('跳过纯 tool_result 的 user 消息，找到真正的人类输入', () => {
    const messages = [
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '文件内容...' }] },
      { role: 'assistant' as const, content: '好的' },
      { role: 'user' as const, content: '这是我的问题' },
    ];
    expect(firstUserText(messages)).toBe('这是我的问题');
  });

  it('混合 tool_result 与 text block 的 user 消息不被跳过', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: '结果' },
          { type: 'text', text: '请继续' },
        ],
      },
    ];
    expect(firstUserText(messages)).toBe('请继续');
  });

  it('全部 user 消息都是 tool_result 时返回空字符串', () => {
    const messages = [
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '结果' }] },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'tu2', content: '结果2' }] },
    ];
    expect(firstUserText(messages)).toBe('');
  });

  it('超长文本被截断到 200 字符（防哈希漂移）', () => {
    const longText = 'x'.repeat(500);
    const messages = [{ role: 'user' as const, content: longText }];
    expect(firstUserText(messages)).toBe('x'.repeat(200));
  });
});

describe('stripSessionFields 清理非标准会话字段', () => {
  it('移除顶层非标准会话字段，完整保留 Anthropic 原生字段', () => {
    const raw = {
      model: 'MiniMax-M3',
      max_tokens: 1024,
      session_id: 's1',
      sessionId: 's2',
      sessionid: 's3',
      mavis_session_id: 'mvs_1',
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
    expect(cleaned).not.toHaveProperty('sessionid');
    expect(cleaned).not.toHaveProperty('mavis_session_id');
    expect(cleaned).not.toHaveProperty('conversation_id');
    expect(cleaned).not.toHaveProperty('chat_id');
    expect(cleaned.system).toEqual(raw.system);
    expect(cleaned.thinking).toEqual(raw.thinking);
    expect(cleaned.metadata).toEqual(raw.metadata);
  });
});
