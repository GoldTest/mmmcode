/**
 * MiniMax Code 适配器：把「官方 OAuth 设备授权登录取到的凭证」变成「本地 Anthropic/OpenAI 兼容反代」。
 *
 * 与 waygate-qoder / waygate-workbuddy 同构（同一个 core 骨架），差异在于：
 *   · 凭证：走 **官方 OAuth 设备授权**（`mmcode login`），**不读本机客户端、不解密**；
 *     这样服务器（无反代目标机的桌面客户端）也能自助登录，无需人工注入 token；
 *   · 协议：上游是 **Anthropic 兼容**（`/mavis/api/v1/llm/v1/messages`），不是自研签名；
 *   · ⚠️ 有**凭证互斥**问题（见 README），必须给用户明确告警。
 *
 * ## 多账号与调度（本文件的核心）
 * MiniMax **同一账号只能有一个有效会话** —— 上游 401 通常意味着「这个号在别处登过」，
 * 光重试没用。所以反代必须**手上有多个号**：
 *   · `AccountPool` 负责选号（**按优先级分层 + 同层随机 + 额度冻结**）；
 *   · 本文件的 `chat()` 负责按 **session** 选号并执行失败重试：
 *     401/403/429 → 标记该号 → 换下一个（受调度模式约束）；
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
  MinimaxTokenManager,
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
import { anthropicToOpenAiSse } from './protocol/stream-decode.js';
import { collectUsage } from './protocol/usage.js';
import { toAnthropicRequest } from './protocol/translate.js';
import { AccountStore, DEFAULT_ACCOUNT_NAME } from './accounts.js';
import { AccountPool, classifyFailure, type PoolAccount } from './pool.js';
import { extractRequestContext, resolveSessionKey } from './session.js';
import type { InsightsLedger } from './insights.js';
import { maskInboundKey, type KeyRegistry } from './keys.js';

export const DEFAULT_MMCODE_BASE_URL = 'https://agent.minimax.cn';
export const DEFAULT_MMCODE_CHAT_PATH = '/mavis/api/v1/llm/v1/messages';

export function resolveAdapterBaseUrl(opts: { baseUrl?: string; region?: MinimaxRegion } = {}): string {
  if (opts.baseUrl) return opts.baseUrl.replace(/\/+$/, '');
  const saved = readSavedCredential();
  const region = saved?.region ?? resolveRegion(opts.region);
  return getAgentBase(region);
}

/**
 * MiniMax 内置模型清单 —— **仅作回落**（v0.3.5 起）。
 *
 * 此前注释称「上游没有清单端点（实测 /mavis/api/v1/llm/v1/models 恒 503）」，
 * 那是**测错了路径**：清单端点是 `/mavis/api/v1/models`（不带 `llm/v1` 段，
 * 与 chat 端点前缀不同）。2026-10-17 实测该端点**无需鉴权**即可返回
 *   `{version, ttlSeconds, providers:[{providerId:'minimax', config:{models:{...}}}]}`
 *   —— 当前 4 个模型，与本清单一致。
 *
 * 故改为「真拉取 + 本清单回落」：上游新增模型能自动跟上（不必发版），
 * 拉取失败（离线 / 端点变更）时退回这里，保证 `mmcode models` 永远有输出。
 */
export const MINIMAX_MODELS: ModelEntry[] = [
  { id: 'MiniMax-M3', displayName: 'MiniMax M3' },
  { id: 'MiniMax-M3.1-Flash-Preview', displayName: 'MiniMax M3.1 Flash Preview' },
  { id: 'MiniMax-M2.7', displayName: 'MiniMax M2.7' },
  { id: 'MiniMax-M2.7-highspeed', displayName: 'MiniMax M2.7 Highspeed' },
];

/** 清单端点（相对 baseUrl）。与 chat 端点不同前缀 —— 这是当初测错的地方。 */
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
 * **不带 access token**：实测该端点无需鉴权（带假 token 反而 401 —— 上游若收到
 * Authorization 会去校验它）。不带即匿名可读，也就不依赖登录态，`mmcode models`
 * 在未登录时同样可用。
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
        /* 上游 name 是短名（如 `M2.7`），补上厂商前缀便于客户端里辨认。 */
        displayName: typeof m?.name === 'string' && m.name ? `MiniMax ${m.name}` : id,
      }));
    return entries.length > 0 ? entries : null;
  } catch {
    /* 网络不可达 / 超时 / 坏 JSON —— 一律回落，不向调用方抛（清单不是关键路径）。 */
    return null;
  }
}

/**
 * 轮询进度行 —— 用 `\r` 覆盖同一行，不刷屏。
 *
 * 没有它，用户面对的是最长 2 分钟的**完全静默**（实测），分不清"在等"还是"卡死了"。
 */
function tickTo(out: NodeJS.WriteStream): (info: { waitedMs: number; remainingMs: number }) => void {
  return ({ waitedMs, remainingMs }) => {
    const w = Math.round(waitedMs / 1000);
    const r = Math.round(remainingMs / 1000);
    out.write(`\r  ⏳ 等待授权中… ${w}s（最多再等 ${r}s，按 Ctrl+C 可中断）   `);
  };
}

/**
 * 登录成功后必讲的互斥告警 —— 设备授权**不解除**它。
 *
 * 走 OAuth 只是让「服务器上自助登录」成为可能，MiniMax 的
 * 「同一账号同时只有一个有效会话」规则没有变：这个账号一旦在别处登过
 * （桌面客户端或官方 `mcode` CLI），本工具手里的 refresh token 立刻作废。
 */
function mutualExclusionNotice(): string {
  return (
    '\n⚠️  凭证互斥（必读）：MiniMax 同一账号只能有一个有效会话。\n' +
    '    请给本工具用**专用账号**，并且**永不用它登桌面客户端或官方 mcode CLI** ——\n' +
    '    只要在别处登录一次，这里的凭证就会被顶掉（表现为 401，需重跑 mmcode login）。\n'
  );
}

/** 适配器构造选项。 */
export interface MmcodeAdapterOptions {
  /** 强制指定上游 base（调试用；否则按账号区域推导）。 */
  baseUrl?: string;
  /** 聊天端点路径（默认 Anthropic 兼容路径）。 */
  chatPath?: string;
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

export function createMmcodeAdapter(opts: MmcodeAdapterOptions = {}): Adapter {
  const log = opts.log ?? ((line: string) => process.stdout.write(`[mmcode] ${line}\n`));
  const chatPath = opts.chatPath ?? DEFAULT_MMCODE_CHAT_PATH;

  /* 账号池：外部可注入（管理端与 CLI 共用一个实例），否则自建。 */
  const pool = opts.pool ?? new AccountPool(new AccountStore(), { log });

  /** 某账号的 base URL —— **区域随账号走**（cn/global 是两套域名）。 */
  const baseUrlFor = (account: PoolAccount): string => {
    if (opts.baseUrl) return opts.baseUrl.replace(/\/+$/, '');
    const region = account.credential?.region ?? account.record.region ?? resolveRegion(opts.region);
    return getAgentBase(region);
  };

  /**
   * 兜底账号 —— **仅供 CLI / 体检这类「要一个账号去问上游」的场景**。
   *
   * 新模型里**没有「当前账号」概念**：调度只看优先级与额度。这里取「第一个可用账号」，
   * 没有可用就退到「第一个已登记账号」（只为把 base URL / 区域推给用户看）。
   */
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

  return {
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
      return `${base}${tag}  (Anthropic 兼容)  可用账号 ${usable}/${total} · ${modeTag}`;
    },
    // 模型清单走公开的 /mavis/api/v1/models（无需登录）；这里说明的是**聊天**所需凭证。
    loginHint: '登录（官方 OAuth 设备授权；按提示在浏览器完成授权）',

    /** [专属子命令] MiniMax 的签到与积分 —— 用本工具维护的令牌代签，无需开客户端。 */
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
        usage: 'accounts',        async run({ json }) {
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
            lines.push('', '★ = 主密钥（core 的 key 文件指向它）');
            return lines.join('\n');
          }

          if (action === 'new') {
            const name = rest.join(' ').trim() || `密钥 ${registry.list().length + 1}`;
            const created = registry.create(name);
            return `✓ 已生成入站密钥\n  名称：${created.name}\n  密钥：${created.key}\n  id  ：${created.id}\n\n把它填进客户端的 API Key 即可。`;
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
          pool.getAccountStore().update(account.record.name, {
            lastCheckin: { at: Date.now(), ...r },
          });
          return json ? JSON.stringify(r, null, 2) : renderCheckin(r);
        },
      },
      {
        name: 'credits',
        summary: '查询积分账本（剩余/已消耗/累计，精确到 0.01）',
        usage: 'credits [账号名]',        async run({ json, args }) {
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

    /**
     * 登录 = 官方 OAuth 设备授权（`mmcode login`）。
     *
     * **原地等 2 分钟**：打印授权链接后就地轮询，用户在浏览器点完授权、终端**自动**继续，
     * 不用像 WorkBuddy 那样手动回来再跑一次。
     * 超时（或用户没在 2 分钟内完成）→ 抛 `PendingLoginError`，此时**保留 state**并提示
     * 改用 `mmcode login-poll` 续跑（设备码本身有效期 5 分钟）。
     */
    async login(): Promise<void> {
      /* 登录进「兜底账号」；一个号都没注册时用默认账号目录（老行为）。 */
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
        /* 登录后把账号登记进注册表 —— 否则新号不会被自动切换看见。 */
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
      /* v0.3.5：真拉取 /mavis/api/v1/models（无需鉴权），失败回落内置清单。
         此前返回硬编码常量 —— 上游新增模型时必须发版才能跟上。 */
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
      /* [复核修正] 此前 .catch(()=>null) 吞掉了所有网络错误 → 「上游连通」恒报 ✓。
         fetch 只在网络不可达（DNS/超时/拒连）时抛错；HTTP 404/502 不抛（反而证明可达）。 */
      try {
        await fetch(`${baseUrl}${MODELS_PATH}`, { signal: AbortSignal.timeout(8000) });
        checks.push({ name: '上游连通', ok: true, detail: `${baseUrl} 可达` });
      } catch (err) {
        checks.push({ name: '上游连通', ok: false, detail: (err as Error).message });
      }

      /* 账号池总览：每个可用账号各取一次 token —— 既验证刷新链，也把轮换写回。 */
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
     * 聊天 —— **按 session 选号 + 模式感知的换号重试**。
     *
     * 选号由 `AccountPool.acquireForSession` 决定：
     *   · 新 session → 最高可用优先级层，**层内随机**；
     *   · 已有 session → 回到**绑定账号**（保住上游提示词缓存）。
     *
     * 失败后的重试受**模式**约束：
     *   · `max-cache`：绑定账号不可用 ⇒ **不迁移**，直接报错（缓存语义优先）；
     *   · `balanced`：绑定账号额度耗尽 / 不可用 ⇒ **无缝滑到**别的可用账号。
     *
     * 换号触发条件（且仅这些）：
     *   401 / 403 → 凭证被别处登录顶掉；
     *   429      → 限流 / 额度耗尽（同时冻结该号的额度）；
     *   令牌拿不到（refresh token 失效）→ 换号。
     *
     * ⚠️ 其它错误（5xx / 网络抖动）**不换号** —— 那是上游或网络整体的问题，
     *    换号只会把所有号都标记成故障，反而降低可用性。
     */
    async chat(body: ChatRequestBody, signal: AbortSignal): Promise<UpstreamCallResult> {
      /* ① 摘出上下文（session / 入站密钥 / 请求 id），并把运输痕迹擦干净。 */
      const { ctx, body: cleanBody } = extractRequestContext(body);
      const sessionKey = resolveSessionKey(ctx, cleanBody);
      const anthropicReq = toAnthropicRequest(cleanBody);
      const payload = JSON.stringify(anthropicReq);
      const tried = new Set<string>();
      let lastError: Error | null = null;

      /* 最多试 4 个账号（再多也没意义 —— 用户通常只备了两三个号）。 */
      const maxAttempts = Math.max(1, Math.min(pool.all().length || 1, 4));

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        /* ② 按 session 选号。 */
        const acquired = pool.acquireForSession(sessionKey);
        if (!acquired.ok) {
          if (acquired.reason === 'pinned') {
            /* 最大缓存模式：绑定账号不可用 —— 不迁移，报清楚为什么。 */
            const pinned = acquired.pinnedAccount ? pool.get(acquired.pinnedAccount) : null;
            const hint =
              pinned?.record.health === 'unauthorized'
                ? '该账号的凭证已被别处登录顶掉，请给它重新授权（管理页或 `mmcode login`）。'
                : '可以给它补额度（签到）或切换到「平衡」模式让会话自动滑动。';
            throw new CredentialError(`${acquired.detail} ${hint}`);
          }
          break; /* 没有可用账号 → 走下面的兜底报错 */
        }

        const account = acquired.account;
        if (tried.has(account.record.name)) {
          /* 池又给了同一个号（理论上失败过的号已被冷却排除，这里兜底）。 */
          break;
        }
        tried.add(account.record.name);

        /* ③ 取令牌。取不到 = refresh token 已被顶掉/失效 → 换号。 */
        let token: string;
        try {
          token = await account.tokens.accessToken();
        } catch (err) {
          if (signal.aborted) throw err;
          pool.reportFailure(account, 'unauthorized', (err as Error).message);
          lastError = err as Error;
          continue;
        }

        /* ④ 打上游。 */
        const baseUrl = baseUrlFor(account);
        /* 记下「中转」信息：上游地址 + **转译后实际发给上游的请求体** ——
           入站是 OpenAI/Anthropic 形状，出站统一是 Anthropic 兼容形状，
           这一层翻译最容易出「我发的和上游收到的不一样」，请求详情里要能查。 */
        pool.recordRequestTransit(ctx.reqId ?? null, {
          upstream: `${baseUrl}${chatPath}`,
          account: account.record.name,
          protocol: 'anthropic',
          payload: anthropicReq,
        });
        let res: Response;
        try {
          res = await fetch(`${baseUrl}${chatPath}`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              accept: 'text/event-stream',
              'anthropic-version': '2023-06-01',
              'user-agent': 'MiniMaxCode',
            },
            body: payload,
            signal,
          });
        } catch (err) {
          /* 客户端断连不是账号的错 —— 不换号、不惩罚账号。 */
          if (signal.aborted) throw err;
          pool.reportFailure(account, 'error', (err as Error).message);
          lastError = err as Error;
          continue;
        }

        /* ⑤ 非 2xx：只有「换号有意义」的状态才继续往下走。 */
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => '');
          const detail = `上游 HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`;
          if (res.status === 401 || res.status === 403 || res.status === 429) {
            pool.reportFailure(account, classifyFailure(res.status), detail);
            lastError =
              res.status === 429
                ? new UpstreamError(`${detail}（已限流，账号额度已冻结，自动换下一个账号重试）`)
                : new CredentialError(
                    `上游鉴权失败（HTTP ${res.status}）—— 账号 [${account.record.name}] 的凭证已被别处登录顶掉` +
                      '：请给该账号重新授权（管理页或 `mmcode login`）',
                  );
            continue;
          }
          /* 5xx 等：上游整体异常，不换号。 */
          throw new UpstreamError(detail);
        }

        pool.reportSuccess(account);
        pool.recordRequestAccount(ctx.reqId ?? null, account.record.name);

        /* ⑥ 上游 Anthropic 事件流 → OpenAI SSE（core 负责把流吐给客户端）。
           顺带把 usage 摘出来记进台账 —— 洞察面板的 token 统计就来自这里。 */
        const openAiStream = res.body.pipeThrough(anthropicToOpenAiSse());
        const stream = collectUsage(openAiStream, (usage) => {
          /* 权威用量（含缓存命中）：先按请求 id 存下来，供反代层写请求日志 ——
             Anthropic 路线经 core 重编码后缓存字段会被丢掉，只有这一层拿得到。 */
          pool.recordRequestUsage(ctx.reqId ?? null, {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            cachedTokens: usage.cachedTokens,
            totalTokens: usage.totalTokens,
          });
          opts.insights?.record({
            account: account.record.name,
            sessionKey,
            model: cleanBody.model,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            cachedTokens: usage.cachedTokens,
          });
        });
        return { stream, status: 200 };
      }

      /* 所有账号都试过了。 */
      throw (
        lastError ??
        new CredentialError('没有可用账号 —— 先跑 `mmcode login` 登录至少一个账号')
      );
    },
  };
}
