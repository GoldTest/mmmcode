/**
 * 入站鉴权与原生 Anthropic 反代处理器。
 *
 * ## 为什么不再经过 `waygate-core` 的 `startServer` 环回
 * 此前由于同时兼容 OpenAI 与 Anthropic，入站请求必须进 `waygate-core` 做
 * `Anthropic → OpenAI → Anthropic` 往返翻译，不仅产生一次本机环回，还会丢失
 * `cache_read_input_tokens`、`thinking` 块、`cache_control` 等原生字段，也不支持
 * `/v1/messages/count_tokens`。
 *
 * 现在上游接口本身就是原生 Anthropic 协议，本仓也全面聚焦纯 Anthropic 协议，
 * 因此本文件直接承担 HTTP 收发与多密钥鉴权：
 *   - `POST /v1/messages`（及 `/messages`）→ `adapter.messages()`
 *   - `POST /v1/messages/count_tokens`（及 `/messages/count_tokens`）→ `adapter.countTokens()`
 *   - `GET  /v1/models`（及 `/models`）→ `adapter.listModels()`
 *   - `GET  /healthz` → 健康检查（无鉴权）
 *   - `/v1/chat/completions` 与 `/chat/completions` 等非 Anthropic 路由 → 404 `not_found_error`
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { toAnthropicErrorBody } from 'waygate-core';
import type { MmcodeAdapter, AnthropicInboundHeaders } from './adapter.js';
import { CredentialError, UpstreamError } from './errors.js';
import { maskInboundKey, type KeyRegistry } from './keys.js';
import type { AccountPool } from './pool.js';
import {
  cacheHitRate,
  extractAnthropicMessageText,
  parseAnthropicUsage,
  type StreamUsage,
} from './protocol/usage.js';
import type { RequestStore } from './requests.js';
import { findExplicitSessionId, type RequestContext } from './session.js';

/** 入站请求体上限（8MB）。 */
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

/**
 * 响应体旁路采集上限（1MB）—— 仅用于「请求详情」留痕，不影响透传给客户端的完整流。
 */
export const MAX_CAPTURE_BYTES = 1 * 1024 * 1024;

/** 从请求头里取入站密钥（Anthropic 常用 `x-api-key`，也兼容 `Authorization: Bearer <key>`）。 */
export function extractInboundKey(req: IncomingMessage): string | null {
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const v = auth.slice(7).trim();
    if (v) return v;
  }
  return null;
}

function headerStr(val: string | string[] | undefined): string | undefined {
  if (typeof val === 'string' && val.trim()) return val.trim();
  if (Array.isArray(val) && typeof val[0] === 'string' && val[0].trim()) return val[0].trim();
  return undefined;
}

/** 发送 JSON 响应。 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Anthropic 形状的错误体（`{ type: "error", error: { type, message } }`）。 */
function sendAnthropicError(res: ServerResponse, status: number, message: string, rawBody?: string): void {
  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as { type?: unknown; error?: { message?: unknown } };
      if (parsed && typeof parsed === 'object' && parsed.type === 'error' && parsed.error && typeof parsed.error === 'object') {
        const text = JSON.stringify(parsed);
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(text),
        });
        res.end(text);
        return;
      }
    } catch {
      // 上游错误体不是 JSON，走统一包装
    }
  }
  sendJson(res, status, toAnthropicErrorBody(status, message));
}

/** 读取入站请求体（带字节上限保护，防止大请求把堆外内存打爆）。 */
function readRawBody(
  req: IncomingMessage,
  limitBytes: number,
): Promise<{ ok: true; raw: Buffer } | { ok: false; status: number; message: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: { ok: true; raw: Buffer } | { ok: false; status: number; message: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > limitBytes) {
        chunks.length = 0;
        req.destroy();
        finish({ ok: false, status: 413, message: `请求体超过 ${limitBytes} 字节限制` });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, raw: Buffer.concat(chunks) }));
    req.on('error', (err) => finish({ ok: false, status: 400, message: `读取请求体失败：${err.message}` }));
  });
}

/** 从旁路采集的 Anthropic SSE 文本里提取摘要信息（文本、工具调用、结束原因、usage）。 */
function summarizeAnthropicSse(sseText: string): {
  text: string;
  toolCalls: unknown[];
  finishReason?: string;
  fallbackUsage?: StreamUsage;
} {
  let text = '';
  let finishReason: string | undefined;
  const toolBlocks = new Map<number, { type: 'tool_use'; id: string; name: string; partialJson: string }>();
  let fallbackUsageRaw: Record<string, unknown> | null = null;

  for (const line of sseText.split('\n')) {
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
      if (msg?.usage && typeof msg.usage === 'object') {
        fallbackUsageRaw = { ...(fallbackUsageRaw ?? {}), ...msg.usage };
      }
    } else if (ev.type === 'content_block_start') {
      const idx = typeof ev.index === 'number' ? ev.index : toolBlocks.size;
      const cb = ev.content_block as Record<string, unknown> | undefined;
      if (cb?.type === 'tool_use') {
        toolBlocks.set(idx, {
          type: 'tool_use',
          id: typeof cb.id === 'string' ? cb.id : '',
          name: typeof cb.name === 'string' ? cb.name : '',
          partialJson: '',
        });
      }
    } else if (ev.type === 'content_block_delta') {
      const idx = typeof ev.index === 'number' ? ev.index : 0;
      const delta = ev.delta as Record<string, unknown> | undefined;
      if (!delta) continue;
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        text += delta.text;
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        text += delta.thinking;
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const tb = toolBlocks.get(idx);
        if (tb) tb.partialJson += delta.partial_json;
      }
    } else if (ev.type === 'message_delta') {
      const delta = ev.delta as Record<string, unknown> | undefined;
      if (typeof delta?.stop_reason === 'string') finishReason = delta.stop_reason;
      const usage = ev.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage === 'object') {
        fallbackUsageRaw = { ...(fallbackUsageRaw ?? {}), ...usage };
      }
    }
  }

  const toolCalls = [...toolBlocks.values()].map((tb) => {
    let input: unknown = {};
    if (tb.partialJson) {
      try {
        input = JSON.parse(tb.partialJson);
      } catch {
        input = tb.partialJson;
      }
    }
    return { type: 'tool_use', id: tb.id, name: tb.name, input };
  });

  const fallbackUsage = fallbackUsageRaw ? parseAnthropicUsage(fallbackUsageRaw) ?? undefined : undefined;
  return { text, toolCalls, finishReason, fallbackUsage };
}

/** 把 `StreamUsage` 转成 RequestStore 的展示字段。 */
function formatUsageForRecord(usage: StreamUsage | null | undefined) {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    cached_tokens: usage.cachedTokens,
    cache_hit_rate: cacheHitRate(usage.cachedTokens, usage.promptTokens),
  };
}

export interface ProxyHandlerOptions {
  adapter: MmcodeAdapter;
  keys: KeyRegistry;
  pool?: AccountPool;
  requests?: RequestStore;
  log?: (line: string) => void;
  verbose?: boolean;
}

/**
 * 创建原生 Anthropic 反代处理器（`serve` 与 `web` 共用，无内部环回）。
 */
export function createProxyHandler(
  opts: ProxyHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { adapter, keys, pool, requests, verbose } = opts;
  const log = opts.log ?? ((line: string) => process.stdout.write(line + '\n'));

  /** 使用记录写盘有开销 —— 60 秒内不重复写。 */
  let lastMark = 0;
  const maybeMark = (key: string | null) => {
    const now = Date.now();
    if (now - lastMark < 60_000) return;
    lastMark = now;
    keys.markUsed(key);
  };

  return async function handleProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();
    const reqId = 'req_' + startTime.toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';
    const method = req.method ?? 'GET';

    /* 健康检查：不鉴权。 */
    if (path === '/healthz' && method === 'GET') {
      sendJson(res, 200, { ok: true, service: adapter.command, upstream: adapter.upstreamLabel });
      return;
    }

    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      '127.0.0.1';
    const provided = extractInboundKey(req);
    const keyEntry = provided ? keys.get(provided) : null;
    const keyId = keyEntry?.id ?? null;
    const keyName = keyEntry?.name ?? (provided ? '默认' : null);
    const keyMasked = provided ? maskInboundKey(provided) : null;

    /* 入站鉴权。 */
    if (!keys.accepts(provided)) {
      const message = '入站密钥缺失或不正确（x-api-key 或 Authorization: Bearer <key>）';
      requests?.add({
        id: reqId,
        timestamp: startTime,
        method,
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
      sendAnthropicError(res, 401, message);
      return;
    }
    maybeMark(provided);

    /* 路径归一：兼容带 `/v1` 与不带 `/v1` 的前缀（如 Claude Code 仅填 origin 时会自动补 `/v1`）。 */
    const route = path.startsWith('/v1/') ? path.slice(3) : path;

    /* ── GET /v1/models ── */
    if (route === '/models' && method === 'GET') {
      const models = await adapter.listModels();
      sendJson(res, 200, {
        object: 'list',
        data: models.map((m) => ({
          id: m.id,
          type: 'model',
          object: 'model',
          display_name: m.displayName ?? m.id,
          owned_by: adapter.command,
          created: 0,
        })),
        has_more: false,
      });
      return;
    }

    const isMessages = route === '/messages' && method === 'POST';
    const isCountTokens = route === '/messages/count_tokens' && method === 'POST';

    if (!isMessages && !isCountTokens) {
      const msg = `未知或不支持的端点：${method} ${path}（本服务仅支持 Anthropic 协议：POST /v1/messages、POST /v1/messages/count_tokens、GET /v1/models）`;
      requests?.add({
        id: reqId,
        timestamp: startTime,
        method,
        path,
        clientIp,
        keyId,
        keyName,
        keyMasked,
        stream: false,
        status: 404,
        durationMs: Date.now() - startTime,
        error: msg,
      });
      sendAnthropicError(res, 404, msg);
      return;
    }

    /* 读取并校验请求体。 */
    const bodyRead = await readRawBody(req, MAX_REQUEST_BODY_BYTES);
    if (!bodyRead.ok) {
      if (bodyRead.status === 413) {
        log(`[反代] 请求体超过 ${MAX_REQUEST_BODY_BYTES} 字节，已拒绝：${url}`);
      }
      requests?.add({
        id: reqId,
        timestamp: startTime,
        method,
        path,
        clientIp,
        keyId,
        keyName,
        keyMasked,
        stream: false,
        status: bodyRead.status,
        durationMs: Date.now() - startTime,
        error: bodyRead.message,
      });
      if (!res.headersSent) sendAnthropicError(res, bodyRead.status, bodyRead.message);
      return;
    }

    const reqBodyStr = bodyRead.raw.toString('utf8');
    let parsed: Record<string, unknown>;
    try {
      const rawJson = reqBodyStr ? JSON.parse(reqBodyStr) : null;
      if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) {
        throw new Error('请求体必须是 JSON 对象');
      }
      parsed = rawJson as Record<string, unknown>;
    } catch {
      const msg = '请求体必须是合法的 JSON 对象';
      requests?.add({
        id: reqId,
        timestamp: startTime,
        method,
        path,
        clientIp,
        keyId,
        keyName,
        keyMasked,
        stream: false,
        status: 400,
        durationMs: Date.now() - startTime,
        input: reqBodyStr ? { raw: reqBodyStr.slice(0, 4000) } : null,
        error: msg,
      });
      sendAnthropicError(res, 400, msg);
      return;
    }

    const modelName = typeof parsed.model === 'string' ? parsed.model.trim() : '';
    if (!modelName) {
      const msg = 'model 为必填项且必须是非空字符串';
      requests?.add({
        id: reqId,
        timestamp: startTime,
        method,
        path,
        clientIp,
        keyId,
        keyName,
        keyMasked,
        stream: false,
        status: 400,
        durationMs: Date.now() - startTime,
        input: { raw: parsed },
        error: msg,
      });
      sendAnthropicError(res, 400, msg);
      return;
    }

    if (!Array.isArray(parsed.messages) || (isMessages && parsed.messages.length === 0)) {
      const msg = isMessages ? 'messages 为必填项且不能为空数组' : 'messages 为必填项且必须是数组';
      requests?.add({
        id: reqId,
        timestamp: startTime,
        method,
        path,
        clientIp,
        keyId,
        keyName,
        keyMasked,
        model: modelName,
        stream: false,
        status: 400,
        durationMs: Date.now() - startTime,
        input: { model: modelName, raw: parsed },
        error: msg,
      });
      sendAnthropicError(res, 400, msg);
      return;
    }

    const wantsStream = isMessages && parsed.stream === true;
    const ctx: RequestContext = {
      sessionId: findExplicitSessionId(req.headers, parsed),
      keyId: keyId ?? undefined,
      reqId,
    };
    const inboundHeaders: AnthropicInboundHeaders = {
      anthropicVersion: headerStr(req.headers['anthropic-version']),
      anthropicBeta: headerStr(req.headers['anthropic-beta']),
    };

    if (verbose) {
      log(
        `[请求] ${adapter.command} ${path} model=${modelName} messages=${parsed.messages.length} 流=${wantsStream}`,
      );
    }

    /* 监听响应关闭（而非 req.on('close')）：避免读取完请求体后被误判为客户端断连。 */
    const ac = new AbortController();
    const onResClose = () => {
      if (!res.writableEnded) ac.abort();
    };
    res.on('close', onResClose);

    const inputRecord = {
      messages: parsed.messages as Array<{ role: string; content: unknown }>,
      model: modelName,
      temperature: typeof parsed.temperature === 'number' ? parsed.temperature : undefined,
      max_tokens: typeof parsed.max_tokens === 'number' ? parsed.max_tokens : undefined,
      raw: parsed,
    };

    try {
      if (isCountTokens) {
        const result = await adapter.countTokens(parsed, ac.signal, ctx, inboundHeaders);
        const firstByteAt = Date.now();
        res.writeHead(result.status, {
          'content-type': result.contentType || 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(result.bodyText),
        });
        res.end(result.bodyText);

        if (requests) {
          let parsedRawJson: Record<string, unknown> | undefined;
          try {
            parsedRawJson = JSON.parse(result.bodyText) as Record<string, unknown>;
          } catch {
            // ignore
          }
          const inputTokensVal =
            parsedRawJson && typeof parsedRawJson.input_tokens === 'number' ? parsedRawJson.input_tokens : undefined;
          const accountUsed = pool?.getRequestAccount(reqId) ?? pool?.getLastUsedAccount() ?? null;
          /* count_tokens 不记入 output.usage，避免虚增请求统计里的 token 消耗总量。 */
          requests.add({
            id: reqId,
            timestamp: startTime,
            method,
            path,
            clientIp,
            keyId,
            keyName,
            keyMasked,
            model: modelName,
            stream: false,
            status: result.status,
            durationMs: Date.now() - startTime,
            firstByteMs: firstByteAt - startTime,
            transit: pool?.getRequestTransit(reqId) ?? null,
            account: accountUsed,
            input: inputRecord,
            output: {
              text: inputTokensVal !== undefined ? `input_tokens: ${inputTokensVal}` : result.bodyText,
              raw: parsedRawJson ?? result.bodyText,
            },
          });
        }
        return;
      }

      /* ── POST /v1/messages ── */
      const result = await adapter.messages(parsed, ac.signal, ctx, inboundHeaders);

      /* 流式 SSE 透传 */
      if (result.stream) {
        res.writeHead(result.status, {
          'content-type': result.contentType || 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });

        const resChunks: Buffer[] = [];
        let resBytes = 0;
        let firstByteAt: number | null = null;
        let streamError: string | undefined;

        const reader = result.stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (firstByteAt === null) firstByteAt = Date.now();
            if (value && value.byteLength > 0) {
              const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
              if (resBytes < MAX_CAPTURE_BYTES) {
                resChunks.push(buf);
                resBytes += buf.length;
              }
              if (!res.destroyed && !res.writableEnded) {
                res.write(buf);
              }
            }
          }
        } catch (err) {
          if (!ac.signal.aborted) {
            streamError = err instanceof Error ? err.message : String(err);
            log(`[流错误] ${streamError}`);
            if (!res.destroyed && !res.writableEnded) {
              res.write(`event: error\ndata: ${JSON.stringify(toAnthropicErrorBody(502, streamError))}\n\n`);
            }
          }
        } finally {
          reader.releaseLock();
          if (!res.writableEnded) res.end();
        }

        if (requests) {
          const resBodyStr = Buffer.concat(resChunks).toString('utf8');
          const summary = summarizeAnthropicSse(resBodyStr);
          const recorded = pool?.getRequestUsage(reqId);
          const usage = formatUsageForRecord(recorded ?? summary.fallbackUsage);
          const accountUsed = pool?.getRequestAccount(reqId) ?? pool?.getLastUsedAccount() ?? null;

          requests.add({
            id: reqId,
            timestamp: startTime,
            method,
            path,
            clientIp,
            keyId,
            keyName,
            keyMasked,
            model: modelName,
            stream: true,
            status: result.status,
            durationMs: Date.now() - startTime,
            firstByteMs: firstByteAt === null ? null : firstByteAt - startTime,
            transit: pool?.getRequestTransit(reqId) ?? null,
            account: accountUsed,
            input: inputRecord,
            output: {
              text: summary.text || undefined,
              toolCalls: summary.toolCalls.length > 0 ? summary.toolCalls : undefined,
              usage,
              finish_reason: summary.finishReason,
              error: streamError,
            },
            error: streamError,
          });
        }
        return;
      }

      /* 非流式 JSON 响应 */
      const bodyText = result.bodyText ?? '';
      const firstByteAt = Date.now();
      res.writeHead(result.status, {
        'content-type': result.contentType || 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(bodyText),
      });
      res.end(bodyText);

      if (requests) {
        let parsedRawJson: unknown;
        let responseText = '';
        let toolCalls: unknown[] = [];
        let finishReason: string | undefined;
        let errorMsg: string | undefined;
        try {
          const json = JSON.parse(bodyText) as Record<string, unknown>;
          parsedRawJson = json;
          const extracted = extractAnthropicMessageText(json);
          responseText = extracted.text;
          toolCalls = extracted.toolCalls;
          finishReason = extracted.finishReason;
          if (json.error && typeof json.error === 'object') {
            const errObj = json.error as { message?: unknown };
            errorMsg = typeof errObj.message === 'string' ? errObj.message : JSON.stringify(json.error);
          }
        } catch {
          if (result.status >= 400) errorMsg = bodyText.slice(0, 500);
        }

        const recorded = pool?.getRequestUsage(reqId);
        const usage = formatUsageForRecord(
          recorded ?? (parsedRawJson ? parseAnthropicUsage((parsedRawJson as { usage?: unknown }).usage) : null),
        );
        const accountUsed = pool?.getRequestAccount(reqId) ?? pool?.getLastUsedAccount() ?? null;

        requests.add({
          id: reqId,
          timestamp: startTime,
          method,
          path,
          clientIp,
          keyId,
          keyName,
          keyMasked,
          model: modelName,
          stream: false,
          status: result.status,
          durationMs: Date.now() - startTime,
          firstByteMs: firstByteAt - startTime,
          transit: pool?.getRequestTransit(reqId) ?? null,
          account: accountUsed,
          input: inputRecord,
          output: {
            text: responseText || undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            usage,
            finish_reason: finishReason,
            error: errorMsg,
            raw: parsedRawJson,
          },
          error: errorMsg || (result.status >= 400 ? `HTTP ${result.status}` : undefined),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status =
        ac.signal.aborted
          ? 499
          : err instanceof UpstreamError && err.status
            ? err.status
            : err instanceof CredentialError
              ? 502
              : 502;
      const rawBody = err instanceof UpstreamError ? err.rawBody : undefined;

      if (!ac.signal.aborted) {
        log(`[反代错误] ${message}`);
      }

      requests?.add({
        id: reqId,
        timestamp: startTime,
        method,
        path,
        clientIp,
        keyId,
        keyName,
        keyMasked,
        model: modelName,
        stream: wantsStream,
        status,
        durationMs: Date.now() - startTime,
        transit: pool?.getRequestTransit(reqId) ?? null,
        account: pool?.getRequestAccount(reqId) ?? pool?.getLastUsedAccount() ?? null,
        input: inputRecord,
        error: ac.signal.aborted ? '客户端提前断开连接' : message,
      });

      if (!ac.signal.aborted) {
        if (!res.headersSent) {
          sendAnthropicError(res, status, message, rawBody);
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    } finally {
      res.off('close', onResClose);
    }
  };
}

export interface ProxyServerOptions {
  host: string;
  port: number;
  adapter: MmcodeAdapter;
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
 * 与 `mmcode web` 共用同一套 `createProxyHandler`（无内部环回）。
 */
export async function startProxyServer(opts: ProxyServerOptions): Promise<ProxyServerHandle> {
  const log = opts.log ?? ((line: string) => process.stdout.write(line + '\n'));
  const handler = createProxyHandler({
    adapter: opts.adapter,
    keys: opts.keys,
    pool: opts.pool,
    requests: opts.requests,
    log,
    verbose: opts.verbose,
  });

  const server = createServer((req, res) => {
    void handler(req, res).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log(`[错误] ${message}`);
      if (!res.headersSent) {
        sendAnthropicError(res, 502, message);
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolvePromise());
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;

  return {
    port,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        setTimeout(() => done(), 3000).unref?.();
      }),
  };
}
