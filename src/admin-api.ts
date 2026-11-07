/**
 * 管理 API —— 静态管理网页的后端。
 *
 * ## 鉴权模型（两层）
 *   · **管理密钥**（`~/.waygate/mmcode/admin.json`）：进管理页的门票。
 *     可用 `X-Admin-Key` 头直接带，也可用会话 Cookie（`mmcode_session`）。
 *   · **反代入站密钥**（`~/.waygate/mmcode/key`）：调模型用的，与本文件无关。
 *
 * 会话 Cookie 是 HttpOnly 的（网页 JS 读不到），密钥本身**只**在登录时由用户输入、
 * 交给服务端换取会话 —— 浏览器本地不落密钥。
 *
 * ## 路由表
 *   GET    /admin/api/session            当前登录态 + 密钥文件位置
 *   POST   /admin/api/session            { adminKey } → 换会话
 *   DELETE /admin/api/session            登出
 *   GET    /admin/api/accounts           账号列表（含状态）
 *   POST   /admin/api/accounts           { name, region } → 新增/登记账号
 *   PATCH  /admin/api/accounts/:name     { enabled?, notes?, region? }
 *   DELETE /admin/api/accounts/:name     删除账号（含令牌文件）
 *   POST   /admin/api/accounts/:name/login    发起设备授权 → 返回短码与链接
 *   GET    /admin/api/accounts/:name/login    查授权进度（非阻塞单次轮询）
 *   POST   /admin/api/accounts/:name/logout   清除该账号令牌
 *   POST   /admin/api/accounts/:name/checkin  签到
 *   GET    /admin/api/accounts/:name/credits  积分账本
 *   GET    /admin/api/accounts/:name/doctor   单账号体检
 *   GET    /admin/api/config              总体配置（策略/粘性账号/入站密钥打码）
 *   POST   /admin/api/config              { strategy?, active? }
 *   POST   /admin/api/admin-key           { currentKey, newKey } → 改管理密钥
 *   GET    /admin/api/proxy                反代运行状态
 */

import { existsSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Adapter } from 'waygate-core';
import {
  adminKeyPath,
  changeAdminKey,
  ensureAdminKey,
  maskAdminKey,
  SessionStore,
  verifyAdminKey,
} from './admin.js';
import { AccountStore, DEFAULT_ACCOUNT_NAME, resolveAccountDir, type PoolStrategy } from './accounts.js';
import { AccountPool, type PoolAccount } from './pool.js';
import {
  credentialPath,
  loginStatePath,
  pollDeviceLoginOnce,
  readLoginState,
  startDeviceLogin,
  type MinimaxRegion,
} from './credential.js';
import { MinimaxActivity } from './activity.js';
import { CredentialError } from './errors.js';

export const SESSION_COOKIE = 'mmcode_session';

/** 账号名白名单：只允许字母数字下划线连字符，且不含路径分隔符（防目录穿越）。 */
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export interface AdminApiContext {
  pool: AccountPool;
  sessions: SessionStore;
  adapter: Adapter;
  /** 反代入站密钥（展示时打码）。 */
  apiKey: string;
  version: string;
  log: (line: string) => void;
  /** 反代运行状态。 */
  proxyStatus: () => { port: number; upstream: string; accounts: number; available: number };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage, limitBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw new Error('请求体过大');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function setSessionCookie(req: IncomingMessage, res: ServerResponse, token: string): void {
  const secure = (req.headers['x-forwarded-proto'] ?? '') === 'https' ? '; Secure' : '';
  res.setHeader(
    'set-cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`,
  );
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

/** 账号对外视图（**绝不回显令牌**）。 */
function accountView(a: PoolAccount): Record<string, unknown> {
  const cooling = typeof a.record.disabledUntil === 'number' && a.record.disabledUntil > Date.now();
  return {
    name: a.record.name,
    region: a.record.region,
    enabled: a.record.enabled,
    loggedIn: a.credential !== null,
    account: a.credential?.account ?? null,
    tokenExpiresAt: a.credential?.expiresAt ?? null,
    health: a.record.health,
    healthDetail: a.record.healthDetail ?? null,
    cooling,
    disabledUntil: cooling ? a.record.disabledUntil : null,
    lastUsedAt: a.record.lastUsedAt ?? null,
    lastCheckin: a.record.lastCheckin ?? null,
    lastCredits: a.record.lastCredits ?? null,
    notes: a.record.notes ?? '',
    createdAt: a.record.createdAt,
    updatedAt: a.record.updatedAt,
    credentialPath: credentialPath(a.dir),
    pendingLogin: readLoginState(a.dir) !== null,
    isDefault: a.record.name === DEFAULT_ACCOUNT_NAME,
  };
}

/**
 * 生成管理 API 处理器。
 *
 * 返回的函数返回 `true` 表示「这个请求已处理」，`false` 表示「不归我管，请走别的路由」。
 */
export function createAdminApi(ctx: AdminApiContext): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const store: AccountStore = ctx.pool.getAccountStore();

  /** 当前请求是否已鉴权。 */
  const authenticated = (req: IncomingMessage): boolean => {
    const headerKey = req.headers['x-admin-key'];
    if (typeof headerKey === 'string' && verifyAdminKey(headerKey)) return true;
    const cookie = readCookie(req, SESSION_COOKIE);
    return ctx.sessions.verify(cookie);
  };

  /** 找账号（不存在 → 抛 404）。 */
  const mustFind = (name: string): PoolAccount => {
    const found = ctx.pool.get(name);
    if (!found) throw new CredentialError(`没有账号 [${name}]`);
    return found;
  };

  return async function handleAdminApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '';
    if (!path.startsWith('/admin/api/')) return false;
    const route = path.slice('/admin/api/'.length).replace(/\/+$/, '');
    const method = req.method ?? 'GET';

    /* ── 会话相关：不要求已鉴权（否则没法登录） ── */
    if (route === 'session') {
      if (method === 'GET') {
        const keyFile = ensureAdminKey();
        sendJson(res, 200, {
          authenticated: authenticated(req),
          adminKeyPath: keyFile.path,
          adminKeyConfigured: true,
          version: ctx.version,
        });
        return true;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const key = typeof body.adminKey === 'string' ? body.adminKey : '';
        if (!verifyAdminKey(key)) {
          sendJson(res, 401, { error: '管理密钥不正确' });
          return true;
        }
        const token = ctx.sessions.create();
        setSessionCookie(req, res, token);
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (method === 'DELETE') {
        ctx.sessions.revoke(readCookie(req, SESSION_COOKIE));
        clearSessionCookie(res);
        sendJson(res, 200, { ok: true });
        return true;
      }
      sendJson(res, 405, { error: '方法不允许' });
      return true;
    }

    /* ── 以下全部要求鉴权 ── */
    if (!authenticated(req)) {
      sendJson(res, 401, { error: '未登录或会话已过期，请用管理密钥登录' });
      return true;
    }

    try {
      /* ── 账号列表 ── */
      if (route === 'accounts' && method === 'GET') {
        const accounts = ctx.pool.refresh().map(accountView);
        sendJson(res, 200, {
          accounts,
          strategy: store.strategy(),
          active: store.activeName(),
        });
        return true;
      }

      /* ── 新增 / 登记账号 ── */
      if (route === 'accounts' && method === 'POST') {
        const body = await readJsonBody(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!NAME_RE.test(name)) {
          sendJson(res, 400, { error: '账号名非法：只允许 1–32 位的字母、数字、下划线、连字符' });
          return true;
        }
        const region: MinimaxRegion = body.region === 'global' ? 'global' : 'cn';
        const record = store.upsert(name, region);
        const found = ctx.pool.get(name);
        sendJson(res, 200, { ok: true, account: found ? accountView(found) : record });
        return true;
      }

      /* ── 单账号操作 ── */
      const accountMatch = /^accounts\/([^/]+)(?:\/(.+))?$/.exec(route);
      if (accountMatch) {
        const name = decodeURIComponent(accountMatch[1] ?? '');
        const action = accountMatch[2] ?? '';

        /* 更新（启用/停用、备注、区域） */
        if (!action && method === 'PATCH') {
          const body = await readJsonBody(req);
          const patch: Record<string, unknown> = {};
          if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
          if (typeof body.notes === 'string') patch.notes = body.notes.slice(0, 500);
          if (body.region === 'global' || body.region === 'cn') patch.region = body.region;
          /* 账号可能已存在于磁盘但还没登记进注册表 —— 先 upsert 再改，
             否则「停用一个刚建好的账号」会 404（upsert 不覆盖已有状态）。 */
          store.upsert(name, body.region === 'global' || body.region === 'cn' ? body.region : undefined);
          const updated = store.update(name, patch);
          if (!updated) {
            sendJson(res, 404, { error: `没有账号 [${name}]` });
            return true;
          }
          const found = ctx.pool.get(name);
          sendJson(res, 200, { ok: true, account: found ? accountView(found) : updated });
          return true;
        }

        /* 删除账号（含令牌文件） */
        if (!action && method === 'DELETE') {
          const found = ctx.pool.get(name);
          if (!found) {
            sendJson(res, 404, { error: `没有账号 [${name}]` });
            return true;
          }
          try {
            rmSync(found.dir, { recursive: true, force: true });
          } catch (err) {
            ctx.log(`删除账号目录失败 [${name}]：${(err as Error).message}`);
          }
          store.remove(name);
          sendJson(res, 200, { ok: true });
          return true;
        }

        /* 发起设备授权 */
        if (action === 'login' && method === 'POST') {
          const body = await readJsonBody(req);
          const region: MinimaxRegion = body.region === 'global' ? 'global' : 'cn';
          const found = mustFind(name);
          if (region !== found.record.region) store.update(name, { region });
          const state = await startDeviceLogin(region, found.dir);
          sendJson(res, 200, {
            ok: true,
            userCode: state.userCode,
            verificationUriComplete: state.verificationUriComplete,
            expiresAt: state.expiresAt,
            intervalMs: state.intervalMs,
          });
          return true;
        }

        /* 查授权进度（非阻塞） */
        if (action === 'login' && method === 'GET') {
          const found = mustFind(name);
          const status = await pollDeviceLoginOnce(found.dir);
          if (status.status === 'ok') {
            store.upsert(name, status.credential.region);
            store.update(name, { health: 'healthy', healthDetail: undefined, disabledUntil: undefined });
          }
          sendJson(res, 200, status);
          return true;
        }

        /* 清除令牌（登出该账号） */
        if (action === 'logout' && method === 'POST') {
          const found = mustFind(name);
          for (const p of [credentialPath(found.dir), loginStatePath(found.dir)]) {
            try {
              if (existsSync(p)) rmSync(p, { force: true });
            } catch {
              /* 删不掉不算致命 */
            }
          }
          store.update(name, { health: 'unknown', healthDetail: undefined, disabledUntil: undefined });
          sendJson(res, 200, { ok: true });
          return true;
        }

        /* 签到 */
        if (action === 'checkin' && method === 'POST') {
          const found = mustFind(name);
          const activity = new MinimaxActivity(
            () => found.tokens.accessToken(),
            () => found.credential?.region ?? found.record.region,
          );
          const result = await activity.checkin();
          store.update(name, { lastCheckin: { at: Date.now(), ...result } });
          sendJson(res, 200, result);
          return true;
        }

        /* 积分账本 */
        if (action === 'credits' && method === 'GET') {
          const found = mustFind(name);
          const activity = new MinimaxActivity(
            () => found.tokens.accessToken(),
            () => found.credential?.region ?? found.record.region,
          );
          const ledger = await activity.credits();
          store.update(name, {
            lastCredits: {
              at: Date.now(),
              granted: ledger.granted,
              remaining: ledger.remaining,
              consumed: ledger.consumed,
              nextExpireAt: ledger.nextExpireAt,
            },
          });
          sendJson(res, 200, ledger);
          return true;
        }

        /* 单账号体检 */
        if (action === 'doctor' && method === 'GET') {
          const found = mustFind(name);
          const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
          try {
            const t = await found.tokens.accessToken();
            checks.push({ name: '令牌刷新', ok: true, detail: `可刷新（${t.slice(0, 8)}…）` });
          } catch (err) {
            checks.push({ name: '令牌刷新', ok: false, detail: (err as Error).message });
          }
          sendJson(res, 200, { name, checks, credential: accountView(found) });
          return true;
        }

        sendJson(res, 404, { error: `未知账号操作 ${action}` });
        return true;
      }

      /* ── 总体配置 ── */
      if (route === 'config' && method === 'GET') {
        const accounts = ctx.pool.refresh();
        sendJson(res, 200, {
          strategy: store.strategy(),
          active: store.activeName(),
          apiKeyMasked: maskAdminKey(ctx.apiKey),
          apiKeyPath: store ? undefined : undefined,
          accounts: accounts.length,
          available: ctx.pool.available().length,
          adminKeyPath: adminKeyPath(),
          proxy: ctx.proxyStatus(),
          version: ctx.version,
        });
        return true;
      }

      if (route === 'config' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body.strategy === 'sticky' || body.strategy === 'round-robin') {
          store.setStrategy(body.strategy as PoolStrategy);
        }
        if (typeof body.active === 'string' && body.active) {
          if (!ctx.pool.get(body.active)) {
            sendJson(res, 404, { error: `没有账号 [${body.active}]` });
            return true;
          }
          store.setActive(body.active);
        }
        sendJson(res, 200, { ok: true, strategy: store.strategy(), active: store.activeName() });
        return true;
      }

      /* ── 修改管理密钥 ── */
      if (route === 'admin-key' && method === 'POST') {
        const body = await readJsonBody(req);
        const currentKey = typeof body.currentKey === 'string' ? body.currentKey : '';
        const newKey = typeof body.newKey === 'string' ? body.newKey : '';
        if (!verifyAdminKey(currentKey)) {
          sendJson(res, 403, { error: '当前管理密钥不正确' });
          return true;
        }
        const changed = changeAdminKey(currentKey, newKey);
        if (!changed) {
          sendJson(res, 400, { error: '新密钥不合法：至少 16 个字符' });
          return true;
        }
        /* 改密钥 ⇒ 所有旧会话立刻失效（用旧密钥换来的会话也作废）。 */
        ctx.sessions.clear();
        sendJson(res, 200, { ok: true, key: changed, message: '管理密钥已更新，请用新密钥重新登录' });
        return true;
      }

      /* ── 反代状态 ── */
      if (route === 'proxy' && method === 'GET') {
        sendJson(res, 200, ctx.proxyStatus());
        return true;
      }

      sendJson(res, 404, { error: `未知管理接口 ${path}` });
      return true;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      ctx.log(`管理接口出错 ${route}：${message}`);
      sendJson(res, 400, { error: message });
      return true;
    }
  };
}
