/**
 * 流内用量采集 —— 从 OpenAI 形状的 SSE 里把 `usage` 摘出来。
 *
 * ## 为什么放在适配器侧
 * 洞察面板要回答「**哪个账号**用了多少 token」。用量只出现在**响应流**里，
 * 而「这次请求用了哪个账号」只有适配器知道（它才是选号的人）。
 * 所以在适配器里把两者放在一起记账，口径才是账号级真实消耗，而不是事后猜。
 *
 * ## 上游口径（与 `stream-decode.ts` 对齐）
 *   prompt_tokens     = input + cache_creation + cache_read
 *   completion_tokens = output
 *   cached_tokens     = cache_read（只算**读**命中）
 *
 * 采集器是**透传**的：原始字节原样往下游发，只在旁路解析 `data:` 行。
 * 这样不会影响 core 的协议编码（core 还要靠这些字节做 Anthropic 帧编码）。
 */

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
 * 分母用「输入 token 总数」= 原始输入 + 缓存写入 + 缓存读取（与 Anthropic 的
 * `prompt_tokens` 口径一致）—— 也就是「这次输入里有多少是直接命中缓存的」。
 *
 * 上游没给缓存字段时返回 0（而不是猜一个值）。
 */
export function cacheHitRate(cachedTokens: number, promptTokens: number): number {
  if (!Number.isFinite(cachedTokens) || !Number.isFinite(promptTokens) || promptTokens <= 0) return 0;
  return Math.max(0, Math.min(1, cachedTokens / promptTokens));
}

/**
 * 透传地采集流里的 usage；流结束时回调一次（带最后一次看到的 usage）。
 *
 * 没等到 usage（上游提前断流 / 客户端提前断开）就不回调 —— 不编造 0。
 */
export function collectUsage(
  source: ReadableStream<Uint8Array>,
  onUsage: (usage: StreamUsage) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = '';
  let latest: StreamUsage | null = null;

  const scan = (text: string): void => {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj: { usage?: Record<string, unknown> };
      try {
        obj = JSON.parse(payload) as { usage?: Record<string, unknown> };
      } catch {
        continue; /* 坏帧跳过 */
      }
      const usage = obj.usage;
      if (!usage || typeof usage !== 'object') continue;
      const promptTokens = toNumber(usage.prompt_tokens);
      const completionTokens = toNumber(usage.completion_tokens);
      const details = usage.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
      const cachedTokens = toNumber(details?.cached_tokens);
      latest = {
        promptTokens,
        completionTokens,
        cachedTokens,
        totalTokens: toNumber(usage.total_tokens) || promptTokens + completionTokens,
      };
    }
  };

  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          scan(frame);
        }
      },
      flush() {
        const tail = buffer + decoder.decode();
        if (tail.trim() !== '') scan(tail);
        if (latest) onUsage(latest);
      },
    }),
  );
}
