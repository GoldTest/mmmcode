/**
 * 账号池 —— 自动账号切换的实现。
 *
 * ## 为什么需要它
 * MiniMax 有**凭证互斥**：同一账号同时只有一个有效会话。所以：
 *   · 一个账号 → 上游一旦拒绝（被别处登录顶掉）就彻底不可用，只能人工重登；
 *   · 多个账号 → 顶掉一个自动换下一个，服务不中断。
 * 本模块把这个「换号」策略化。
 *
 * ## 策略：粘性优先 + 故障转移（`sticky`）
 * 默认**尽量用同一个账号**（额度消耗最低、也最不容易触发上游的异常检测），
 * 只有它出问题时才切下一个：
 *
 *   401 / 403 → 该账号的 refresh token 已被别处登录顶掉 ⇒ 标记 `unauthorized`，
 *               冷却 30 分钟，**必须重新授权**才能回来；
 *   429      → 限流 ⇒ 标记 `rate_limited`，冷却 60 秒后自动复用；
 *   网络错/5xx → 标记 `error`，冷却 30 秒（可能是网络抖动，不该废掉账号）。
 *
 * 另有 `round-robin` 策略：每次请求换一个账号，均摊额度。
 *
 * ## 冷却是「持久」的
 * 冷却截止时间写在 `accounts.json` 里 —— 服务重启后依然记得「这个号刚被顶掉」，
 * 不会因为重启又拿它去撞一次 401。
 */

import { MinimaxTokenManager, type MinimaxCredential } from './credential.js';
import { readSavedCredential } from './credential.js';
import {
  AccountStore,
  DEFAULT_ACCOUNT_NAME,
  resolveAccountDir,
  type AccountRecord,
  type AccountHealth,
} from './accounts.js';

/** 冷却时长（ms）。 */
export const COOLDOWN_UNAUTHORIZED_MS = 30 * 60 * 1000;
export const COOLDOWN_RATE_LIMITED_MS = 60 * 1000;
export const COOLDOWN_ERROR_MS = 30 * 1000;

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

export class AccountPool {
  private readonly store: AccountStore;
  private readonly log: (line: string) => void;
  private readonly managers = new Map<string, MinimaxTokenManager>();
  private roundRobinCursor = 0;

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
   * 可参与切换的账号：**已启用 + 已有凭证 + 不在冷却中**。
   *
   * 没有凭证的账号不参与 —— 它们没法服务请求，让它们进来只会浪费一轮重试。
   */
  available(): PoolAccount[] {
    const now = Date.now();
    return this.all().filter(
      (a) => a.record.enabled && a.credential !== null && !this.cooling(a.record, now),
    );
  }

  /**
   * 取一个可用账号。
   *
   * `sticky` 策略：优先粘性账号；它不可用了就退到第一个可用的。
   * `round-robin` 策略：在可用列表里轮换，均摊额度。
   *
   * 返回 null = 一个可用账号都没有（调用方应报「没有可用账号」）。
   */
  async acquire(): Promise<PoolAccount | null> {
    /* 重扫一次：账号可能是刚登录出来的（`mmcode login` 写在默认目录），
       而注册表在进程启动时就加载过了 —— 不重扫会漏掉它。 */
    this.store.rescan();
    const list = this.available();
    if (list.length === 0) return null;

    if (this.store.strategy() === 'round-robin') {
      const picked = list[this.roundRobinCursor % list.length];
      this.roundRobinCursor = (this.roundRobinCursor + 1) % Math.max(1, list.length);
      return picked ?? null;
    }

    const activeName = this.store.activeName();
    if (activeName) {
      const sticky = list.find((a) => a.record.name === activeName);
      if (sticky) return sticky;
    }
    /* 粘性账号不可用了 —— 把粘性指针挪到第一个可用的，保持「粘性」语义。 */
    const first = list[0];
    if (first) {
      this.store.setActive(first.record.name);
      this.log(`粘性账号不可用，已切换到 [${first.record.name}]`);
    }
    return first ?? null;
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

  /** 请求失败：按类型标记 + 冷却。 */
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
    this.store.update(account.record.name, { health, healthDetail: detail, disabledUntil });
    this.log(`账号 [${account.record.name}] ${health}：${detail}`);
  }

  /**
   * 把一次失败**归类**为切换原因。
   *
   * 401/403 → 凭证被顶掉（换号）；429 → 限流（换号）；其余 → 临时错误（换号重试）。
   */
  static classify(status: number): FailureKind {
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 429) return 'rate_limited';
    return 'error';
  }
}
