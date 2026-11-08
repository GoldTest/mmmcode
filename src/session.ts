/**
 * 请求上下文与 session 识别。
 *
 * ## 要解决什么
 * 「同一 session 的对话永远待在同一个账号上」需要能认出「同一个会话」。
 * 客户端（Claude Code / Cursor）**不会**主动发 session id，所以要给两条路：
 *
 *   ① **显式**：客户端带 `x-session-id` 头或 body 里的 `session_id` —— 精确，最优先；
 *   ② **推导**：没有显式 id 时，用「入站密钥 + 模型 + 首条用户消息」哈希当 session key。
 *      主流客户端每轮都会重发完整历史，首条用户消息在会话内恒定 ⇒ 稳定归组。
 *
 * ## 上下文怎么穿过 core
 * core 的 `startServer` 只把**归一后的请求体**交给适配器 —— 中间隔着它的
 * Anthropic 入站归一（`anthropicToOpenAiBody`）。而它**会丢弃未识别的顶层字段**，
 * 于是上下文有两条不同的通道：
 *
 *   · OpenAI 路线（`/v1/chat/completions`）：core 保留未知顶层字段
 *     （`body = { ...raw, model, messages }`）⇒ 直接塞顶层字段 `mmcode_ctx`。
 *   · Anthropic 路线（`/v1/messages`）：未知顶层字段会被丢弃 ⇒ 改走
 *     **system 里的哨兵串**（core 只认 `system` / `messages` / `tools` …）。
 *
 * 哨兵在适配器侧被**摘掉**后才发给上游 —— 它只是本进程内部的运输手段，
 * 绝不会污染用户提示词。两条通道最终收敛成同一个 `RequestContext`。
 */

import { createHash } from 'node:crypto';
import type { ChatMessage, ChatRequestBody } from 'waygate-core';

/** OpenAI 路线：注入请求体的上下文字段名。 */
export const CTX_FIELD = 'mmcode_ctx';

/** Anthropic 路线：system 里承载上下文的哨兵前缀 / 后缀。 */
export const SENTINEL_PREFIX = '[[mmcode-ctx:';
export const SENTINEL_SUFFIX = ']]';

/** 一次请求携带的上下文。 */
export interface RequestContext {
  /** 客户端显式提供的会话 id（`x-session-id` 头或 body.session_id）。 */
  sessionId?: string;
  /** 入站密钥 id —— 用来把不同客户端的同名会话隔离开。 */
  keyId?: string;
  /** 反代请求 id —— 用来把「这次请求实际用了哪个账号」对上账。 */
  reqId?: string;
}

/**
 * 把上下文编码成哨兵串。
 *
 * 用 base64url 而不是裸 JSON：JSON 里可能含 `]]`（用户提示词里就有），
 * 会让哨兵的结束标记产生歧义。base64 的字符集不含 `]` ⇒ 无歧义。
 */
export function encodeSentinel(ctx: RequestContext): string {
  const payload = Buffer.from(JSON.stringify(ctx), 'utf8').toString('base64url');
  return `${SENTINEL_PREFIX}${payload}${SENTINEL_SUFFIX}`;
}

/** 从一段文本里解出哨兵。找不到或解不开返回 null。 */
export function decodeSentinel(text: string): { ctx: RequestContext; rest: string } | null {
  const start = text.indexOf(SENTINEL_PREFIX);
  if (start < 0) return null;
  const end = text.indexOf(SENTINEL_SUFFIX, start);
  if (end < 0) return null;
  const payload = text.slice(start + SENTINEL_PREFIX.length, end);
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as RequestContext;
    if (!parsed || typeof parsed !== 'object') return null;
    const rest = (text.slice(0, start) + text.slice(end + SENTINEL_SUFFIX.length)).trim();
    return { ctx: parsed, rest };
  } catch {
    return null;
  }
}

/**
 * 从请求体里取出上下文，并**顺手把运输痕迹擦掉**。
 *
 * 返回的 body 已经不含哨兵 / `mmcode_ctx` —— 适配器可以直接把它翻译给上游，
 * 不会有任何本进程内部字段漏到上游。
 */
export function extractRequestContext(body: ChatRequestBody): {
  ctx: RequestContext;
  body: ChatRequestBody;
} {
  const ctx: RequestContext = {};
  let out = body;

  /* ① 顶层字段（OpenAI 路线）。 */
  const raw = (body as Record<string, unknown>)[CTX_FIELD];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    Object.assign(ctx, raw as RequestContext);
    out = { ...body };
    delete (out as Record<string, unknown>)[CTX_FIELD];
  }

  /* ② system 里的哨兵（Anthropic 路线）。 */
  const messages = Array.isArray(out.messages) ? [...out.messages] : [];
  let stripped = false;
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || msg.role !== 'system') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content.includes(SENTINEL_PREFIX)) continue;
    const decoded = decodeSentinel(content);
    if (!decoded) continue;
    Object.assign(ctx, decoded.ctx);
    /* 哨兵独占整条 system 时，摘完就整条丢掉（否则会多出一条空 system 消息）。 */
    messages[i] = decoded.rest === '' ? { role: 'system', content: '' } : { ...msg, content: decoded.rest };
    stripped = true;
    break;
  }
  if (stripped) out = { ...out, messages };

  return { ctx, body: out };
}

/** 取第一条 user 消息的纯文本（推导 session key 用）。 */
export function firstUserText(messages: ChatMessage[] | undefined): string {
  if (!Array.isArray(messages)) return '';
  for (const msg of messages) {
    if (!msg || msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      const parts = msg.content
        .map((p) => {
          if (p && typeof p === 'object') {
            const t = (p as { text?: unknown }).text;
            if (typeof t === 'string') return t;
          }
          return '';
        })
        .filter((s) => s !== '');
      if (parts.length > 0) return parts.join('\n');
    }
  }
  return '';
}

/** 推导 session key（显式 id 缺失时用）。 */
export function deriveSessionKey(keyId: string | undefined, model: string, firstUser: string): string {
  const hash = createHash('sha256')
    .update(keyId ?? '')
    .update('\n')
    .update(model ?? '')
    .update('\n')
    .update(firstUser)
    .digest('hex');
  return `d:${hash.slice(0, 32)}`;
}

/**
 * 算出本次请求的 session key。
 *
 * 显式 id 优先（`s:` 前缀），否则用推导（`d:` 前缀）—— 前缀让日志一眼能看出
 * 这个绑定是客户端明说的还是我们推出来的。
 */
export function resolveSessionKey(ctx: RequestContext, body: ChatRequestBody): string {
  const explicit = (ctx.sessionId ?? '').trim();
  if (explicit) return `s:${explicit.slice(0, 128)}`;
  return deriveSessionKey(ctx.keyId, body.model ?? '', firstUserText(body.messages));
}

/**
 * 从入站请求里找客户端**显式**给的 session id。
 *
 * 认得的头：x-session-id / x-session / x-conversation-id / x-chat-id；
 * 认得的 body 字段：session_id / sessionId / conversation_id / chat_id。
 */
export function findExplicitSessionId(
  headers: Record<string, string | string[] | undefined>,
  body: Record<string, unknown> | null,
): string | undefined {
  const headerNames = ['x-session-id', 'x-session', 'x-conversation-id', 'x-chat-id'];
  for (const name of headerNames) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  if (body) {
    const bodyNames = ['session_id', 'sessionId', 'conversation_id', 'chat_id'];
    for (const name of bodyNames) {
      const value = body[name];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return undefined;
}
