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
import { InsightsLedger } from './insights.js';
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
    const insights = new InsightsLedger({ filePath: join(root, 'insights.json') });

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
      insights,
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

      return new Promise<{ status: number; body: any; headers: any }>((resolve, reject) => {
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
                resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null, headers: res.headers });
              } catch {
                resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers });
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
      insights,
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

  it('★ GET & POST /admin/api/config：调度模式与额度阈值', async () => {
    const ctx = await setupServer();
    try {
      const before = await ctx.req('/admin/api/config');
      expect(before.status).toBe(200);
      expect(before.body.mode).toBe('max-cache');
      expect(before.body.creditsThreshold).toBe(100);

      const updated = await ctx.req('/admin/api/config', {
        method: 'POST',
        body: { mode: 'balanced', creditsThreshold: 250 },
      });
      expect(updated.status).toBe(200);
      expect(updated.body.mode).toBe('balanced');
      expect(updated.body.creditsThreshold).toBe(250);

      const after = await ctx.req('/admin/api/config');
      expect(after.body.mode).toBe('balanced');
      expect(after.body.creditsThreshold).toBe(250);
    } finally {
      await ctx.close();
    }
  });

  it('★ PATCH /admin/api/accounts/:name 改优先级与冻结', async () => {
    const ctx = await setupServer();
    try {
      await ctx.req('/admin/api/accounts', { method: 'POST', body: { name: 'a1', region: 'cn' } });

      const patched = await ctx.req('/admin/api/accounts/a1', {
        method: 'PATCH',
        body: { priority: 3 },
      });
      expect(patched.status).toBe(200);
      expect(patched.body.account.priority).toBe(3);

      const frozen = await ctx.req('/admin/api/accounts/a1', {
        method: 'PATCH',
        body: { frozen: true, frozenReason: '手动冻结' },
      });
      expect(frozen.body.account.frozen).toBe(true);

      const thawed = await ctx.req('/admin/api/accounts/a1', {
        method: 'PATCH',
        body: { frozen: false },
      });
      expect(thawed.body.account.frozen).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it('★ GET /admin/api/insights 给出各账号 token 用量', async () => {
    const ctx = await setupServer();
    try {
      ctx.insights.record({
        account: 'a1',
        model: 'MiniMax-M3',
        promptTokens: 100,
        completionTokens: 20,
        cachedTokens: 30,
      });

      const res = await ctx.req('/admin/api/insights');
      expect(res.status).toBe(200);
      expect(res.body.accounts.length).toBe(1);
      expect(res.body.accounts[0].name).toBe('a1');
      expect(res.body.accounts[0].totalTokens).toBe(120);
      expect(res.body.totals.requests).toBe(1);

      const reset = await ctx.req('/admin/api/insights/reset', { method: 'POST', body: {} });
      expect(reset.status).toBe(200);
      const after = await ctx.req('/admin/api/insights');
      expect(after.body.accounts.length).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  it('POST /admin/api/credits/refresh 刷新余额（未登录账号标记失败但不影响整体）', async () => {
    const ctx = await setupServer();
    try {
      await ctx.req('/admin/api/accounts', { method: 'POST', body: { name: 'a1', region: 'cn' } });
      const res = await ctx.req('/admin/api/credits/refresh', { method: 'POST', body: {} });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.results.length).toBe(1);
      expect(res.body.results[0].account).toBe('a1');
      /* 没登录 → 取不到余额 → 标记失败（而不是抛错中断整个刷新）。 */
      expect(res.body.results[0].ok).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it('POST /admin/api/session 登录下发 3 天有效期 Cookie，且带 Cookie 访问自动刷新', async () => {
    const ctx = await setupServer();
    try {
      const login = await ctx.req('/admin/api/session', {
        method: 'POST',
        body: { adminKey: ctx.adminKey },
        headers: { 'x-admin-key': '' },
      });
      expect(login.status).toBe(200);
      const setCookie = login.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
      expect(cookieStr).toContain('Max-Age=259200'); // 3 天 = 259200 秒

      // 提取 cookie 值
      const match = cookieStr.match(/mmcode_session=([^;]+)/);
      expect(match).toBeTruthy();
      const cookieHeader = `mmcode_session=${match![1]}`;

      // 使用该 Cookie 发送 GET /admin/api/session
      const check = await ctx.req('/admin/api/session', {
        method: 'GET',
        headers: { 'x-admin-key': '', cookie: cookieHeader },
      });
      expect(check.status).toBe(200);
      expect(check.body.authenticated).toBe(true);
      // 确认响应中刷新了 Cookie
      const refreshCookie = check.headers['set-cookie'];
      expect(refreshCookie).toBeDefined();
      const refreshCookieStr = Array.isArray(refreshCookie) ? refreshCookie[0] : String(refreshCookie);
      expect(refreshCookieStr).toContain('Max-Age=259200');
    } finally {
      await ctx.close();
    }
  });
});
