/**
 * 统一 Web 服务 —— **一个端口**同时提供三样东西：
 *
 *   1. **反代**（`/v1/chat/completions`、`/v1/messages`、`/v1/models`）
 *      —— 委托给 `waygate-core` 的 `startServer`（跑在内部环回端口上）。
 *      **不重写协议**：Anthropic ⇄ OpenAI 的转义、SSE 帧编码、非流式聚合
 *      全部沿用 core 的实现 —— 那部分已经过实战验证，重写只会引入回归。
 *      内部多一跳环回请求，代价可忽略，换来的是「协议零重复实现」。
 *
 *   2. **静态管理页**（`/`）—— 纯静态文件，无构建步骤。
 *
 *   3. **管理 API**（`/admin/api/*`）—— 见 `admin-api.ts`。
 *
 * ## 为什么反代要挂在管理页同一个端口
 * Docker 部署只暴露一个端口就够了；客户端（Claude Code / Cursor）配一个
 * `base_url` 就能同时用到「模型」和「管理」。若分成两个端口，用户要配两个地址，
 * 容器也要暴露两个端口 —— 没有收益。
 *
 * ## 鉴权分层（别搞混）
 *   · `/v1/*` 用**入站密钥**（`~/.waygate/mmcode/key`）—— 客户端持有；
 *   · `/admin/api/*` 用**管理密钥**（`~/.waygate/mmcode/admin.json`）—— 只有管理员持有；
 *   · `/healthz` 不鉴权（探活用），但**只回健康状态**，不回任何凭据信息。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type Adapter } from 'waygate-core';
import { AccountPool } from './pool.js';
import { SessionStore, ensureAdminKey, maskAdminKey } from './admin.js';
import { createAdminApi } from './admin-api.js';
import { adminKeyPath } from './admin.js';

export interface WebServerOptions {
  host: string;
  port: number;
  /** 反代入站密钥。 */
  apiKey: string;
  adapter: Adapter;
  pool: AccountPool;
  version: string;
  log?: (line: string) => void;
  verbose?: boolean;
}

export interface WebServerHandle {
  /** 公开端口。 */
  port: number;
  /** 内部反代端口（环回，仅本机）。 */
  proxyPort: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 定位静态资源目录。
 *
 * 候选顺序：
 *   1. `dist/web/`（构建时复制进来的 —— npm 包里走这条）
 *   2. 仓库根 `web/`（开发态直接 `node dist/index.js` 也能找到）
 *   3. `src/web/`（用 tsx 直接跑源码时的兜底）
 */
export function resolveWebRoot(): string | null {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    resolve(join(here, 'web')),
    resolve(join(here, '..', 'web')),
    resolve(join(here, '..', '..', 'web')),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return null;
}

/** 反代路由判定：这些路径交给 core 的服务器处理。 */
function isProxyPath(path: string): boolean {
  if (path.startsWith('/v1/')) return true;
  return path === '/models' || path === '/chat/completions' || path === '/messages';
}

/**
 * 把请求转发到内部反代服务器。
 *
 * 关键点：**客户端断连要传导到内部请求** —— core 的服务器靠 `req` 的
 * `close` 事件中止上游调用；不传导就会留下孤儿的上游请求（继续烧额度）。
 */
function forwardToProxy(proxyPort: number, req: IncomingMessage, res: ServerResponse): void {
  const preq = httpRequest(
    {
      host: '127.0.0.1',
      port: proxyPort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${proxyPort}` },
    },
    (pres) => {
      res.writeHead(pres.statusCode ?? 502, pres.headers);
      pres.pipe(res);
      pres.on('error', () => res.destroy());
    },
  );
  preq.on('error', (err) => {
    if (!res.headersSent) {
      const text = JSON.stringify({ error: { message: `反代内部错误：${err.message}`, type: 'waygate_error' } });
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(text);
    } else {
      res.destroy();
    }
  });
  res.on('close', () => {
    /* 只有未正常结束才算断连 —— 正常收完别去打断内部请求。 */
    if (!res.writableEnded) preq.destroy();
  });
  req.pipe(preq);
}

export async function startWebServer(opts: WebServerOptions): Promise<WebServerHandle> {
  const log = opts.log ?? ((line: string) => process.stdout.write(line + '\n'));
  const sessions = new SessionStore();

  /* 管理密钥：不存在就生成一个（首次启动会把明文打到日志里）。 */
  const adminKey = ensureAdminKey();

  /* ① 内部反代（环回）。 */
  const proxy = await startServer(opts.adapter, {
    host: '127.0.0.1',
    port: 0,
    apiKey: opts.apiKey,
    verbose: opts.verbose,
    log: (line) => log(line),
  });

  const proxyStatus = () => ({
    port: proxy.port,
    upstream: opts.adapter.upstreamLabel,
    accounts: opts.pool.all().length,
    available: opts.pool.available().length,
  });

  const handleAdmin = createAdminApi({
    pool: opts.pool,
    sessions,
    adapter: opts.adapter,
    apiKey: opts.apiKey,
    version: opts.version,
    log,
    proxyStatus,
  });

  const webRoot = resolveWebRoot();

  /* ② 公开服务器。 */
  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log(`[错误] ${message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message } }));
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';

    /* 健康检查（不鉴权，但只回状态，不回凭据）。 */
    if (path === '/healthz') {
      const body = JSON.stringify({
        ok: true,
        service: opts.adapter.command,
        version: opts.version,
        upstream: opts.adapter.upstreamLabel,
        accounts: opts.pool.all().length,
        available: opts.pool.available().length,
        adminKeyPath: adminKeyPath(),
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }

    /* 管理 API。 */
    if (path.startsWith('/admin/api/')) {
      await handleAdmin(req, res);
      return;
    }

    /* 反代路由。 */
    if (isProxyPath(path)) {
      forwardToProxy(proxy.port, req, res);
      return;
    }

    /* 静态资源。 */
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(path, res);
      return;
    }

    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '方法不允许' }));
  }

  /** 静态文件（含 SPA 回落：未知路径回 index.html）。 */
  function serveStatic(path: string, res: ServerResponse): void {
    if (!webRoot) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('静态资源目录未找到（web/ 缺失）');
      return;
    }
    /* 防目录穿越：解析后必须仍在 webRoot 内。 */
    const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
    let target = resolve(join(webRoot, rel));
    if (target !== webRoot && !target.startsWith(webRoot + sep)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('禁止访问');
      return;
    }
    if (existsSync(target) && statSync(target).isDirectory()) {
      target = join(target, 'index.html');
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      /* SPA 回落。 */
      target = join(webRoot, 'index.html');
      if (!existsSync(target)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('未找到');
        return;
      }
    }
    const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    createReadStream(target).pipe(res);
  }

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      opts.port = port;
      resolvePromise();
    });
  });

  const addr = server.address();
  const publicPort = typeof addr === 'object' && addr ? addr.port : opts.port;

  return {
    port: publicPort,
    proxyPort: proxy.port,
    close: async () => {
      await proxy.close();
      await new Promise<void>((done) => {
        server.close(() => done());
        setTimeout(() => done(), 3000).unref?.();
      });
    },
  };
}
