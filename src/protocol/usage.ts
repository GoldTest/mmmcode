/**
 * Anthropic 原生响应的用量采集与 SSE 聚合（纯 Anthropic 协议版）。
 *
 * ## 为什么放在适配器侧
 * 洞察面板要回答「**哪个账号**用了多少 token」。用量只出现在**响应**里，
 * 而「这次请求用了哪个账号」只有适配器知道（它才是选号的人）。
 * 所以在适配器里把两者放在一起记账，口径才是账号级真实消耗。
 *
 * ## 上游口径（v0.5.10 生产纠偏后保持一致）
 *   prompt_tokens     = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 *   completion_tokens = output_tokens
 *   cached_tokens     = cache_read_input_tokens（只算**读**命中；cache_creation 是写入，不算命中）
 *
 * 为什么必须三者相加：Anthropic 的 `input_tokens` **不含**缓存部分（生产实测
 * input=43 而 cache_read=128），只拿 input_tokens 当分母会导致缓存命中率超过 100%。
 *
 * 采集器是**零修改透传**的：上游 Anthropic SSE 字节原样发给客户端，
 * 只在旁路解析 `data:` 行提取 `message_start` 与 `message_delta` 里的 usage。
 */

import { UpstreamError } from '../errors.js';

/** 一次请求的用量。 */
export interface StreamUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
}

function toNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 缓存命中率 = **缓存命中的 token / 输入 token**。
 *
 * 分母用「输入 token 总数」= 原始输入 + 缓存写入 + 缓存读取。
 * 上游没给缓存字段时返回 0（而不是猜一个值）。
 */
export function cacheHitRate(cachedTokens: number, promptTokens: number): number {
  if (!Number.isFinite(cachedTokens) || !Number.isFinite(promptTokens) || promptTokens <= 0) return 0;
  return Math.max(0, Math.min(1, cachedTokens / promptTokens));
}

/**
 * 从 Anthropic `usage` 对象计算标准用量快照。
 * 缺省字段按 0 处理；若传入并非有效 usage 对象则返回 null。
 */
export function parseAnthropicUsage(usage: unknown): StreamUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const hasAny =
    typeof u.input_tokens === 'number' ||
    typeof u.output_tokens === 'number' ||
    typeof u.cache_read_input_tokens === 'number' ||
    typeof u.cache_creation_input_tokens === 'number';
  if (!hasAny) return null;

  const input = toNumber(u.input_tokens);
  const cacheCreation = toNumber(u.cache_creation_input_tokens);
  const cacheRead = toNumber(u.cache_read_input_tokens);
  const completionTokens = toNumber(u.output_tokens);
  const promptTokens = input + cacheCreation + cacheRead;
  return {
    promptTokens,
    completionTokens,
    cachedTokens: cacheRead,
    totalTokens: promptTokens + completionTokens,
  };
}

/** 从非流式 Anthropic Message JSON 中提取用量。 */
export function extractAnthropicJsonUsage(json: unknown): StreamUsage | null {
  if (!json || typeof json !== 'object') return null;
  return parseAnthropicUsage((json as { usage?: unknown }).usage);
}

/**
 * 透传地采集 Anthropic SSE 流里的 usage；流结束时回调一次（带最终累计 usage）。
 *
 * 为什么合并 `message_start` 和 `message_delta`：
 * Anthropic 上游通常在 `message_start.message.usage` 里给 input / cache_* 初始值，
 * 在 `message_delta.usage` 里给最终 `output_tokens`（有时也会更新 input/cache）。
 * 后出现的数字覆盖前者，两者合一才是完整账单。
 *
 * 没等到任何 usage（上游提前断流 / 客户端提前断开）就不回调 —— 不编造 0。
 */
export function collectAnthropicUsage(
  source: ReadableStream<Uint8Array>,
  onUsage: (usage: StreamUsage) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = '';
  let seenUsage = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreation = 0;
  let cacheRead = 0;

  const mergeUsage = (u: Record<string, unknown>) => {
    seenUsage = true;
    if (typeof u.input_tokens === 'number' && Number.isFinite(u.input_tokens)) inputTokens = u.input_tokens;
    if (typeof u.output_tokens === 'number' && Number.isFinite(u.output_tokens)) outputTokens = u.output_tokens;
    if (typeof u.cache_creation_input_tokens === 'number' && Number.isFinite(u.cache_creation_input_tokens)) {
      cacheCreation = u.cache_creation_input_tokens;
    }
    if (typeof u.cache_read_input_tokens === 'number' && Number.isFinite(u.cache_read_input_tokens)) {
      cacheRead = u.cache_read_input_tokens;
    }
  };

  const scan = (frame: string): void => {
    for (const line of frame.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (ev.type === 'message_start') {
        const msg = ev.message as { usage?: Record<string, unknown> } | undefined;
        if (msg?.usage && typeof msg.usage === 'object') mergeUsage(msg.usage);
      } else if (ev.type === 'message_delta') {
        const usage = ev.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage === 'object') mergeUsage(usage);
      }
    }
  };

  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          scan(frame);
        }
      },
      flush() {
        const tail = (buffer + decoder.decode()).replace(/\r\n/g, '\n');
        if (tail.trim() !== '') scan(tail);
        if (seenUsage) {
          const promptTokens = inputTokens + cacheCreation + cacheRead;
          onUsage({
            promptTokens,
            completionTokens: outputTokens,
            cachedTokens: cacheRead,
            totalTokens: promptTokens + outputTokens,
          });
        }
      },
    }),
  );
}

/**
 * 把 Anthropic SSE 事件流聚合成单个标准 Anthropic Message JSON 对象。
 *
 * 用于兜底「客户端请求 `stream: false`（非流式）但上游返回了 `text/event-stream`」的场景。
 */
export async function aggregateAnthropicSseToMessage(
  source: ReadableStream<Uint8Array>,
  fallbackModel = '',
): Promise<Record<string, unknown>> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  let id = `msg_${Date.now().toString(36)}`;
  let model = fallbackModel;
  let stopReason: string | null = null;
  let stopSequence: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  let sawStop = false;

  interface BlockAcc {
    type: string;
    text?: string;
    thinking?: string;
    signature?: string;
    id?: string;
    name?: string;
    partialJson?: string;
    input?: unknown;
  }
  const blocks = new Map<number, BlockAcc>();

  const processFrame = (frame: string) => {
    for (const line of frame.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }

      switch (ev.type) {
        case 'message_start': {
          const msg = (ev.message ?? {}) as Record<string, unknown>;
          if (typeof msg.id === 'string' && msg.id) id = msg.id;
          if (typeof msg.model === 'string' && msg.model) model = msg.model;
          const u = (msg.usage ?? {}) as Record<string, unknown>;
          if (typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
          if (typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
          if (typeof u.cache_creation_input_tokens === 'number') cacheCreation = u.cache_creation_input_tokens;
          if (typeof u.cache_read_input_tokens === 'number') cacheRead = u.cache_read_input_tokens;
          break;
        }
        case 'content_block_start': {
          const idx = typeof ev.index === 'number' ? ev.index : blocks.size;
          const cb = (ev.content_block ?? {}) as Record<string, unknown>;
          const type = typeof cb.type === 'string' ? cb.type : 'text';
          blocks.set(idx, {
            type,
            text: typeof cb.text === 'string' ? cb.text : '',
            thinking: typeof cb.thinking === 'string' ? cb.thinking : '',
            signature: typeof cb.signature === 'string' ? cb.signature : '',
            id: typeof cb.id === 'string' ? cb.id : undefined,
            name: typeof cb.name === 'string' ? cb.name : undefined,
            partialJson: '',
            input: cb.input,
          });
          break;
        }
        case 'content_block_delta': {
          const idx = typeof ev.index === 'number' ? ev.index : 0;
          const delta = (ev.delta ?? {}) as Record<string, unknown>;
          let acc = blocks.get(idx);
          if (!acc) {
            const dType = String(delta.type ?? '');
            acc = {
              type: dType === 'thinking_delta' || dType === 'signature_delta'
                ? 'thinking'
                : dType === 'input_json_delta'
                  ? 'tool_use'
                  : 'text',
              text: '',
              thinking: '',
              signature: '',
              partialJson: '',
            };
            blocks.set(idx, acc);
          }
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            acc.text = (acc.text ?? '') + delta.text;
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            acc.thinking = (acc.thinking ?? '') + delta.thinking;
          } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
            acc.signature = (acc.signature ?? '') + delta.signature;
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            acc.partialJson = (acc.partialJson ?? '') + delta.partial_json;
          }
          break;
        }
        case 'message_delta': {
          const delta = (ev.delta ?? {}) as Record<string, unknown>;
          if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason;
          if (typeof delta.stop_sequence === 'string') stopSequence = delta.stop_sequence;
          const u = (ev.usage ?? {}) as Record<string, unknown>;
          if (typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
          if (typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
          if (typeof u.cache_creation_input_tokens === 'number') cacheCreation = u.cache_creation_input_tokens;
          if (typeof u.cache_read_input_tokens === 'number') cacheRead = u.cache_read_input_tokens;
          break;
        }
        case 'message_stop':
          sawStop = true;
          break;
        case 'error': {
          const err = (ev.error ?? {}) as Record<string, unknown>;
          throw new UpstreamError(`上游流内错误：${String(err.message ?? 'unknown')}`);
        }
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        processFrame(frame);
      }
    }
    const tail = (buffer + decoder.decode()).replace(/\r\n/g, '\n');
    if (tail.trim() !== '') processFrame(tail);
  } finally {
    reader.releaseLock();
  }

  if (!sawStop && blocks.size === 0) {
    throw new UpstreamError('上游响应流提前中断且未收到有效事件');
  }

  const content = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => {
      if (b.type === 'thinking') {
        const out: Record<string, unknown> = { type: 'thinking', thinking: b.thinking ?? '' };
        if (b.signature) out.signature = b.signature;
        return out;
      }
      if (b.type === 'tool_use') {
        let parsedInput = b.input ?? {};
        if (b.partialJson) {
          try {
            parsedInput = JSON.parse(b.partialJson);
          } catch {
            parsedInput = {};
          }
        }
        return {
          type: 'tool_use',
          id: b.id ?? '',
          name: b.name ?? '',
          input: parsedInput,
        };
      }
      return { type: 'text', text: b.text ?? '' };
    });

  const usage: Record<string, number> = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
  if (cacheCreation > 0) usage.cache_creation_input_tokens = cacheCreation;
  if (cacheRead > 0) usage.cache_read_input_tokens = cacheRead;

  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: stopSequence,
    usage,
  };
}

/** 从 Anthropic Message JSON 中抽取可读文本（供请求日志摘要与在线调试使用）。 */
export function extractAnthropicMessageText(msg: unknown): {
  text: string;
  toolCalls: unknown[];
  finishReason?: string;
} {
  if (!msg || typeof msg !== 'object') return { text: '', toolCalls: [] };
  const obj = msg as Record<string, unknown>;
  const content = Array.isArray(obj.content) ? obj.content : [];
  const textParts: string[] = [];
  const toolCalls: unknown[] = [];

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string' && b.text) {
      textParts.push(b.text);
    } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
      textParts.push(b.thinking);
    } else if (b.type === 'tool_use') {
      toolCalls.push(b);
    }
  }

  return {
    text: textParts.join(''),
    toolCalls,
    finishReason: typeof obj.stop_reason === 'string' ? obj.stop_reason : undefined,
  };
}
