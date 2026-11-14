/**
 * MiniMax Code 适配器：把「官方 OAuth 设备授权登录取到的凭证」变成「本地 Anthropic 兼容反代」。
 *
 * 与 waygate-qoder / waygate-workbuddy 同构，差异在于：
 *   · 凭证：走 **官方 OAuth 设备授权**（`mmcode login`），**不读本机客户端、不解密**；
 *     这样服务器也能自助登录，无需人工注入 token；
 *   · 协议：上游是 **原生 Anthropic 兼容**（`/mavis/api/v1/llm/v1/messages` 与
 *     `/mavis/api/v1/llm/v1/messages/count_tokens`），不再做 OpenAI 往返翻译，完整透传
 *     `system` blocks、`cache_control`、`thinking`、`tools` 与缓存命中 usage；
 *   · ⚠️ 有**凭证互斥**问题（见 README），必须给用户明确告警。
 *
 * ## 多账号与调度（本文件的核心）
 * MiniMax **同一账号只能有一个有效会话** —— 上游 401 通常意味着「这个号在别处登过」，
 * 光重试没用。所以反代必须**手上有多个号**：
 *   · `AccountPool` 负责选号（**按优先级分层 + 同层随机 + 额度冻结**）；
 *   · 本文件的 `messages()` 与 `countTokens()` 共用同一套 **session 选号 + 失败重试** 逻辑：
 *     同一会话先调 `count_tokens` 再调 `messages` 会命中同一个 `sessionKey` 并一对一绑定
 *     同一个账号；遇到 401/403/429 时受调度模式约束自动换号或拒绝迁移；
 *   · 每个账号**各自持有**令牌管理器（各自缓存、各自刷新、各自写回），互不干扰。
 *
 * ## 两种模式（由 `AccountPool.mode()` 决定，全局生效）
 *   · `max-cache`（最大缓存）：session 绑定某账号后**永不迁移** —— 保住上游缓存；
 *   · `balanced`（平衡）：绑定账号额度耗尽 / 不可用时，session **无缝滑到**别的账号。
 *
 * ⚠️ **区域随账号走**：cn 与 global 是两套完全不同的域名，
 *    切号时 base URL 必须跟着换 —— 否则国内号会被打到海外端点上（401/404）。
 */

import {
  type Adapter,
  type ChatRequestBody,
  type CredentialStatus,
  type ModelEntry,
  type UpstreamCallResult,
} from 'waygate-core';
import {
  LOGIN_WAIT_MS,
  PendingLoginError,
  credentialPath,
  credentialSummary,
  getAgentBase,
  pollDeviceLogin,
  readSavedCredential,
  resolveRegion,
  startDeviceLogin,
  type MinimaxRegion,
} from './credential.js';
import { CredentialError, UpstreamError } from './errors.js';
import { MinimaxActivity, renderCheckin, renderCredits } from './activity.js';
import {
  aggregateAnthropicSseToMessage,
  collectAnthropicUsage,
  extractAnthropicJsonUsage,
  type StreamUsage,
} from './protocol/usage.js';
import { AccountStore, DEFAULT_ACCOUNT_NAME, type AccountRecord } from './accounts.js';
import { AccountPool, classifyFailure, type PoolAccount } from './pool.js';
import { resolveSessionKey, stripSessionFields, type RequestContext } from './session.js';
import type { InsightsLedger } from './insights.js';
import { maskInboundKey, type KeyRegistry } from './keys.js';

export const DEFAULT_MMCODE_BASE_URL = 'https://agent.minimax.cn';
export const DEFAULT_MMCODE_CHAT_PATH = '/mavis/api/v1/llm/v1/messages';
export const DEFAULT_MMCODE_COUNT_TOKENS_PATH = '/mavis/api/v1/llm/v1/messages/count_tokens';

export function resolveAdapterBaseUrl(opts: { baseUrl?: string; region?: MinimaxRegion } = {}): string {
  if (opts.baseUrl) return opts.baseUrl.replace(/\/+$/, '');
  const saved = readSavedCredential();
  const region = saved?.region ?? resolveRegion(opts.region);
  return getAgentBase(region);
}

/**
 * MiniMax 内置模型清单 —— **仅作回落**（v0.3.5 起）。
 */
export const MINIMAX_MODELS: ModelEntry[] = [
  { id: 'MiniMax-M3', displayName: 'MiniMax M3' },
  { id: 'MiniMax-M3.1-Flash-Preview', displayName: 'MiniMax M3.1 Flash Preview' },
  { id: 'MiniMax-M2.7', displayName: 'MiniMax M2.7' },
  { id: 'MiniMax-M2.7-highspeed', displayName: 'MiniMax M2.7 Highspeed' },
];

/** 清单端点（相对 baseUrl）。与 chat 端点不同前缀。 */
export const MODELS_PATH = '/mavis/api/v1/models';

/** 拉取超时：清单是启动路径上的调用，不能拖慢 `mmcode serve`。 */
const MODELS_TIMEOUT_MS = 8_000;

/** 上游清单响应（只取我们需要的字段，其余忽略）。 */
interface MinimaxCatalogResponse {
  providers?: Array<{
    providerId?: string;
    config?: { models?: Record<string, { name?: string }> };
  }>;
}

/**
 * 拉上游真清单。失败 / 结构不符 / 空清单 → 返回 null（调用方回落内置清单）。
 *
 * **不带 access token**：实测该端点无需鉴权（带假 token 反而 401）。
 */
export async function pullMinimaxModels(baseUrl: string): Promise<ModelEntry[] | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}${MODELS_PATH}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as MinimaxCatalogResponse;
    const models = body.providers?.find((p) => p.providerId === 'minimax')?.config?.models;
    if (!models || typeof models !== 'object') return null;
    const entries = Object.entries(models)
      .filter(([id]) => typeof id === 'string' && id.length > 0)
      .map(([id, m]) => ({
        id,
        displayName: typeof m?.name === 'string' && m.name ? `MiniMax ${m.name}` : id,
      }));
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

/** 轮询进度行 —— 用 `\r` 覆盖同一行，不刷屏。 */
function tickTo(out: NodeJS.WriteStream): (info: { waitedMs: number; remainingMs: number }) => void {
  return ({ waitedMs, remainingMs }) => {
    const w = Math.round(waitedMs / 1000);
    const r = Math.round(remainingMs / 1000);
    out.write(`\r  ⏳ 等待授权中… ${w}s（最多再等 ${r}s，按 Ctrl+C 可中断）   `);
  };
}

/** 登录成功后必讲的互斥告警 —— 设备授权不解除它。 */
function mutualExclusionNotice(): string {
  return (
    '\n⚠️  凭证互斥（必读）：MiniMax 同一账号只能有一个有效会话。\n' +
    '    请给本工具用**专用账号**，并且**永不用它登桌面客户端或官方 mcode CLI** ——\n' +
    '    只要在别处登录一次，这里的凭证就会被顶掉（表现为 401，需重跑 mmcode login）。\n'
  );
}

/** 原生 Anthropic `/v1/messages` 调用结果。 */
export interface AnthropicCallResult {
  status: number;
  contentType: string;
  /** 流式响应（`text/event-stream`） */
  stream?: ReadableStream<Uint8Array>;
  /** 非流式响应（`application/json`） */
  bodyText?: string;
}

/** 原生 Anthropic `/v1/messages/count_tokens` 调用结果。 */
export interface AnthropicCountTokensResult {
  status: number;
  contentType: string;
  bodyText: string;
}

/** 可选透传的 Anthropic 请求头。 */
export interface AnthropicInboundHeaders {
  anthropicVersion?: string;
  anthropicBeta?: string;
}

/** 扩展后的 MiniMax Code 适配器契约（含原生 Anthropic messages 与 count_tokens）。 */
export interface MmcodeAdapter extends Adapter {
  messages(
    body: Record<string, unknown>,
    signal: AbortSignal,
    ctx?: RequestContext,
    inboundHeaders?: AnthropicInboundHeaders,
  ): Promise<AnthropicCallResult>;
  countTokens(
    body: Record<string, unknown>,
    signal: AbortSignal,
    ctx?: RequestContext,
    inboundHeaders?: AnthropicInboundHeaders,
  ): Promise<AnthropicCountTokensResult>;
}

/** 适配器构造选项。 */
export interface MmcodeAdapterOptions {
  /** 强制指定上游 base（调试用；否则按账号区域推导）。 */
  baseUrl?: string;
  /** Messages 端点路径（默认 Anthropic 兼容路径）。 */
  chatPath?: string;
  /** Count Tokens 端点路径（默认 Anthropic 兼容路径）。 */
  countTokensPath?: string;
  /** 区域兜底（账号未记录区域时用）。 */
  region?: MinimaxRegion;
  /** 账号池（不传则基于默认注册表自建）。 */
  pool?: AccountPool;
  /** 入站密钥注册表（提供后才有 `mmcode keys` 子命令）。 */
  keys?: KeyRegistry;
  /** 用量台账（提供后按账号统计 token —— 洞察面板用）。 */
  insights?: InsightsLedger;
  /** 日志回调。 */
  log?: (line: string) => void;
}

export function createMmcodeAdapter(opts: MmcodeAdapterOptions = {}): MmcodeAdapter {
  const log = opts.log ?? ((line: string) => process.stdout.write(`[mmcode] ${line}\n`));
  const chatPath = opts.chatPath ?? DEFAULT_MMCODE_CHAT_PATH;
  const countTokensPath = opts.countTokensPath ?? DEFAULT_MMCODE_COUNT_TOKENS_PATH;

  /* 账号池：外部可注入（管理端与 CLI 共用一个实例），否则自建。 */
  const pool = opts.pool ?? new AccountPool(new AccountStore(), { log });

  /** 某账号的 base URL —— **区域随账号走**（cn/global 是两套域名）。 */
  const baseUrlFor = (account: PoolAccount): string => {
    if (opts.baseUrl) return opts.baseUrl.replace(/\/+$/, '');
    const region = account.credential?.region ?? account.record.region ?? resolveRegion(opts.region);
    return getAgentBase(region);
  };

  /** 兜底账号 —— 仅供 CLI / 体检这类「要一个账号去问上游」的场景。 */
  const fallbackAccount = (): PoolAccount | null => {
    return pool.available()[0] ?? pool.all()[0] ?? null;
  };

  /** 某账号的签到/积分客户端（用该账号自己的令牌）。 */
  const activityFor = (account: PoolAccount): MinimaxActivity =>
    new MinimaxActivity(
      () => account.tokens.accessToken(),
      () => account.credential?.region ?? account.record.region,
    );

  /** 取账号：指定名字优先；否则用兜底账号。 */
  const pickAccount = (name?: string): PoolAccount | null => {
    if (name) {
      const found = pool.get(name);
      if (found) return found;
      throw new CredentialError(`没有账号 [${name}] —— 先用 \`mmcode accounts\` 看有哪些`);
    }
    return fallbackAccount();
  };

  /**
   * 共享的「按 session 选号 + 401/403/429 自动换号重试」调度引擎。
   *
   * `/v1/messages` 与 `/v1/messages/count_tokens` 共用同一条链路：
   *   1. 通过相同的 `sessionKey` 命中或建立一对一账号绑定；
   *   2. 401/403/429 或网络抖动时，受 `max-cache` / `balanced` 约束触发冷却与换号；
   *   3. 400 / 5xx 等非账号问题直接抛出，不污染健康账号；
   *   4. 客户端断连（`signal.aborted`）直接中止，不惩罚账号。
   */
  async function dispatchWithFailover<T>(params: {
    sessionKey: string;
    ctx: RequestContext;
    upstreamPath: string;
    upstreamPayload: Record<string, unknown>;
    accept: string;
    inboundHeaders?: AnthropicInboundHeaders;
    signal: AbortSignal;
    onSuccess: (res: Response, account: PoolAccount) => Promise<T>;
  }): Promise<T> {
    const { sessionKey, ctx, upstreamPath, upstreamPayload, accept, inboundHeaders, signal, onSuccess } = params;
    const bodyJson = JSON.stringify(upstreamPayload);
    const tried = new Set<string>();
    let lastError: Error | null = null;

    /* 最多试 4 个账号（再多也没意义 —— 用户通常只备了两三个号）。 */
    const maxAttempts = Math.max(1, Math.min(pool.all().length || 1, 4));

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const acquired = pool.acquireForSession(sessionKey);
      if (!acquired.ok) {
        if (acquired.reason === 'pinned') {
          const pinned = acquired.pinnedAccount ? pool.get(acquired.pinnedAccount) : null;
          const hint =
            pinned?.record.health === 'unauthorized'
              ? '该账号的凭证已被别处登录顶掉，请给它重新授权（管理页或 `mmcode login`）。'
              : '可以给它补额度（签到）或切换到「平衡」模式让会话自动滑动。';
          throw new CredentialError(`${acquired.detail} ${hint}`);
        }
        break;
      }

      const account = acquired.account;
      if (tried.has(account.record.name)) {
        break;
      }
      tried.add(account.record.name);

      let token: string;
      try {
        token = await account.tokens.accessToken();
      } catch (err) {
        if (signal.aborted) throw err;
        pool.reportFailure(account, 'unauthorized', (err as Error).message);
        lastError = err as Error;
        continue;
      }

      const baseUrl = baseUrlFor(account);
      const upstreamUrl = `${baseUrl}${upstreamPath}`;
      pool.recordRequestTransit(ctx.reqId ?? null, {
        upstream: upstreamUrl,
        account: account.record.name,
        protocol: 'anthropic',
        payload: upstreamPayload,
      });

      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept,
        'anthropic-version': inboundHeaders?.anthropicVersion || '2023-06-01',
        'user-agent': 'MiniMaxCode',
      };
      if (inboundHeaders?.anthropicBeta) {
        headers['anthropic-beta'] = inboundHeaders.anthropicBeta;
      }

      let res: Response;
      try {
        res = await fetch(upstreamUrl, {
          method: 'POST',
          headers,
          body: bodyJson,
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw err;
        pool.reportFailure(account, 'error', (err as Error).message);
        lastError = err as Error;
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const detail = `上游 HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`;
        if (res.status === 401 || res.status === 403 || res.status === 429) {
          pool.reportFailure(account, classifyFailure(res.status), detail);
          lastError =
            res.status === 429
              ? new UpstreamError(`${detail}（已限流，账号额度已冻结，自动换下一个账号重试）`, res.status, text)
              : new CredentialError(
                  `上游鉴权失败（HTTP ${res.status}）—— 账号 [${account.record.name}] 的凭证已被别处登录顶掉` +
                    '：请给该账号重新授权（管理页或 `mmcode login`）',
                );
          continue;
        }
        /* 400 / 5xx 等：不换号，保留上游状态码供反代层回传。 */
        throw new UpstreamError(detail, res.status, text);
      }

      pool.reportSuccess(account);
      pool.recordRequestAccount(ctx.reqId ?? null, account.record.name);
      return await onSuccess(res, account);
    }

    throw (
      lastError ??
      new CredentialError('没有可用账号 —— 先跑 `mmcode login` 登录至少一个账号')
    );
  }

  /** 把采集到的用量记入请求日志缓存与账号级洞察台账。 */
  function recordUsage(ctx: RequestContext, account: PoolAccount, sessionKey: string, model: string, usage: StreamUsage): void {
    pool.recordRequestUsage(ctx.reqId ?? null, {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedTokens: usage.cachedTokens,
      totalTokens: usage.totalTokens,
    });
    opts.insights?.record({
      account: account.record.name,
      sessionKey,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedTokens: usage.cachedTokens,
    });
  }

  const adapter: MmcodeAdapter = {
    command: 'mmcode',
    displayName: 'MiniMax Code',
    defaultPort: 8788,
    get upstreamLabel(): string {
      const account = fallbackAccount();
      const r = account?.credential?.region ?? account?.record.region ?? resolveRegion(opts.region);
      const tag = r === 'global' ? ' (海外 Global)' : ' (国内 China)';
      const total = pool.all().length;
      const usable = pool.available().length;
      const modeTag = pool.mode() === 'balanced' ? '平衡模式' : '最大缓存模式';
      const base = opts.baseUrl?.replace(/\/+$/, '') ?? getAgentBase(r);
      return `${base}${tag}  (Anthropic 协议)  可用账号 ${usable}/${total} · ${modeTag}`;
    },
    loginHint: '登录（官方 OAuth 设备授权；按提示在浏览器完成授权）',

    extraCommands: [
      {
        name: 'login-poll',
        summary: `完成登录：轮询取票（浏览器授权后执行；\`login\` 等待超时也用这条）`,
        usage: 'login-poll [账号名]',
        async run({ args }) {
          const name = args[0];
          const account = pickAccount(name);
          const dir = account?.dir;
          try {
            const cred = await pollDeviceLogin(LOGIN_WAIT_MS, tickTo(process.stdout), dir);
            if (account) pool.getAccountStore().upsert(account.record.name, cred.region);
            return (
              '✓ 登录成功 → ' +
              credentialPath(dir) +
              '\n' +
              credentialSummary(dir) +
              '\n' +
              mutualExclusionNotice()
            );
          } catch (err) {
            if (err instanceof PendingLoginError) {
              return '⏳ 还没看到你的授权完成 —— 请先在浏览器里打开链接完成授权，然后重跑：mmcode login-poll';
            }
            throw err;
          }
        },
      },
      {
        name: 'accounts',
        summary: '列出所有已配置账号及其状态（优先级 / 额度 / 健康 / 冷却 / 签到）',
        usage: 'accounts',
        async run({ json }) {
          const list = pool.refresh().map((a) => ({
            name: a.record.name,
            region: a.record.region,
            enabled: a.record.enabled,
            priority: a.record.priority,
            frozen: a.record.frozen === true,
            frozenReason: a.record.frozenReason ?? null,
            loggedIn: a.credential !== null,
            health: a.record.health,
            healthDetail: a.record.healthDetail ?? null,
            disabledUntil: a.record.disabledUntil ?? null,
            lastUsedAt: a.record.lastUsedAt ?? null,
            lastCheckin: a.record.lastCheckin ?? null,
            lastReward: a.record.lastReward ?? null,
            creditsRemaining: a.record.lastCredits?.remaining ?? null,
            account: a.credential?.account ?? null,
            tokenExpiresAt: a.credential?.expiresAt ?? null,
          }));
          if (json) return JSON.stringify(list, null, 2);
          if (list.length === 0) return '还没有任何账号 —— 跑 `mmcode login` 登录一个。';
          const lines = ['MiniMax Code 账号池', ''];
          for (const a of list) {
            const regionTag = a.region === 'global' ? '海外' : '国内';
            const mark = a.enabled ? (a.loggedIn ? '✓' : '○') : '✗';
            const cooling =
              a.disabledUntil && a.disabledUntil > Date.now()
                ? ` 冷却至 ${new Date(a.disabledUntil).toLocaleString('zh-CN')}`
                : '';
            const frozen = a.frozen ? ` ❄冻结${a.frozenReason ? '（' + a.frozenReason + '）' : ''}` : '';
            const checkin = a.lastCheckin ? ` 签到:${a.lastCheckin.outcome}` : '';
            const credits =
              a.creditsRemaining !== null ? ` 余额:${a.creditsRemaining}` : '';
            lines.push(
              ` ${mark} ${a.name}  [${regionTag}]  优先级 ${a.priority}  ${a.loggedIn ? '已登录' : '未登录'}  健康:${a.health}${cooling}${frozen}${checkin}${credits}`,
            );
          }
          const modeTag = pool.mode() === 'balanced' ? '平衡模式' : '最大缓存模式';
          lines.push(
            '',
            `模式：${modeTag}（可用 ${pool.available().length}/${list.length}）  最小可用积分：${pool.getAccountStore().creditsThreshold()}`,
          );
          lines.push('优先级数字越小越优先；同层账号随机分配。');
          return lines.join('\n');
        },
      },
      {
        name: 'keys',
        summary: '管理客户端用的入站密钥（生成 / 列出 / 吊销）',
        usage: 'keys [list|new <名字>|revoke <id>|rotate <id>]',
        async run({ json, args }) {
          const registry = opts.keys;
          if (!registry) {
            throw new CredentialError('密钥注册表未启用');
          }
          const [action = 'list', ...rest] = args;

          if (action === 'list' || action === undefined) {
            const list = registry.list();
            if (json) return JSON.stringify(list, null, 2);
            if (list.length === 0) return '还没有入站密钥 —— 跑 `mmcode keys new <名字>` 生成一把。';
            const lines = ['客户端入站密钥', ''];
            for (const k of list) {
              const mark = k.primary ? '★' : ' ';
              const state = k.enabled ? '启用' : '停用';
              const used = k.lastUsedAt ? ` 上次使用 ${new Date(k.lastUsedAt).toLocaleString('zh-CN')}` : ' 从未使用';
              lines.push(` ${mark} ${k.name}  [${state}]  ${maskInboundKey(k.key)}  (${k.id})${used}`);
              lines.push(`     ${k.key}`);
            }
            lines.push('', '★ = 主密钥（key 文件指向它）');
            return lines.join('\n');
          }

          if (action === 'new') {
            const name = rest.join(' ').trim() || `密钥 ${registry.list().length + 1}`;
            const created = registry.create(name);
            return `✓ 已生成入站密钥\n  名称：${created.name}\n  密钥：${created.key}\n  id  ：${created.id}\n\n把它填进 Anthropic 客户端的 API Key 即可。`;
          }

          if (action === 'revoke') {
            const id = rest[0] ?? '';
            if (!id) throw new CredentialError('请指定要吊销的密钥 id（先用 `mmcode keys list` 看）');
            if (!registry.revoke(id)) throw new CredentialError(`没有密钥 [${id}]`);
            return `✓ 已吊销密钥 [${id}]`;
          }

          if (action === 'rotate') {
            const id = rest[0] ?? '';
            if (!id) throw new CredentialError('请指定要轮换的密钥 id');
            const rotated = registry.rotate(id);
            if (!rotated) throw new CredentialError(`没有密钥 [${id}]`);
            return `✓ 已轮换密钥 [${id}]\n  新密钥：${rotated.key}\n\n旧密钥立即失效，记得同步更新客户端配置。`;
          }

          throw new CredentialError(`未知操作：${action}（可用：list / new / revoke / rotate）`);
        },
      },
      {
        name: 'checkin',
        summary: '每日签到领积分（用本工具令牌代签，无需开客户端）',
        usage: 'checkin [账号名]',
        async run({ json, args }) {
          const account = pickAccount(args[0]);
          if (!account) throw new CredentialError('没有可用账号 —— 先跑 `mmcode login`');
          const r = await activityFor(account).checkin();
          const update: Partial<AccountRecord> = {
            lastCheckin: { at: Date.now(), ...r },
          };
          if (r.outcome === 'claimed' && r.points != null) {
            update.lastReward = { at: Date.now(), points: r.points };
          } else if (r.outcome === 'already' && r.points != null && !account.record.lastReward) {
            update.lastReward = { at: Date.now(), points: r.points };
          }
          pool.getAccountStore().update(account.record.name, update);
          return json ? JSON.stringify(r, null, 2) : renderCheckin(r);
        },
      },
      {
        name: 'credits',
        summary: '查询积分账本（剩余/已消耗/累计，精确到 0.01）',
        usage: 'credits [账号名]',
        async run({ json, args }) {
          const account = pickAccount(args[0]);
          if (!account) throw new CredentialError('没有可用账号 —— 先跑 `mmcode login`');
          const l = await activityFor(account).credits();
          pool.getAccountStore().update(account.record.name, {
            lastCredits: {
              at: Date.now(),
              granted: l.granted,
              remaining: l.remaining,
              consumed: l.consumed,
              nextExpireAt: l.nextExpireAt,
            },
          });
          return json ? JSON.stringify(l, null, 2) : renderCredits(l);
        },
      },
    ],

    async credentialStatus(): Promise<CredentialStatus> {
      const accounts = pool.all();
      if (accounts.length === 0) {
        return {
          ok: false,
          detail: '未登录 —— 跑 `mmcode login`（浏览器授权一次）',
          source: credentialPath(),
        };
      }
      const usable = pool.available();
      const modeTag = pool.mode() === 'balanced' ? '平衡模式' : '最大缓存模式';
      const parts = accounts.map((a) => {
        const regionTag = a.record.region === 'global' ? '海外' : '国内';
        const state = a.credential
          ? a.record.frozen === true
            ? '额度冻结'
            : a.record.disabledUntil && a.record.disabledUntil > Date.now()
              ? '冷却中'
              : '就绪'
          : '未登录';
        return `${a.record.name}[${regionTag}]P${a.record.priority}·${state}`;
      });
      const detail =
        `账号 ${parts.length} 个（可用 ${usable.length}，${modeTag}）：${parts.join('、')}`;
      return {
        ok: usable.length > 0,
        detail,
        source: accounts.length > 0 ? undefined : credentialPath(),
      };
    },

    async login(): Promise<void> {
      const account = fallbackAccount();
      const dir = account?.dir;
      const region = account?.record.region ?? resolveRegion(opts.region);
      const state = await startDeviceLogin(region, dir);
      const out = process.stdout;
      const regionLabel = state.region === 'global' ? ' [海外 Global]' : ' [国内 China]';
      const who = account ? `账号 [${account.record.name}]` : '默认账号';
      out.write(
        `请用浏览器打开下面的链接完成授权（用你的 MiniMax${regionLabel} 账号${who}）：\n\n` +
          `  ${state.verificationUriComplete}\n\n` +
          `  短码：${state.userCode}（链接已含，直接打开即可）\n\n` +
          `授权完成后本终端会**自动继续**（最多等 ${Math.round(LOGIN_WAIT_MS / 1000)} 秒）。\n`,
      );
      try {
        const cred = await pollDeviceLogin(LOGIN_WAIT_MS, tickTo(out), dir);
        pool.getAccountStore().upsert(account?.record.name ?? DEFAULT_ACCOUNT_NAME, cred.region);
        out.write('\n✓ 登录成功 → ' + credentialPath(dir) + '\n' + credentialSummary(dir) + '\n' + mutualExclusionNotice());
      } catch (err) {
        if (err instanceof PendingLoginError) {
          out.write(
            `\n⏳ 等了 ${Math.round(LOGIN_WAIT_MS / 1000)} 秒还没看到授权完成。\n` +
              '   完成浏览器授权后，回来执行：mmcode login-poll\n' +
              '   （设备码 5 分钟内有效；超过就得重新跑 mmcode login。）\n',
          );
          throw err;
        }
        throw err;
      }
    },

    async listModels(): Promise<ModelEntry[]> {
      const account = fallbackAccount();
      const baseUrl = account
        ? baseUrlFor(account)
        : opts.baseUrl?.replace(/\/+$/, '') ?? getAgentBase(resolveRegion(opts.region));
      return (await pullMinimaxModels(baseUrl)) ?? MINIMAX_MODELS;
    },

    async doctorChecks() {
      const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
      const account = fallbackAccount();
      const baseUrl = account
        ? baseUrlFor(account)
        : opts.baseUrl?.replace(/\/+$/, '') ?? getAgentBase(resolveRegion(opts.region));
      try {
        await fetch(`${baseUrl}${MODELS_PATH}`, { signal: AbortSignal.timeout(8000) });
        checks.push({ name: '上游连通', ok: true, detail: `${baseUrl} 可达` });
      } catch (err) {
        checks.push({ name: '上游连通', ok: false, detail: (err as Error).message });
      }

      const usable = pool.available();
      if (usable.length === 0) {
        checks.push({
          name: '令牌刷新',
          ok: false,
          detail: '没有可用账号 —— 先跑 `mmcode login`',
        });
      } else {
        for (const a of usable) {
          try {
            const t = await a.tokens.accessToken();
            checks.push({ name: `令牌刷新 [${a.record.name}]`, ok: true, detail: `可刷新（${t.slice(0, 8)}…）` });
          } catch (err) {
            checks.push({ name: `令牌刷新 [${a.record.name}]`, ok: false, detail: (err as Error).message });
          }
        }
        const cooling = pool.all().filter((a) => (a.record.disabledUntil ?? 0) > Date.now());
        if (cooling.length > 0) {
          checks.push({
            name: '账号冷却',
            ok: true,
            detail: cooling.map((a) => a.record.name).join('、') + ' 暂时不可用（已自动跳过）',
          });
        }
        const frozen = pool.all().filter((a) => a.record.frozen === true);
        if (frozen.length > 0) {
          checks.push({
            name: '额度冻结',
            ok: true,
            detail:
              frozen.map((a) => `${a.record.name}（${a.record.frozenReason ?? '余额不足'}）`).join('、') +
              ` 额度冻结，不参与调度（阈值 ${pool.getAccountStore().creditsThreshold()} 积分）`,
          });
        }
        const modeTag = pool.mode() === 'balanced' ? '平衡模式（额度耗尽可无缝滑动）' : '最大缓存模式（会话不迁移）';
        checks.push({ name: '调度模式', ok: true, detail: modeTag });
      }
      return checks;
    },

    /**
     * 原生 Anthropic `/v1/messages` 透传。
     */
    async messages(
      body: Record<string, unknown>,
      signal: AbortSignal,
      ctx: RequestContext = {},
      inboundHeaders?: AnthropicInboundHeaders,
    ): Promise<AnthropicCallResult> {
      const sessionKey = resolveSessionKey(ctx, body);
      const upstreamPayload = stripSessionFields(body);
      /* 若客户端未传 max_tokens，补一个安全默认值（Anthropic 协议要求必填），其余字段全量透传。 */
      if (typeof upstreamPayload.max_tokens !== 'number' || !Number.isFinite(upstreamPayload.max_tokens) || upstreamPayload.max_tokens <= 0) {
        upstreamPayload.max_tokens = 8192;
      }
      const wantsStream = upstreamPayload.stream === true;
      const model = typeof upstreamPayload.model === 'string' ? upstreamPayload.model : '';

      return dispatchWithFailover({
        sessionKey,
        ctx,
        upstreamPath: chatPath,
        upstreamPayload,
        accept: wantsStream ? 'text/event-stream' : 'application/json, text/event-stream',
        inboundHeaders,
        signal,
        onSuccess: async (res, account) => {
          const contentType = res.headers.get('content-type') ?? '';
          if (contentType.includes('text/event-stream') && res.body) {
            if (wantsStream) {
              const stream = collectAnthropicUsage(res.body, (usage) => {
                recordUsage(ctx, account, sessionKey, model, usage);
              });
              return { status: res.status, contentType: contentType || 'text/event-stream; charset=utf-8', stream };
            }
            /* 客户端明确非流式，但上游返回了 SSE：在服务侧聚合成标准 Anthropic Message JSON。 */
            const aggregated = await aggregateAnthropicSseToMessage(res.body, model);
            const usage = extractAnthropicJsonUsage(aggregated);
            if (usage) recordUsage(ctx, account, sessionKey, model, usage);
            return {
              status: res.status,
              contentType: 'application/json; charset=utf-8',
              bodyText: JSON.stringify(aggregated),
            };
          }

          /* 上游直接返回 JSON（或非 SSE 响应）。 */
          const bodyText = await res.text();
          try {
            const parsed = JSON.parse(bodyText);
            const usage = extractAnthropicJsonUsage(parsed);
            if (usage) recordUsage(ctx, account, sessionKey, model, usage);
          } catch {
            // 非 JSON 忽略 usage 抽取
          }
          return {
            status: res.status,
            contentType: contentType || 'application/json; charset=utf-8',
            bodyText,
          };
        },
      });
    },

    /**
     * 原生 Anthropic `/v1/messages/count_tokens` 透传。
     *
     * 与 `messages()` 共用同一套 `resolveSessionKey` + `AccountPool.acquireForSession` +
     * 自动换号逻辑，保证新会话先调用 `count_tokens` 再调用 `messages` 时一对一落在同一个账号。
     */
    async countTokens(
      body: Record<string, unknown>,
      signal: AbortSignal,
      ctx: RequestContext = {},
      inboundHeaders?: AnthropicInboundHeaders,
    ): Promise<AnthropicCountTokensResult> {
      const sessionKey = resolveSessionKey(ctx, body);
      const upstreamPayload = stripSessionFields(body);

      return dispatchWithFailover({
        sessionKey,
        ctx,
        upstreamPath: countTokensPath,
        upstreamPayload,
        accept: 'application/json',
        inboundHeaders,
        signal,
        onSuccess: async (res) => {
          const bodyText = await res.text();
          return {
            status: res.status,
            contentType: res.headers.get('content-type') ?? 'application/json; charset=utf-8',
            bodyText,
          };
        },
      });
    },

    /**
     * 满足 `waygate-core` `Adapter` 接口的兼容入口（仅作向后兼容，反代 HTTP 层不再经过它）。
     */
    async chat(body: ChatRequestBody, signal: AbortSignal): Promise<UpstreamCallResult> {
      const result = await adapter.messages({ ...body, stream: body.stream !== false }, signal);
      if (result.stream) {
        return { status: result.status, stream: result.stream };
      }
      const enc = new TextEncoder();
      const text = result.bodyText ?? '';
      return {
        status: result.status,
        stream: new ReadableStream<Uint8Array>({
          start(c) {
            if (text) c.enqueue(enc.encode(text));
            c.close();
          },
        }),
      };
    },
  };

  return adapter;
}
