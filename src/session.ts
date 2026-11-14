/**
 * 请求上下文与 session 识别（纯 Anthropic 协议版）。
 *
 * ## 要解决什么
 * 「同一 session 的请求（含 `count_tokens` 与 `messages`）永远一对一绑定到同一个账号」
 * 需要能稳定认出「同一个会话」。客户端（如 Claude Code / Anthropic SDK）不一定
 * 主动发 `x-session-id`，所以提供两条路径：
 *
 *   ① **显式**：客户端带 `x-mavis-session-id` / `x-session-id` 等头、顶层 `session_id` / `sessionid`、或 `metadata.session_id`
 *      （以及 Claude Code 的 `metadata.user_id` 中 `__session_<id>` 片段）—— 精确，最优先；
 *   ② **推导**：没有显式 id 时，用「入站密钥 + 模型 + 首条用户消息」哈希当 session key。
 *      同一个新会话先调用 `/v1/messages/count_tokens` 再调用 `/v1/messages`，
 *      以及后续多轮重发历史消息时，首条 user 消息与模型都一致 ⇒ 稳定归组到同一个账号。
 *
 * ## 不再需要哨兵穿孔
 * 此前由于请求需经过 `waygate-core` 的 `startServer` 做 Anthropic→OpenAI 归一，
 * 未知顶层字段会被丢弃，才不得不用 `[[mmcode-ctx:...]]` 哨兵借道 `system`。
 * 现在反代直接处理原生 Anthropic 透传，`RequestContext` 作为函数参数直接传入适配器，
 * 零污染用户 `system` 提示词与 `cache_control` 结构。
 */

import { createHash } from 'node:crypto';

/** 一次请求携带的上下文。 */
export interface RequestContext {
  /** 客户端显式提供的会话 id。 */
  sessionId?: string;
  /** 入站密钥 id —— 用来把不同客户端的同名会话隔离开。 */
  keyId?: string;
  /** 反代请求 id —— 用来把「这次请求实际用了哪个账号 / 用量 / 中转」对上账。 */
  reqId?: string;
}

/**
 * 清理只供本反代识别 session 的非 Anthropic 标准顶层字段，避免发给上游时触发严格校验。
 */
export function stripSessionFields<T extends Record<string, unknown>>(body: T): T {
  const out = { ...body };
  delete out['session_id'];
  delete out['sessionId'];
  delete out['sessionid'];
  delete out['conversation_id'];
  delete out['chat_id'];
  delete out['mavis_session_id'];
  delete out['mavisSessionId'];
  return out;
}

/**
 * 判断一条 user 消息是否**纯由 tool_result 组成**。
 *
 * Anthropic 协议里 `tool_result` 消息的 role 是 `user`，但它代表的是**工具返回值**
 * 而非人类输入。在 agentic 工作流中，客户端可能截断/滑窗消息历史，使得 messages
 * 数组的第一条 `role=user` 消息变成 tool_result —— 它的内容每轮都不同。
 * 跳过这类消息，才能稳定地推导出同一个 session key。
 */
function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return false;
  return content.every(
    (block) =>
      block && typeof block === 'object' &&
      (block as { type?: unknown }).type === 'tool_result',
  );
}

/**
 * 取第一条**人类** user 消息的纯文本（推导 session key 用）。
 *
 * 跳过只含 `tool_result` 的 user 消息 —— 它们是工具返回值而非人类输入，
 * 内容随对话进展不断变化，拿它做哈希会让同一个对话推出不同的 session key。
 * 截取前 200 字符参与哈希 —— 足以区分不同对话，同时避免被动态注入的长内容干扰。
 */
export function firstUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as { role?: unknown; content?: unknown };
    if (m.role !== 'user') continue;
    /* 跳过纯 tool_result 的 user 消息（那不是人类输入）。 */
    if (isToolResultOnly(m.content)) continue;
    if (typeof m.content === 'string') return m.content.slice(0, 200);
    if (Array.isArray(m.content)) {
      const parts = m.content
        .map((p) => {
          if (p && typeof p === 'object') {
            /* 只取 text 类型的 block，忽略 tool_result block（混在普通文本消息里的情况）。 */
            if ((p as { type?: unknown }).type === 'tool_result') return '';
            const t = (p as { text?: unknown }).text;
            if (typeof t === 'string') return t;
          }
          return '';
        })
        .filter((s) => s !== '');
      if (parts.length > 0) return parts.join('\n').slice(0, 200);
      /* 若首条 user 消息只含非 text 块（如纯图片），序列化首条内容保证不同会话不撞车。 */
      try {
        return JSON.stringify(m.content).slice(0, 200);
      } catch {
        return '';
      }
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
 *
 * 注意：`/v1/messages/count_tokens` 与 `/v1/messages` 共用本函数，
 * 因此同一会话先 count_tokens 再 messages 会命中完全相同的 sessionKey。
 */
export function resolveSessionKey(
  ctx: RequestContext,
  body: { model?: unknown; messages?: unknown },
): string {
  const explicit = (ctx.sessionId ?? '').trim();
  if (explicit) return `s:${explicit.slice(0, 128)}`;
  const model = typeof body.model === 'string' ? body.model : '';
  return deriveSessionKey(ctx.keyId, model, firstUserText(body.messages));
}

/**
 * 从入站请求里找客户端**显式**给的 session id。
 *
 * 认得的头：x-mavis-session-id（mcode CLI 原生头）/ mavis-session-id /
 *           x-session-id / x-session / session-id / sessionid /
 *           x-conversation-id / x-chat-id；
 * 认得的 body 字段：session_id / sessionId / sessionid / conversation_id / chat_id /
 *                   mavis_session_id / mavisSessionId / metadata.session_id；
 * 以及 Claude Code 在 `metadata.user_id` 中携带的 `...__session_<id>` 片段。
 */
export function findExplicitSessionId(
  headers: Record<string, string | string[] | undefined>,
  body: Record<string, unknown> | null,
): string | undefined {
  const headerNames = [
    'x-mavis-session-id',
    'mavis-session-id',
    'x-session-id',
    'x-session',
    'session-id',
    'sessionid',
    'x-conversation-id',
    'x-chat-id',
  ];
  for (const name of headerNames) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  /* 兜底：处理非标准小写化的 headers 对象（如手工传入大写头） */
  const headerEntries = Object.entries(headers);
  for (const name of headerNames) {
    const entry = headerEntries.find(([k]) => k.toLowerCase() === name);
    if (entry) {
      const raw = entry[1];
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }

  if (body) {
    const bodyNames = [
      'session_id',
      'sessionId',
      'sessionid',
      'mavis_session_id',
      'mavisSessionId',
      'conversation_id',
      'chat_id',
    ];
    for (const name of bodyNames) {
      const value = body[name];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    const meta = body['metadata'];
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const m = meta as Record<string, unknown>;
      if (typeof m['session_id'] === 'string' && m['session_id'].trim()) {
        return m['session_id'].trim();
      }
      if (typeof m['sessionId'] === 'string' && m['sessionId'].trim()) {
        return m['sessionId'].trim();
      }
      if (typeof m['sessionid'] === 'string' && m['sessionid'].trim()) {
        return m['sessionid'].trim();
      }
      if (typeof m['mavis_session_id'] === 'string' && m['mavis_session_id'].trim()) {
        return m['mavis_session_id'].trim();
      }
      if (typeof m['user_id'] === 'string') {
        const match = /__session_([A-Za-z0-9_.:-]+)/.exec(m['user_id']);
        if (match?.[1]) return match[1];
      }
    }
  }
  return undefined;
}
