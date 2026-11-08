import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { createAdminApi, SESSION_COOKIE } from './admin-api.js';
import { AccountStore } from './accounts.js';
import { AccountPool } from './pool.js';
import { KeyRegistry } from './keys.js';
import { SessionStore, ensureAdminKey } from './admin.js';
import { RequestStore } from './requests.js';
import { SchedulerService } from './scheduler.js';
import type { Adapter } from 'waygate-core';

let root = '';
const origHome = process.env.MMCODE_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mmcode-api-test-'));
  process.env.MMCODE_HOME = root;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.MMCODE_HOME;
  else process.env.MMCODE_HOME = origHome;
  rmSync(root, { recursive: true, force: true });
});

describe('Admin API: 新增功能路由测试', () => {
  async function setupServer() {
    const keyFile = ensureAdminKey();
    const adminKey = keyFile.key;
    const store = new AccountStore({ filePath: join(root, 'accounts.json') });
    const pool = new AccountPool(store);
    const keys = new KeyRegistry({ filePath: join(root, 'keys.json') });
    const sessions = new SessionStore();
    const requests = new RequestStore(join(root, 'requests.json'));
    const scheduler = new SchedulerService(pool, { configPath: join(root, 'scheduler.json') });

    const adapter: Adapter = {
      command: 'mmcode',
      displayName: 'MiniMax Code',
      defaultPort: 8788,
      upstreamLabel: 'test-upstream',
      loginHint: 'login',
      async credentialStatus() {
        return { ok: true, detail: 'ok' };
      },
      async login() {},
      async listModels() {
        return [{ id: 'MiniMax-M3', displayName: 'MiniMax M3' }];
      },
      async chat() {
        return { status: 200, stream: new ReadableStream() };
      },
    };

    const handler = createAdminApi({
      pool,
      sessions,
      adapter,
      keys,
      apiKey: 'sk-test',
      version: '0.5.2',
      log: () => {},
      proxyStatus: () => ({ port: 8789, upstream: 'test', accounts: 0, available: 0 }),
      requests,
      scheduler,
    });

    const server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port as number;

    const req = async (path: string, options: { method?: string; body?: any; headers?: Record<string, string> } = {}) => {
      const headers: Record<string, string> = {
        'x-admin-key': adminKey,
        ...(options.headers || {}),
      };
      if (options.body) headers['content-type'] = 'application/json';

      return new Promise<{ status: number; body: any }>((resolve, reject) => {
        const clientReq = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path,
            method: options.method ?? 'GET',
            headers,
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
              try {
                resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null });
              } catch {
                resolve({ status: res.statusCode ?? 0, body: data });
              }
            });
          },
        );
        clientReq.on('error', reject);
        if (options.body) clientReq.write(JSON.stringify(options.body));
        clientReq.end();
      });
    };

    return {
      adminKey,
      requests,
      scheduler,
      pool,
      req,
      close: () => new Promise<void>((done) => server.close(() => done())),
    };
  }

  it('GET /admin/api/requests 列出请求并支持过滤', async () => {
    const ctx = await setupServer();
    try {
      ctx.requests.add({
        id: 'req-1',
        timestamp: Date.now(),
        method: 'POST',
        path: '/v1/chat/completions',
        stream: false,
        status: 200,
        durationMs: 80,
      });

      const res = await ctx.req('/admin/api/requests');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.items[0].id).toBe('req-1');

      const detail = await ctx.req('/admin/api/requests/req-1');
      expect(detail.status).toBe(200);
      expect(detail.body.request.id).toBe('req-1');

      const del = await ctx.req('/admin/api/requests', { method: 'DELETE' });
      expect(del.status).toBe(200);
      expect(ctx.requests.list().total).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  it('GET & POST /admin/api/requests-config 更新缓存上限与保留时长', async () => {
    const ctx = await setupServer();
    try {
      const stats = await ctx.req('/admin/api/requests-stats');
      expect(stats.status).toBe(200);
      expect(stats.body.config.maxItems).toBeGreaterThan(0);

      const update = await ctx.req('/admin/api/requests-config', {
        method: 'POST',
        body: { maxItems: 50, retentionMs: 3600000 },
      });
      expect(update.status).toBe(200);
      expect(update.body.config.maxItems).toBe(50);
      expect(update.body.config.retentionMs).toBe(3600000);
    } finally {
      await ctx.close();
    }
  });

  it('GET & POST /admin/api/scheduler/config 调度器状态与设置', async () => {
    const ctx = await setupServer();
    try {
      const status = await ctx.req('/admin/api/scheduler');
      expect(status.status).toBe(200);
      expect(status.body.autoCheckin.enabled).toBe(true);

      const update = await ctx.req('/admin/api/scheduler/config', {
        method: 'POST',
        body: { autoCheckin: { enabled: false, time: '10:00' } },
      });
      expect(update.status).toBe(200);
      expect(update.body.config.autoCheckin.enabled).toBe(false);
      expect(update.body.config.autoCheckin.time).toBe('10:00');
    } finally {
      await ctx.close();
    }
  });

  it('POST /admin/api/proxy/reset-cooldown 重置冷却与 GET /admin/api/proxy/models 查询模型', async () => {
    const ctx = await setupServer();
    try {
      const reset = await ctx.req('/admin/api/proxy/reset-cooldown', {
        method: 'POST',
        body: {},
      });
      expect(reset.status).toBe(200);
      expect(reset.body.ok).toBe(true);

      const models = await ctx.req('/admin/api/proxy/models');
      expect(models.status).toBe(200);
      expect(models.body.models.length).toBe(1);
      expect(models.body.models[0].id).toBe('MiniMax-M3');
    } finally {
      await ctx.close();
    }
  });
});
