/**
 * 账号池 —— 调度模型的实现。
 *
 * ## 调度模型（v2）
 *
 * **没有「当前账号」概念，只有「优先级」与「额度」两个维度。**
 *
 *   · **优先级**（`priority`，数字越小越优先）：账号分层。新 session 分配到
 *     「**最高层里还有可用账号**」的那一层；该层全不可用了才下沉到下一层。
 *     **同一层之内没有先后顺序** —— 可用账号之间**随机分配**。
 *   · **额度**（`creditsThreshold` + `frozen`）：余额低于阈值的账号被**冻结**，
 *     不参与调度；上游回 429 也立即视为额度耗尽。
 *
 * ## 两种模式（全局一个开关）
 *
 *   · `max-cache`（最大缓存）：session 一旦绑定某账号就**永不迁移** ——
 *     同账号才有上游提示词缓存。绑定账号额度耗尽时**不换号**，直接报错。
 *   · `balanced`（平衡）：绑定期间行为同 max-cache；绑定账号额度耗尽 /
 *     不可用时，session **无缝滑到**别的可用账号上，绑定随之更新。
 *
 * ## 为什么要有 session 概念
 * 同一个对话的连续几轮如果落在不同账号上，上游的提示词缓存就废了（缓存按账号隔离），
 * 每轮都要重新吃一遍全量 prompt —— 又慢又烧额度。session 绑定就是为了保住这份缓存。
 *
 * ## 为什么「同层随机」而不是轮询
 * 轮询会让**第 N 个会话固定落在第 N 个号**上 —— 看着均匀，实际上把某个号的
 * 缓存优势全占了。随机分配让每个号的缓存命中率大致均衡，符合「同层无先后」的直觉。
 *
 * ## 冷却是「持久」的
 * 冷却截止时间写在 `accounts.json` 里 —— 服务重启后依然记得「这个号刚被顶掉」，
 * 不会因为重启又拿它去撞一次 401。
 */

import { MinimaxTokenManager, type MinimaxCredential } from './credential.js';
import { readSavedCredential } from './credential.js';
import type { RequestTransit } from './requests.js';
import {
  AccountStore,
  resolveAccountDir,
  type AccountRecord,
  type AccountHealth,
  type PoolMode,
} from './accounts.js';

/** 冷却时长（ms）。 */
export const COOLDOWN_UNAUTHORIZED_MS = 30 * 60 * 1000;
export const COOLDOWN_RATE_LIMITED_MS = 60 * 1000;
export const COOLDOWN_ERROR_MS = 30 * 1000;

/**
 * 429 造成的「额度耗尽」冻结自愈窗口（ms）。
 *
 * 上游 429 多半是瞬时限流而非真的没额度 —— 若无限期冻结，一个健康的号会被
 * 白白闲置到下一次余额刷新为止。给它一个自愈窗口：窗口过后账号自动回到调度池
 * （除非余额刷新确认它确实没额度）。
 */
export const FREEZE_429_SELF_HEAL_MS = 5 * 60 * 1000;

export type FailureKind = 'unauthorized' | 'rate_limited' | 'error';

/** 池中的一个账号（记录 + 令牌目录 + 令牌管理器）。 */
export interface PoolAccount {
  record: AccountRecord;
  /** 该账号的令牌目录。 */
  dir: string;
  /** 该账号的 access token 管理器（各自缓存、各自刷新、各自写回）。 */
  tokens: MinimaxTokenManager;
  /** 当前已落盘的凭证（可能为 null = 未登录）。 */
  credential: MinimaxCredential | null;
}

export interface AccountPoolOptions {
  /** 日志回调。 */
  log?: (line: string) => void;
}

/** 选号结果。 */
export type AcquireResult =
  | { ok: true; account: PoolAccount; /** 本次是否发生了滑动（session 换了账号）。 */ slid: boolean }
  | {
      ok: false;
      /** `no-account`：一个可用账号都没有；`pinned`：绑定账号不可用且模式不允许迁移。 */
      reason: 'no-account' | 'pinned';
      detail: string;
      /** `pinned` 时：绑定到哪个账号（给人话报错用）。 */
      pinnedAccount?: string;
    };

/**
 * 一次请求的用量快照。
 *
 * 由**适配器**记录（它能看到上游原始 usage），供反代层写请求日志 ——
 * 因为 Anthropic 路线经 core 重编码成 Anthropic 事件帧时，缓存字段会被丢掉，
 * 只有适配器那一层才拿得到权威值。
 */
export interface RequestUsage {
  promptTokens: number;
  completionTokens: number;
  /** 缓存命中（读）的 token 数。 */
  cachedTokens: number;
  totalTokens: number;
}

export class AccountPool {
  private readonly store: AccountStore;
  private readonly log: (line: string) => void;
  private readonly managers = new Map<string, MinimaxTokenManager>();

  /** session key → 账号名。**进程内**即可 —— 重启后缓存绑定丢失，重新随机分配。 */
  private readonly bindings = new Map<string, string>();
  /** 反代请求 id → 实际使用的账号（给请求日志/洞察面板对账用）。 */
  private readonly requestAccounts = new Map<string, string>();
  /** 反代请求 id → 该次请求的用量（含缓存命中，适配器记录的权威值）。 */
  private readonly requestUsage = new Map<string, RequestUsage>();
  /** 反代请求 id → 中转信息（上游地址 / 账号 / 转译后的请求体）。 */
  private readonly requestTransit = new Map<string, RequestTransit>();

  constructor(store: AccountStore, opts: AccountPoolOptions = {}) {
    this.store = store;
    this.log = opts.log ?? (() => {});
    /* 启动时扫一次磁盘：把已存在的账号目录登记进来（老用户首次跑就有号）。 */
    this.store.rescan();
  }

  /** 重扫磁盘并返回全部账号快照（管理端刷新列表用）。 */
  refresh(): PoolAccount[] {
    this.store.rescan();
    return this.all();
  }

  /** 底层注册表（管理端直接改状态时用）。 */
  getAccountStore(): AccountStore {
    return this.store;
  }

  /** 全局调度模式。 */
  mode(): PoolMode {
    return this.store.mode();
  }

  /** 该账号的令牌管理器（懒创建，每账号一个实例）。 */
  manager(name: string): MinimaxTokenManager {
    let m = this.managers.get(name);
    if (!m) {
      m = new MinimaxTokenManager((line) => this.log(`[${name}] ${line}`), resolveAccountDir(name));
      this.managers.set(name, m);
    }
    return m;
  }

  /** 构造一个池账号快照。 */
  private snapshot(record: AccountRecord): PoolAccount {
    const dir = resolveAccountDir(record.name);
    return {
      record,
      dir,
      tokens: this.manager(record.name),
      credential: readSavedCredential(dir),
    };
  }

  /** 全部账号（含未登录 / 已停用的）。 */
  all(): PoolAccount[] {
    return this.store.list().map((r) => this.snapshot(r));
  }

  /** 按名取一个账号快照。 */
  get(name: string): PoolAccount | null {
    const record = this.store.get(name);
    return record ? this.snapshot(record) : null;
  }

  /** 当前是否处于冷却中（且冷却未过）。 */
  private cooling(record: AccountRecord, now: number): boolean {
    return typeof record.disabledUntil === 'number' && record.disabledUntil > now;
  }

  /**
   * 冻结是否**当前生效**。
   *
   * 冻结有两种：
   *   · 余额不足 —— 无限期（`frozenUntil` 为空），只有余额刷新达标才能解冻；
   *   · 429 额度耗尽 —— 带自愈窗口，窗口过后自动回池。
   */
  private frozen(record: AccountRecord, now: number): boolean {
    if (record.frozen !== true) return false;
    if (typeof record.frozenUntil === 'number') return record.frozenUntil > now;
    return true;
  }

  /** 账号当前**不可调度**的原因（null = 可调度）。 */
  unavailableReason(account: PoolAccount, now = Date.now()): string | null {
    if (!account.record.enabled) return '已停用';
    if (!account.credential) return '未登录';
    if (this.cooling(account.record, now)) return '冷却中';
    if (this.frozen(account.record, now)) {
      return account.record.frozenReason ? `额度冻结：${account.record.frozenReason}` : '额度冻结';
    }
    return null;
  }

  /**
   * 可参与调度的账号：**已启用 + 已有凭证 + 不在冷却中 + 额度未冻结**。
   *
   * 没有凭证的账号不参与 —— 它们没法服务请求，让它们进来只会浪费一轮重试。
   */
  available(): PoolAccount[] {
    const now = Date.now();
    return this.all().filter((a) => this.unavailableReason(a, now) === null);
  }

  /**
   * 按优先级把可用账号分层（数字小的在前）。
   *
   * 同层之内**保持注册表里的原始顺序** —— 但选号时是随机挑的，顺序没有语义。
   */
  tiers(): PoolAccount[][] {
    const byPriority = new Map<number, PoolAccount[]>();
    for (const account of this.available()) {
      const list = byPriority.get(account.record.priority);
      if (list) list.push(account);
      else byPriority.set(account.record.priority, [account]);
    }
    return [...byPriority.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, list]) => list);
  }

  /** 随机从最高层里挑一个账号（层内无先后顺序 ⇒ 随机）。 */
  private pickRandom(list: PoolAccount[]): PoolAccount | null {
    if (list.length === 0) return null;
    const idx = Math.floor(Math.random() * list.length);
    return list[idx] ?? null;
  }

  /**
   * 为一个 session 选账号。
   *
   * 流程：
   *   ① session 已绑定 → 绑定账号仍可用就用它；
   *      · `max-cache`：账号不可用就**不迁移**，返回 `pinned` 错误（保住缓存语义）；
   *      · `balanced`：账号不可用 → **滑动**到别的可用账号并更新绑定。
   *   ② session 未绑定（新会话）→ 取**最高可用层**，层内随机分配，并建立绑定。
   */
  acquireForSession(sessionKey: string | null): AcquireResult {
    if (sessionKey) {
      const boundName = this.bindings.get(sessionKey);
      if (boundName) {
        const bound = this.get(boundName);
        if (bound && this.unavailableReason(bound) === null) {
          return { ok: true, account: bound, slid: false };
        }
        /* 绑定账号不可用了（被冻结 / 冷却 / 甚至被删掉了）。 */
        if (this.mode() === 'max-cache') {
          const reason = bound ? this.unavailableReason(bound) ?? '未知' : '账号已删除';
          return {
            ok: false,
            reason: 'pinned',
            pinnedAccount: boundName,
            detail:
              `会话绑定的账号 [${boundName}] 当前不可用（${reason}）。` +
              '最大缓存模式不会把会话迁到别的账号 —— 换到「平衡」模式即可无缝滑动，或给该账号重新授权。',
          };
        }
        /* 平衡模式：滑动到别的账号（优先最高可用层，该层空了就下沉）。 */
        const slid = this.pickRandom(this.tiers()[0] ?? []);
        if (slid) {
          this.bindings.set(sessionKey, slid.record.name);
          this.log(`会话 ${shortKey(sessionKey)} 的账号 [${boundName}] 不可用，已滑到 [${slid.record.name}]`);
          return { ok: true, account: slid, slid: true };
        }
      }
    }

    /* 新会话（或平衡模式下无可滑的号）→ 最高可用层，层内随机。 */
    const tiers = this.tiers();
    const top = tiers[0] ?? [];
    const picked = this.pickRandom(top);
    if (!picked) {
      return {
        ok: false,
        reason: 'no-account',
        detail: '没有可用账号 —— 先跑 `mmcode login` 登录一个（管理页也能加账号）。',
      };
    }
    if (sessionKey) this.bindings.set(sessionKey, picked.record.name);
    return { ok: true, account: picked, slid: false };
  }

  /** 某个 session 当前绑定的账号名（洞察面板/调试用）。 */
  boundAccount(sessionKey: string): string | null {
    return this.bindings.get(sessionKey) ?? null;
  }

  /** 当前绑定了多少个 session（按账号计数）。 */
  sessionCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const name of this.bindings.values()) {
      out[name] = (out[name] ?? 0) + 1;
    }
    return out;
  }

  /** 记住「这次请求实际用了哪个账号」。 */
  recordRequestAccount(reqId: string | null, name: string): void {
    if (!reqId) return;
    this.requestAccounts.set(reqId, name);
    this.trimMap(this.requestAccounts);
  }

  /** 查某个请求用了哪个账号。 */
  getRequestAccount(reqId: string | null): string | null {
    if (!reqId) return null;
    return this.requestAccounts.get(reqId) ?? null;
  }

  /** 记下这次请求的用量（适配器在流结束时调用）。 */
  recordRequestUsage(reqId: string | null, usage: RequestUsage): void {
    if (!reqId) return;
    this.requestUsage.set(reqId, usage);
    this.trimMap(this.requestUsage);
  }

  /** 查这次请求的用量（请求日志显示缓存命中率用）。 */
  getRequestUsage(reqId: string | null): RequestUsage | null {
    if (!reqId) return null;
    return this.requestUsage.get(reqId) ?? null;
  }

  /** 记下这次请求的中转信息（适配器打上游前调用）。 */
  recordRequestTransit(reqId: string | null, transit: RequestTransit): void {
    if (!reqId) return;
    this.requestTransit.set(reqId, transit);
    this.trimMap(this.requestTransit);
  }

  /** 查这次请求的中转信息（请求详情里「中转」那一栏用）。 */
  getRequestTransit(reqId: string | null): RequestTransit | null {
    if (!reqId) return null;
    return this.requestTransit.get(reqId) ?? null;
  }

  /** 请求级快照只留最近 2000 条 —— 防内存无限涨。 */
  private trimMap(map: Map<string, unknown>): void {
    if (map.size <= 2000) return;
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }

  /** 记录本次调用的账号名（给「最近使用的账号」这类展示用）。 */
  getLastUsedAccount(): string | null {
    let last: string | null = null;
    let lastAt = 0;
    for (const account of this.all()) {
      const at = account.record.lastUsedAt ?? 0;
      if (at > lastAt) {
        lastAt = at;
        last = account.record.name;
      }
    }
    return last;
  }

  /** 解除单个或全部账号的冷却与冻结（人工干预）。 */
  resetCooldown(name?: string): void {
    if (name) {
      this.store.update(name, {
        disabledUntil: undefined,
        health: 'healthy',
        healthDetail: undefined,
        frozen: false,
        frozenReason: undefined,
        frozenUntil: undefined,
      });
      this.log(`手动解除账号 [${name}] 的冷却与冻结状态`);
    } else {
      for (const a of this.all()) {
        if ((a.record.disabledUntil ?? 0) > Date.now() || a.record.frozen === true) {
          this.store.update(a.record.name, {
            disabledUntil: undefined,
            health: 'healthy',
            healthDetail: undefined,
            frozen: false,
            frozenReason: undefined,
            frozenUntil: undefined,
          });
          this.log(`手动解除账号 [${a.record.name}] 的冷却与冻结状态`);
        }
      }
    }
  }

  /**
   * 按余额刷新额度状态。
   *
   * 余额 < 阈值 → 冻结（无限期，等下次刷新）；余额 >= 阈值 → 解冻。
   * 返回该账号是否发生了状态变化（便于上层记日志）。
   */
  applyCreditsBalance(name: string, remaining: number): boolean {
    const record = this.store.get(name);
    if (!record) return false;
    const threshold = this.store.creditsThreshold();
    const record0 = record;
    if (remaining < threshold) {
      const reason = `余额 ${remaining} < 阈值 ${threshold}`;
      if (record0.frozen === true && record0.frozenReason === reason) return false;
      this.store.update(name, {
        frozen: true,
        frozenReason: reason,
        frozenUntil: undefined,
      });
      this.log(`账号 [${name}] 额度冻结：${reason}`);
      return true;
    }
    if (record0.frozen === true) {
      this.store.update(name, { frozen: false, frozenReason: undefined, frozenUntil: undefined });
      this.log(`账号 [${name}] 额度恢复（余额 ${remaining} ≥ 阈值 ${threshold}），已解冻`);
      return true;
    }
    return false;
  }

  /** 请求成功：清冷却、标健康、记使用时间。 */
  reportSuccess(account: PoolAccount): void {
    this.store.update(account.record.name, {
      health: 'healthy',
      healthDetail: undefined,
      disabledUntil: undefined,
      lastUsedAt: Date.now(),
    });
  }

  /** 请求失败：按类型标记 + 冷却（429 额外冻结额度）。 */
  reportFailure(account: PoolAccount, kind: FailureKind, detail: string): void {
    const now = Date.now();
    const health: AccountHealth =
      kind === 'unauthorized' ? 'unauthorized' : kind === 'rate_limited' ? 'rate_limited' : 'error';
    const disabledUntil =
      now +
      (kind === 'unauthorized'
        ? COOLDOWN_UNAUTHORIZED_MS
        : kind === 'rate_limited'
          ? COOLDOWN_RATE_LIMITED_MS
          : COOLDOWN_ERROR_MS);
    const patch: Partial<AccountRecord> = { health, healthDetail: detail, disabledUntil };
    if (kind === 'rate_limited') {
      /* 429 = 额度耗尽（用户口径）：冻结该号，带自愈窗口。 */
      patch.frozen = true;
      patch.frozenReason = `上游 429：${detail}`.slice(0, 300);
      patch.frozenUntil = now + FREEZE_429_SELF_HEAL_MS;
    }
    this.store.update(account.record.name, patch);
    this.log(`账号 [${account.record.name}] ${health}：${detail}`);
  }
}

/** 日志里显示 session key 的短形式（别把整串哈希刷屏）。 */
function shortKey(key: string): string {
  return key.length > 20 ? `${key.slice(0, 20)}…` : key;
}

/**
 * 把一次失败**归类**为切换原因。
 *
 * 401/403 → 凭证被顶掉（换号）；429 → 限流（换号）；其余 → 临时错误（换号重试）。
 */
export function classifyFailure(status: number): FailureKind {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  return 'error';
}
