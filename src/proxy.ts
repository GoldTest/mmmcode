/**
 * 入站鉴权与反代转发。
 *
 * ## 为什么要在 core 之外做鉴权
 * core 的 `startServer` 只接受**一把**固定的 `apiKey`（字符串相等判断）。
 * 要支持「多把可管理的客户端密钥」，鉴权必须放在它前面：
 *
 *   客户端请求 → **本层校验（多把注册表）** → 转发给内部 core 服务器（内部密钥）
 *
 * 好处是**协议零重复实现**：Anthropic⇄OpenAI 翻译、SSE 帧编码、非流式聚合
 * 全部仍由 core 的 `startServer` 处理（已过实战验证），本层只管「你是谁」。
 *
 * ## 内部密钥
 * 每次进程启动随机生成一把内部密钥，只在本机环回端口上使用 ——
 * 外部永远拿不到它，core 那侧就等于「只有内部调用者」。
 */

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { startServer, toAnthropicErrorBody, type Adapter } from 'waygate-core';
import { maskInboundKey, type KeyRegistry } from './keys.js';
import type { RequestStore } from './requests.js';
import type { AccountPool } from './pool.js';
import {
  CTX_FIELD,
  encodeSentinel,
  findExplicitSessionId,
  type RequestContext,
} from './session.js';
import { cacheHitRate } from './protocol/usage.js';

/** 内部密钥：只在本机环回端口上用。 */
export const INTERNAL_KEY = randomBytes(32).toString('hex');

/** 从请求头里取入站密钥（OpenAI 用 Bearer，Anthropic 用 x-api-key）。 */
export function extractInboundKey(req: IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const v = auth.slice(7).trim();
    if (v) return v;
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  return null;
}

/** OpenAI 形状的错误体（客户端普遍认这个）。 */
function sendOpenAiError(res: ServerResponse, status: number, message: string, code: string): void {
  const text = JSON.stringify({ error: { message, type: 'waygate_error', code } });
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

/** Anthropic 形状的错误体（`/v1/messages` 的客户端只认这个）。 */
function sendAnthropicError(res: ServerResponse, status: number, message: string): void {
  const text = JSON.stringify(toAnthropicErrorBody(status, message));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

/** 该请求是否走 Anthropic 出口（决定错误体形状）。 */
function isAnthropicRoute(path: string): boolean {
  const route = path.startsWith('/v1/') ? path.slice(3) : path;
  return route === '/messages';
}

/** 该请求是否是**聊天**端点（只有聊天端点才需要注入 session 上下文）。 */
function isChatRoute(path: string, method: string | undefined): boolean {
  if (method !== 'POST') return false;
  const route = path.startsWith('/v1/') ? path.slice(3) : path;
  return route === '/chat/completions' || route === '/messages';
}

/**
 * 把上下文塞进 Anthropic 请求的 `system`。
 *
 * core 的 Anthropic 入站归一会**丢弃未识别的顶层字段**，只认 `system` / `messages` /
 * `tools` 等 —— 所以 Anthropic 路线只能借 `system` 传上下文。哨兵会在适配器侧被摘掉，
 * 绝不会发到上游。
 */
function injectSystemSentinel(system: unknown, ctx: RequestContext): string {
  const sentinel = encodeSentinel(ctx);
  if (typeof system === 'string' && system.trim()) return `${sentinel}\n\n${system}`;
  if (Array.isArray(system)) {
    const text = system
      .filter((b): b is { text: string } => !!b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text)
      .join('\n');
    return text ? `${sentinel}\n\n${text}` : sentinel;
  }
  return sentinel;
}

/**
 * 创建「鉴权 + 转发」处理器。
 *
 * 返回的函数直接把请求转给内部 core 服务器；鉴权不过就地回 401。
 */
export function createProxyForwarder(
  innerPort: number,
  keys: KeyRegistry,
  log: (line: string) => void,
  requests?: RequestStore,
  pool?: AccountPool,
): (req: IncomingMessage, res: ServerResponse) => void {
  /** 使用记录写盘有开销 —— 60 秒内不重复写。 */
  let lastMark = 0;
  const maybeMark = (key: string | null) => {
    const now = Date.now();
    if (now - lastMark < 60_000) return;
    lastMark = now;
    keys.markUsed(key);
  };

  return function forward(req: IncomingMessage, res: ServerResponse): void {
    const startTime = Date.now();
    const reqId = 'req_' + startTime.toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const provided = extractInboundKey(req);
    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      '127.0.0.1';

    const keyEntry = provided ? keys.get(provided) : null;
    const keyId = keyEntry?.id ?? null;
    const keyName = keyEntry?.name ?? (provided ? '默认' : null);
    const keyMasked = provided ? maskInboundKey(provided) : null;

    if (!keys.accepts(provided)) {
      const message = isAnthropicRoute(path)
        ? '入站密钥缺失或不正确（x-api-key 或 Authorization: Bearer <key>）'
        : '入站密钥缺失或不正确（Authorization: Bearer <key> 或 x-api-key）';

      if (requests) {
        requests.add({
          id: reqId,
          timestamp: startTime,
          method: req.method ?? 'GET',
          path,
          clientIp,
          keyId,
          keyName,
          keyMasked,
          stream: false,
          status: 401,
          durationMs: Date.now() - startTime,
          error: message,
        });
      }

      if (isAnthropicRoute(path)) sendAnthropicError(res, 401, message);
      else sendOpenAiError(res, 401, message, 'invalid_api_key');
      return;
    }
    maybeMark(provided);

    /* 缓冲请求体：既用于详情查看，也要往里注入 session 上下文。 */
    const reqChunks: Buffer[] = [];
    req.on('data', (chunk) => {
      reqChunks.push(chunk as Buffer);
    });

    /* 转发到内部 core 服务器，并把鉴权头换成内部密钥。
       ⚠️ 删掉 content-length —— 注入上下文后长度会变，而 http.request 是在**创建时**
       就把 headers 固化下来的。删掉后 Node 自动走 chunked 编码，内层照样收得全。 */
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: `127.0.0.1:${innerPort}` };
    delete headers['x-api-key'];
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    headers.authorization = `Bearer ${INTERNAL_KEY}`;

    const preq = httpRequest(
      { host: '127.0.0.1', port: innerPort, method: req.method, path: req.url, headers },
      (pres) => {
        const statusCode = pres.statusCode ?? 502;
        const contentType = pres.headers['content-type'] ?? '';
        const isSse = contentType.includes('text/event-stream');

        res.writeHead(statusCode, pres.headers);

        const resChunks: Buffer[] = [];
        let resBytes = 0;
        /** 首字节时刻 —— 用于算「首字符时间」。 */
        let firstByteAt: number | null = null;
        pres.on('data', (chunk) => {
          if (firstByteAt === null) firstByteAt = Date.now();
          if (resBytes < 4 * 1024 * 1024) {
            resChunks.push(chunk as Buffer);
            resBytes += chunk.length;
          }
        });

        pres.on('end', () => {
          if (!requests) return;
          const durationMs = Date.now() - startTime;
          const reqBodyStr = Buffer.concat(reqChunks).toString('utf8');
          const resBodyStr = Buffer.concat(resChunks).toString('utf8');

          let parsedInput: any = null;
          let modelName: string | null = null;
          let isStream = isSse;
          try {
            parsedInput = JSON.parse(reqBodyStr);
            modelName = parsedInput.model ?? null;
            if (typeof parsedInput.stream === 'boolean') isStream = parsedInput.stream;
          } catch {
            // 非 JSON 体
          }

          let responseText = '';
          let finishReason: string | undefined;
          let usage:
            | {
                prompt_tokens?: number;
                completion_tokens?: number;
                total_tokens?: number;
                cached_tokens?: number;
                cache_hit_rate?: number;
              }
            | undefined;
          let toolCalls: unknown[] | undefined;
          let errorMsg: string | undefined;

          let parsedRawJson: unknown = undefined;
          if (isSse) {
            const lines = resBodyStr.split('\n');
            const collectedTools: unknown[] = [];
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const dataPart = trimmed.slice(5).trim();
              if (!dataPart || dataPart === '[DONE]') continue;
              try {
                const json = JSON.parse(dataPart);
                const delta = json.choices?.[0]?.delta;
                if (delta?.content) responseText += delta.content;
                if (delta?.reasoning_content) responseText += delta.reasoning_content;
                if (delta?.tool_calls) collectedTools.push(...delta.tool_calls);
                if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
                if (json.usage) usage = json.usage;

                if (json.type === 'content_block_delta' && json.delta?.text) {
                  responseText += json.delta.text;
                }
                if (json.type === 'message_delta' && json.usage) {
                  usage = {
                    prompt_tokens: json.usage.input_tokens,
                    completion_tokens: json.usage.output_tokens,
                    total_tokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0),
                  };
                }
              } catch {
                // 忽略非完整分片
              }
            }
            if (collectedTools.length > 0) toolCalls = collectedTools;
          } else {
            try {
              const json = JSON.parse(resBodyStr);
              parsedRawJson = json;
              if (json.choices?.[0]?.message?.content) {
                responseText = json.choices[0].message.content;
                finishReason = json.choices[0].finish_reason;
                if (json.choices[0].message.tool_calls) toolCalls = json.choices[0].message.tool_calls;
              } else if (Array.isArray(json.content) && json.content[0]?.text) {
                responseText = json.content[0].text;
              }
              if (json.usage) usage = json.usage;
              if (json.error) {
                errorMsg = typeof json.error === 'string' ? json.error : json.error.message ?? JSON.stringify(json.error);
              }
            } catch {
              if (statusCode >= 400) errorMsg = resBodyStr.slice(0, 500);
            }
          }

          /* 缓存命中与命中率的**权威值**来自适配器（它看得到上游原始 usage）。
             Anthropic 路线经 core 重编码成 Anthropic 事件帧时缓存字段会被丢掉 ——
             只有适配器那一层还留着，所以这里用它补齐。 */
          const recorded = pool?.getRequestUsage(reqId);
          if (recorded) {
            usage = {
              prompt_tokens: recorded.promptTokens,
              completion_tokens: recorded.completionTokens,
              total_tokens: recorded.totalTokens,
              cached_tokens: recorded.cachedTokens,
              cache_hit_rate: cacheHitRate(recorded.cachedTokens, recorded.promptTokens),
            };
          } else if (usage) {
            const details = (usage as unknown as { prompt_tokens_details?: { cached_tokens?: number } })
              .prompt_tokens_details;
            const cached = usage.cached_tokens ?? details?.cached_tokens ?? 0;
            usage = {
              ...usage,
              cached_tokens: cached,
              cache_hit_rate: cacheHitRate(cached, usage.prompt_tokens ?? 0),
            };
          }

          /* 实际服务的账号：适配器按 reqId 记下的（并发下比「最近使用」准确）。 */
          const accountUsed = pool?.getRequestAccount(reqId) ?? pool?.getLastUsedAccount() ?? null;

          requests.add({
            id: reqId,
            timestamp: startTime,
            method: req.method ?? 'POST',
            path,
            clientIp,
            keyId,
            keyName,
            keyMasked,
            model: modelName,
            stream: isStream,
            status: statusCode,
            durationMs,
            /** 首字符时间：收到请求 → 第一个响应字节。 */
            firstByteMs: firstByteAt === null ? null : firstByteAt - startTime,
            /** 中转：上游地址 / 账号 / 转译后实际发给上游的请求体。 */
            transit: pool?.getRequestTransit(reqId) ?? null,
            account: accountUsed,
            input: parsedInput
              ? {
                  messages: parsedInput.messages,
                  prompt: parsedInput.prompt,
                  model: parsedInput.model,
                  temperature: parsedInput.temperature,
                  max_tokens: parsedInput.max_tokens,
                  raw: parsedInput,
                }
              : reqBodyStr
                ? { raw: reqBodyStr.slice(0, 4000) }
                : null,
            output: {
              text: responseText || undefined,
              toolCalls,
              usage,
              finish_reason: finishReason,
              error: errorMsg,
              raw: parsedRawJson,
            },
            error: errorMsg || (statusCode >= 400 ? `HTTP ${statusCode}` : undefined),
          });
        });

        pres.pipe(res);
        pres.on('error', () => res.destroy());
      },
    );

    preq.on('error', (err) => {
      log(`[反代错误] ${err.message}`);
      if (requests) {
        requests.add({
          id: reqId,
          timestamp: startTime,
          method: req.method ?? 'POST',
          path,
          clientIp,
          keyId,
          keyName,
          keyMasked,
          stream: false,
          status: 502,
          durationMs: Date.now() - startTime,
          account: pool?.getRequestAccount(reqId) ?? pool?.getLastUsedAccount() ?? null,
          error: `反代内部错误：${err.message}`,
        });
      }

      if (!res.headersSent) {
        const text = JSON.stringify({ error: { message: `反代内部错误：${err.message}`, type: 'waygate_error' } });
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        res.end(text);
      } else {
        res.destroy();
      }
    });

    res.on('close', () => {
      /* 客户端断连 → 打断内部请求（core 靠 req 的 close 事件中止上游调用，
         不传导就会留下孤儿请求继续烧额度）。 */
      if (!res.writableEnded) preq.destroy();
    });

    /* 请求体收齐后再转发 —— 中间要把 session 上下文注进去。
       （不能边收边转：注入要改 body 长度，而 http.request 的 headers 已固化。） */
    req.on('end', () => {
      const raw = Buffer.concat(reqChunks);
      let out = raw;
      if (isChatRoute(path, req.method) && raw.length > 0) {
        try {
          const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const ctx: RequestContext = {
              sessionId: findExplicitSessionId(req.headers, parsed),
              keyId: keyId ?? undefined,
              reqId,
            };
            if (isAnthropicRoute(path)) {
              /* Anthropic 路线：走 system 哨兵（core 会丢弃未知顶层字段）。 */
              parsed.system = injectSystemSentinel(parsed.system, ctx);
            } else {
              /* OpenAI 路线：core 保留未知顶层字段，直接塞字段即可。 */
              parsed[CTX_FIELD] = ctx;
            }
            out = Buffer.from(JSON.stringify(parsed), 'utf8');
          }
        } catch {
          /* 不是合法 JSON —— 原样转发，让内层去报错。 */
        }
      }
      if (out.length > 0) preq.write(out);
      preq.end();
    });
  };
}

export interface ProxyServerOptions {
  host: string;
  port: number;
  adapter: Adapter;
  keys: KeyRegistry;
  pool?: AccountPool;
  requests?: RequestStore;
  log?: (line: string) => void;
  verbose?: boolean;
}

export interface ProxyServerHandle {
  port: number;
  close(): Promise<void>;
}

/**
 * 启动一个**独立的**反代服务（`mmcode serve` 用）。
 *
 * 与 `mmcode web` 的差别只是「外面有没有套一层管理页」——
 * 反代本身（鉴权 + 协议）完全共用同一套实现。
 */
export async function startProxyServer(opts: ProxyServerOptions): Promise<ProxyServerHandle> {
  const log = opts.log ?? ((line: string) => process.stdout.write(line + '\n'));

  /* 内部 core 服务器（环回，固定端口由 OS 分配）。 */
  const inner = await startServer(opts.adapter, {
    host: '127.0.0.1',
    port: 0,
    apiKey: INTERNAL_KEY,
    verbose: opts.verbose,
    log: (line) => log(line),
  });

  const forward = createProxyForwarder(inner.port, opts.keys, log, opts.requests, opts.pool);
  const server = createServer((req, res) => {
    void forward(req, res);
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolvePromise());
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;

  return {
    port,
    close: async () => {
      await inner.close();
      await new Promise<void>((done) => {
        server.close(() => done());
        setTimeout(() => done(), 3000).unref?.();
      });
    },
  };
}
