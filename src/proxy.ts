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
import type { KeyRegistry } from './keys.js';

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

/** 本请求是否走 Anthropic 出口（决定错误体形状）。 */
function isAnthropicRoute(path: string): boolean {
  const route = path.startsWith('/v1/') ? path.slice(3) : path;
  return route === '/messages';
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
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const provided = extractInboundKey(req);

    if (!keys.accepts(provided)) {
      const message = isAnthropicRoute(path)
        ? '入站密钥缺失或不正确（x-api-key 或 Authorization: Bearer <key>）'
        : '入站密钥缺失或不正确（Authorization: Bearer <key> 或 x-api-key）';
      if (isAnthropicRoute(path)) sendAnthropicError(res, 401, message);
      else sendOpenAiError(res, 401, message, 'invalid_api_key');
      return;
    }
    maybeMark(provided);

    /* 转发到内部 core 服务器，并把鉴权头换成内部密钥。 */
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: `127.0.0.1:${innerPort}` };
    delete headers['x-api-key'];
    headers.authorization = `Bearer ${INTERNAL_KEY}`;

    const preq = httpRequest(
      { host: '127.0.0.1', port: innerPort, method: req.method, path: req.url, headers },
      (pres) => {
        res.writeHead(pres.statusCode ?? 502, pres.headers);
        pres.pipe(res);
        pres.on('error', () => res.destroy());
      },
    );
    preq.on('error', (err) => {
      log(`[反代错误] ${err.message}`);
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
    req.pipe(preq);
  };
}

export interface ProxyServerOptions {
  host: string;
  port: number;
  adapter: Adapter;
  keys: KeyRegistry;
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

  const forward = createProxyForwarder(inner.port, opts.keys, log);
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
