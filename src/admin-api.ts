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
 *   POST   /admin/api/accounts/reorder   { order: [name, ...] } → 调整账号展示顺序
 *   PATCH  /admin/api/accounts/:name     { enabled?, checkinEnabled?, notes?, region?, priority? }
 *   DELETE /admin/api/accounts/:name     删除账号（含令牌文件）
 *   POST   /admin/api/accounts/:name/login    发起设备授权 → 返回短码与链接
 *   GET    /admin/api/accounts/:name/login    查授权进度（非阻塞单次轮询）
 *   POST   /admin/api/accounts/:name/logout   清除该账号令牌
 *   POST   /admin/api/accounts/:name/checkin  签到
 *   GET    /admin/api/accounts/:name/credits  积分账本
 *   GET    /admin/api/accounts/:name/doctor   单账号体检
 *   GET    /admin/api/config              总体配置（调度模式/优先级分层/额度阈值/入站密钥打码）
 *   POST   /admin/api/config              { mode?, creditsThreshold? }
 *   GET    /admin/api/insights             用量洞察：各账号 token 消耗（输入/输出/缓存命中）
 *   POST   /admin/api/insights/reset      { name? } → 清空统计（不带 name = 全清）
 *   POST   /admin/api/credits/refresh     立即刷新各账号余额（按阈值冻结/解冻）
 *   POST   /admin/api/admin-key           { currentKey, newKey } → 改管理密钥
 *   GET    /admin/api/proxy                反代运行状态
 */

import { existsSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Adapter } from 'waygate-core';
import type { MmcodeAdapter } from './adapter.js';
import { aggregateAnthropicSseToMessage, extractAnthropicMessageText } from './protocol/usage.js';
import {
  adminKeyPath,
  changeAdminKey,
  ensureAdminKey,
  maskAdminKey,
  setAdminKey,
  SessionStore,
  verifyAdminKey,
  SESSION_TTL_SECONDS,
} from './admin.js';
import { AccountStore, DEFAULT_ACCOUNT_NAME, resolveAccountDir, type PoolMode } from './accounts.js';
import { AccountPool, type PoolAccount } from './pool.js';
import { maskInboundKey, type KeyRegistry } from './keys.js';
import type { InsightsLedger } from './insights.js';
import {
  credentialPath,
  loginStatePath,
  pollDeviceLoginOnce,
  readLoginState,
  startDeviceLogin,
  type MinimaxRegion,
} from './credential.js';
import { MinimaxActivity } from './activity.js';
import { refreshCreditsForAll } from './credits-refresh.js';
import { CredentialError } from './errors.js';
import type { RequestStore } from './requests.js';
import type { SchedulerService } from './scheduler.js';

export const SESSION_COOKIE = 'mmcode_session';

/** 账号名白名单：只允许字母数字下划线连字符，且不含路径分隔符（防目录穿越）。 */
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export interface AdminApiContext {
  pool: AccountPool;
  sessions: SessionStore;
  adapter: Adapter | MmcodeAdapter;
  /** 入站密钥注册表（客户端用的那些 token）。 */
  keys: KeyRegistry;
  /** 反代入站密钥（展示时打码）。 */
  apiKey: string;
  version: string;
  log: (line: string) => void;
  /** 反代运行状态。 */
  proxyStatus: () => { port: number; upstream: string; accounts: number; available: number; baseUrl?: string };
  requests?: RequestStore;
  scheduler?: SchedulerService;
  /** 用量台账（洞察面板的数据源）。 */
  insights?: InsightsLedger;
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
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure}`,
  );
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

/** 账号对外视图（**绝不回显令牌**）。 */
function accountView(a: PoolAccount): Record<string, unknown> {
  const cooling = typeof a.record.disabledUntil === 'number' && a.record.disabledUntil > Date.now();
  const frozen = a.record.frozen === true;
  return {
    name: a.record.name,
    region: a.record.region,
    enabled: a.record.enabled,
    checkinEnabled: a.record.checkinEnabled !== false,
    /** 优先级层（数字越小越优先）。 */
    priority: a.record.priority,
    /** 额度冻结中（不参与调度）。 */
    frozen,
    frozenReason: a.record.frozenReason ?? null,
    frozenUntil: a.record.frozenUntil ?? null,
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

  /** 当前请求是否已鉴权。若携带合法会话 cookie，会自动重发 Set-Cookie 刷新有效期至 3 天。 */
  const authenticated = (req: IncomingMessage, res?: ServerResponse): boolean => {
    const headerKey = req.headers['x-admin-key'];
    if (typeof headerKey === 'string' && verifyAdminKey(headerKey)) return true;
    const cookie = readCookie(req, SESSION_COOKIE);
    const valid = ctx.sessions.verify(cookie);
    if (valid && cookie && res && !res.headersSent) {
      setSessionCookie(req, res, cookie);
    }
    return valid;
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
          authenticated: authenticated(req, res),
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
    if (!authenticated(req, res)) {
      sendJson(res, 401, { error: '未登录或会话已过期，请用管理密钥登录' });
      return true;
    }

    try {
      /* ── 账号列表 ── */
      if (route === 'accounts' && method === 'GET') {
        const accounts = ctx.pool.refresh().map(accountView);
        sendJson(res, 200, {
          accounts,
          mode: store.mode(),
          creditsThreshold: store.creditsThreshold(),
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

      /* ── 调整账号展示顺序 ──
         注意：这里只改**注册表里的排列顺序**（管理页看到什么就是什么），
         调度优先级仍由每个账号自己的 `priority` 字段决定。 */
      if (route === 'accounts/reorder' && method === 'POST') {
        const body = await readJsonBody(req);
        const raw = Array.isArray(body.order) ? body.order : [];
        const order = raw.filter((n): n is string => typeof n === 'string' && n.length > 0);
        const accounts = store.reorder(order).map((rec) => {
          const found = ctx.pool.get(rec.name);
          return found ? accountView(found) : rec;
        });
        sendJson(res, 200, { ok: true, accounts });
        return true;
      }

      /* ── 入站密钥（客户端 token）的生成与管理 ── */
      if (route === 'keys' && method === 'GET') {
        /* 返回**明文**密钥 —— 管理页要支持「点击复制」，不给明文就没法复制。
           该接口受管理密钥/会话保护，浏览器本地不落盘。 */
        sendJson(res, 200, {
          keys: ctx.keys.list().map((k) => ({ ...k, masked: maskInboundKey(k.key) })),
          primaryId: ctx.keys.primary()?.id ?? null,
        });
        return true;
      }

      if (route === 'keys' && method === 'POST') {
        const body = await readJsonBody(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const purpose = typeof body.purpose === 'string' ? body.purpose.slice(0, 200) : undefined;
        const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : null;
        const created = ctx.keys.create(name, { purpose, expiresAt });
        sendJson(res, 200, { ok: true, key: { ...created, masked: maskInboundKey(created.key) } });
        return true;
      }

      const keyMatch = /^keys\/([^/]+)(?:\/(.+))?$/.exec(route);
      if (keyMatch) {
        const id = decodeURIComponent(keyMatch[1] ?? '');
        const action = keyMatch[2] ?? '';

        if (!action && method === 'PATCH') {
          const body = await readJsonBody(req);
          const patch: Record<string, unknown> = {};
          if (typeof body.name === 'string') patch.name = body.name;
          if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
          if (typeof body.purpose === 'string') patch.purpose = body.purpose;
          if ('expiresAt' in body) patch.expiresAt = body.expiresAt === null ? null : Number(body.expiresAt);
          const updated = ctx.keys.update(id, patch);
          if (!updated) {
            sendJson(res, 404, { error: `没有密钥 [${id}]` });
            return true;
          }
          sendJson(res, 200, { ok: true, key: { ...updated, masked: maskInboundKey(updated.key) } });
          return true;
        }

        /* 轮换：保留名字与元信息，换一把新的密钥本体。 */
        if (action === 'rotate' && method === 'POST') {
          const rotated = ctx.keys.rotate(id);
          if (!rotated) {
            sendJson(res, 404, { error: `没有密钥 [${id}]` });
            return true;
          }
          sendJson(res, 200, { ok: true, key: { ...rotated, masked: maskInboundKey(rotated.key) } });
          return true;
        }

        if (!action && method === 'DELETE') {
          const ok = ctx.keys.revoke(id);
          if (!ok) {
            sendJson(res, 404, { error: `没有密钥 [${id}]` });
            return true;
          }
          sendJson(res, 200, { ok: true });
          return true;
        }

        sendJson(res, 404, { error: `未知密钥操作 ${action}` });
        return true;
      }

      /* ── 单账号操作 ── */
      const accountMatch = /^accounts\/([^/]+)(?:\/(.+))?$/.exec(route);      if (accountMatch) {
        const name = decodeURIComponent(accountMatch[1] ?? '');
        const action = accountMatch[2] ?? '';

        /* 更新（启用/停用、备注、区域、优先级） */
        if (!action && method === 'PATCH') {
          const body = await readJsonBody(req);
          const patch: Record<string, unknown> = {};
          if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
          if (typeof body.checkinEnabled === 'boolean') patch.checkinEnabled = body.checkinEnabled;
          if (typeof body.notes === 'string') patch.notes = body.notes.slice(0, 500);
          if (body.region === 'global' || body.region === 'cn') patch.region = body.region;
          /* 优先级层：数字越小越优先。 */
          if (typeof body.priority === 'number' && Number.isFinite(body.priority)) {
            patch.priority = Math.max(0, Math.min(99, Math.trunc(body.priority)));
          }
          /* 额度冻结可手动解除。 */
          if (body.frozen === false) {
            patch.frozen = false;
            patch.frozenReason = undefined;
            patch.frozenUntil = undefined;
          } else if (body.frozen === true) {
            patch.frozen = true;
            patch.frozenReason = typeof body.frozenReason === 'string' ? body.frozenReason.slice(0, 300) : '手动冻结';
            patch.frozenUntil = undefined;
          }
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
          const found = mustFind(name);
          const explicitRegion = body.region === 'global' ? 'global' : body.region === 'cn' ? 'cn' : undefined;
          const region: MinimaxRegion = explicitRegion ?? found.record.region ?? 'cn';
          if (explicitRegion && explicitRegion !== found.record.region) store.update(name, { region: explicitRegion });
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
        const tiers = ctx.pool.tiers().map((tier) => tier.map((a) => a.record.name));
        sendJson(res, 200, {
          mode: store.mode(),
          creditsThreshold: store.creditsThreshold(),
          tiers,
          apiKeyMasked: maskAdminKey(ctx.apiKey),
          accounts: accounts.length,
          available: ctx.pool.available().length,
          sessions: Object.values(ctx.pool.sessionCounts()).reduce((s, n) => s + n, 0),
          adminKeyPath: adminKeyPath(),
          proxy: ctx.proxyStatus(),
          version: ctx.version,
          /* 客户端接入信息（复制用）。 */
          client: {
            baseUrl: ctx.proxyStatus().baseUrl ?? null,
            primaryKey: ctx.keys.primaryKey(),
            primaryKeyMasked: ctx.keys.primary() ? maskInboundKey(ctx.keys.primaryKey() ?? '') : null,
            keyCount: ctx.keys.list().length,
          },
        });
        return true;
      }

      if (route === 'config' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body.mode === 'max-cache' || body.mode === 'balanced') {
          store.setMode(body.mode as PoolMode);
        }
        if (typeof body.creditsThreshold === 'number' && Number.isFinite(body.creditsThreshold)) {
          store.setCreditsThreshold(body.creditsThreshold);
        }
        sendJson(res, 200, {
          ok: true,
          mode: store.mode(),
          creditsThreshold: store.creditsThreshold(),
        });
        return true;
      }

      /* ── 修改管理密钥 ── */
      if (route === 'admin-key' && method === 'POST') {
        const body = await readJsonBody(req);
        const newKey = typeof body.newKey === 'string' ? body.newKey : '';
        const changed = setAdminKey(newKey);
        if (!changed) {
          sendJson(res, 400, { error: '新管理密钥不合法：至少 6 个字符' });
          return true;
        }
        /* 改密钥 ⇒ 所有旧会话立刻失效。 */
        ctx.sessions.clear();
        sendJson(res, 200, { ok: true, key: changed, message: '管理密钥已更新，请用新密钥重新登录' });
        return true;
      }

      /* ── 反代状态 ── */
      if (route === 'proxy' && method === 'GET') {
        sendJson(res, 200, ctx.proxyStatus());
        return true;
      }

      /* ── 反代：解除冷却 ── */
      if (route === 'proxy/reset-cooldown' && method === 'POST') {
        const body = await readJsonBody(req);
        const name = typeof body.name === 'string' && body.name ? body.name : undefined;
        ctx.pool.resetCooldown(name);
        sendJson(res, 200, { ok: true });
        return true;
      }

      /* ── 反代：拉取模型列表 ── */
      if (route === 'proxy/models' && method === 'GET') {
        const models = (await ctx.adapter.listModels?.()) ?? [];
        sendJson(res, 200, { models });
        return true;
      }

      /* ── 反代：快速在线调试 ── */
      if (route === 'proxy/test' && method === 'POST') {
        const body = await readJsonBody(req);
        const model = typeof body.model === 'string' ? body.model : 'MiniMax-M3';
        const prompt = typeof body.prompt === 'string' ? body.prompt : 'Hi, please say hello!';
        const start = Date.now();
        try {
          let status = 200;
          let responseText = '';
          if ('messages' in ctx.adapter && typeof ctx.adapter.messages === 'function') {
            const result = await ctx.adapter.messages(
              {
                model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 1024,
                stream: false,
              },
              AbortSignal.timeout(30_000),
            );
            status = result.status;
            if (result.bodyText) {
              try {
                const parsed = JSON.parse(result.bodyText);
                const extracted = extractAnthropicMessageText(parsed);
                responseText = extracted.text || result.bodyText;
              } catch {
                responseText = result.bodyText;
              }
            } else if (result.stream) {
              const msg = await aggregateAnthropicSseToMessage(result.stream, model);
              responseText = extractAnthropicMessageText(msg).text || JSON.stringify(msg);
            }
          } else {
            const result = await ctx.adapter.chat(
              {
                model,
                messages: [{ role: 'user', content: prompt }],
                stream: false,
              },
              AbortSignal.timeout(30_000),
            );
            status = result.status;
            if (result.stream) {
              const reader = result.stream.getReader();
              const decoder = new TextDecoder();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                responseText += decoder.decode(value, { stream: true });
              }
            }
          }
          sendJson(res, 200, {
            ok: true,
            status,
            durationMs: Date.now() - start,
            response: responseText,
            account: ctx.pool.getLastUsedAccount(),
          });
        } catch (err) {
          sendJson(res, 200, {
            ok: false,
            durationMs: Date.now() - start,
            error: (err as Error).message,
            account: ctx.pool.getLastUsedAccount(),
          });
        }
        return true;
      }

      /* ── 请求日志列表 ── */
      if (route === 'requests' && method === 'GET') {
        if (!ctx.requests) {
          sendJson(res, 200, { items: [], total: 0 });
          return true;
        }
        const parsedUrl = new URL(url, 'http://127.0.0.1');
        const since = parsedUrl.searchParams.get('since') ? Number(parsedUrl.searchParams.get('since')) : undefined;
        const limit = parsedUrl.searchParams.get('limit') ? Number(parsedUrl.searchParams.get('limit')) : undefined;
        const offset = parsedUrl.searchParams.get('offset') ? Number(parsedUrl.searchParams.get('offset')) : undefined;
        const status = parsedUrl.searchParams.get('status') as 'all' | 'success' | 'error' | null;
        const model = parsedUrl.searchParams.get('model') || undefined;
        const account = parsedUrl.searchParams.get('account') || undefined;
        const search = parsedUrl.searchParams.get('search') || undefined;

        const data = ctx.requests.list({
          since,
          limit,
          offset,
          status: status || undefined,
          model,
          account,
          search,
        });
        sendJson(res, 200, data);
        return true;
      }

      /* ── 洞察：各账号 token 用量台账 ── */
      if (route === 'insights' && method === 'GET') {
        const ledger = ctx.insights;
        sendJson(res, 200, {
          accounts: ledger ? ledger.snapshot() : [],
          totals: ledger
            ? ledger.totals()
            : {
                accounts: 0,
                requests: 0,
                sessions: 0,
                promptTokens: 0,
                completionTokens: 0,
                cachedTokens: 0,
                totalTokens: 0,
              },
          /* 当前各账号绑定的 session 数（调度侧视角）。 */
          sessions: ctx.pool.sessionCounts(),
          mode: store.mode(),
          creditsThreshold: store.creditsThreshold(),
        });
        return true;
      }

      /* ── 洞察：清空统计 ── */
      if (route === 'insights/reset' && method === 'POST') {
        const body = await readJsonBody(req);
        const name = typeof body.name === 'string' ? body.name : '';
        if (!ctx.insights) {
          sendJson(res, 200, { ok: true, note: '台账未启用' });
          return true;
        }
        if (name) ctx.insights.resetAccount(name);
        else ctx.insights.resetAll();
        sendJson(res, 200, { ok: true });
        return true;
      }

      /* ── 额度：立即刷新所有账号余额（并按阈值冻结/解冻） ── */
      if (route === 'credits/refresh' && method === 'POST') {
        /* 走调度器的口径（带退避 + 防重入）—— 手动点也不该绕开退避，
           否则连点几下就能把上游打爆。 */
        const results = ctx.scheduler
          ? await ctx.scheduler.checkCreditsAll()
          : await refreshCreditsForAll(ctx.pool, ctx.log);
        /* 空数组 = 已有巡检在跑（防重入挡下了）—— 说清楚，别让前端显示成「0 个账号」。 */
        const busy = results.length === 0 && ctx.scheduler !== undefined;
        sendJson(res, 200, {
          ok: true,
          busy,
          note: busy ? '已有额度巡检在进行中，本次未重复执行' : undefined,
          results,
        });
        return true;
      }

      /* ── 清空请求日志 ── */
      if (route === 'requests' && method === 'DELETE') {
        ctx.requests?.clear();
        sendJson(res, 200, { ok: true });
        return true;
      }

      /* ── 请求统计 ── */
      if (route === 'requests-stats' && method === 'GET') {
        const stats = ctx.requests?.stats() ?? {
          totalLogged: 0,
          cachedCount: 0,
          successCount: 0,
          errorCount: 0,
          avgDurationMs: 0,
          totalTokens: { prompt: 0, completion: 0, total: 0 },
          oldestTimestamp: null,
          estimatedMemoryBytes: 0,
          config: { maxItems: 200, retentionMs: 86400000 },
        };
        sendJson(res, 200, stats);
        return true;
      }

      /* ── 请求存储与缓存配置 ── */
      if (route === 'requests-config' && method === 'POST') {
        const body = await readJsonBody(req);
        const config = ctx.requests?.updateConfig(body as any);
        sendJson(res, 200, { ok: true, config });
        return true;
      }

      /* ── 单条请求详情 ── */
      const reqDetailMatch = /^requests\/([^/]+)$/.exec(route);
      if (reqDetailMatch && method === 'GET') {
        const id = decodeURIComponent(reqDetailMatch[1] ?? '');
        const item = ctx.requests?.get(id);
        if (!item) {
          sendJson(res, 404, { error: `未找到请求记录 [${id}]` });
          return true;
        }
        sendJson(res, 200, { ok: true, request: item });
        return true;
      }

      /* ── 调度器状态 ── */
      if (route === 'scheduler' && method === 'GET') {
        sendJson(res, 200, ctx.scheduler?.getStatus() ?? {});
        return true;
      }

      /* ── 调度器配置 ── */
      if (route === 'scheduler/config' && method === 'POST') {
        const body = await readJsonBody(req);
        const config = ctx.scheduler?.updateConfig(body as any);
        sendJson(res, 200, { ok: true, config });
        return true;
      }

      /* ── 调度器：立即全员签到 ── */
      if (route === 'scheduler/checkin-all' && method === 'POST') {
        const results = await ctx.scheduler?.checkinAll();
        sendJson(res, 200, { ok: true, results: results ?? [] });
        return true;
      }

      /* ── 调度器：立即全员刷新令牌 ── */
      if (route === 'scheduler/refresh-all' && method === 'POST') {
        const body = await readJsonBody(req);
        const results = await ctx.scheduler?.refreshAll(Boolean(body.force));
        sendJson(res, 200, { ok: true, results: results ?? [] });
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
