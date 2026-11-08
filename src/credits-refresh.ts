/**
 * 额度刷新 —— 拉各账号的积分余额，并按阈值**冻结 / 解冻**。
 *
 * ## 为什么需要它
 * 上游**不回报单次请求消耗**（实测 usage 里没有 credit 字段），所以「这个号还有多少
 * 额度」只能问账户级的积分账本。额度耗尽的两个信号：
 *   ① 余额低于阈值（本模块负责，定时跑）；
 *   ② 上游回 429（适配器当场冻结该号）。
 *
 * 余额刷新还负责**解冻**：余额回到阈值以上就把冻结解掉，账号重新参与调度。
 *
 * 调度器与管理页的「立即刷新」共用本函数 —— 口径只有一处。
 *
 * ## ★ 为什么要有退避与错峰（内存问题的另一半）
 * 额度刷新是**唯一**一个「对每个账号发一次上游请求」的定时任务，账号多时（比如 10 个）
 * 就变成密集轮询：
 *   · 单个账号失败（网络抖动 / 上游形状变化）时，每 5 分钟都会被重试一次 ——
 *     **失败越频繁，上游压力越大**，而上游抖动常常正是因为压力大；
 *   · 所有账号**同时**被问一遍 ⇒ 上游看到的是尖峰，不是平摊。
 *
 * 于是：
 *   · **退避**：单账号连续失败 ⇒ 指数退避（1 → 2 → 4 … 分钟，封顶 30 分钟），
 *     跳过期间**不发请求**（省上游，也省内存）；
 *   · **错峰**：账号之间插入随机间隔，避免所有请求挤在同一瞬间；
 *   · **失败即跳过冻结判定**：读不懂账本 ≠ 余额为 0 —— 绝不因一次解析失败冻死好账号。
 */

import { MinimaxActivity } from './activity.js';
import type { AccountPool } from './pool.js';

/** 单个账号的刷新结果。 */
export interface CreditsRefreshResult {
  account: string;
  ok: boolean;
  /** 剩余积分；失败为 null。 */
  remaining: number | null;
  /** 刷新后是否处于冻结态。 */
  frozen: boolean;
  /** 人话说明。 */
  detail: string;
  /** 本次是否因为**退避**被跳过（没发请求）。 */
  skipped?: boolean;
}

/** 退避状态机。 */
export interface CreditsBackoff {
  /** 该账号此刻是否该跳过（还在退避窗口内）。 */
  shouldSkip(account: string, now: number): boolean;
  /** 记一次失败 → 退避窗口加长。 */
  recordFailure(account: string, now: number): void;
  /** 记一次成功 → 清掉退避。 */
  recordSuccess(account: string): void;
  /** 退避还剩多少毫秒（0 = 不在退避中）。 */
  remainingMs(account: string, now: number): number;
}

/** 退避参数。 */
export const CREDITS_BACKOFF_BASE_MS = 60_000;
export const CREDITS_BACKOFF_MAX_MS = 30 * 60_000;

/** 账号之间的错峰间隔（ms）—— 随机，避免所有请求挤在一起。 */
export const CREDITS_STAGGER_MS = 250;

/**
 * 内存态的退避表。
 *
 * 键是账号名（账号数量有界，几十个）⇒ 不会无限涨。
 */
export class InMemoryCreditsBackoff implements CreditsBackoff {
  private readonly failures = new Map<string, { count: number; until: number }>();

  shouldSkip(account: string, now: number): boolean {
    const entry = this.failures.get(account);
    if (!entry) return false;
    if (entry.until <= now) return false;
    return true;
  }

  recordFailure(account: string, now: number): void {
    const prev = this.failures.get(account);
    const count = (prev?.count ?? 0) + 1;
    /* 指数退避，封顶 30 分钟。 */
    const delay = Math.min(CREDITS_BACKOFF_BASE_MS * 2 ** (count - 1), CREDITS_BACKOFF_MAX_MS);
    this.failures.set(account, { count, until: now + delay });
  }

  recordSuccess(account: string): void {
    this.failures.delete(account);
  }

  remainingMs(account: string, now: number): number {
    const entry = this.failures.get(account);
    if (!entry) return 0;
    return Math.max(0, entry.until - now);
  }
}

/** 刷新选项。 */
export interface RefreshCreditsOptions {
  /** 退避状态机；不传则不启用退避。 */
  backoff?: CreditsBackoff;
  /** 账号之间的错峰间隔（ms）；0 = 不错峰。 */
  staggerMs?: number;
  /** 注入的随机源（测试用）。 */
  random?: () => number;
  /** 休眠函数（测试用）。 */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/**
 * 刷新所有已登录账号的余额，并按阈值冻结 / 解冻。
 *
 * 单个账号失败**不影响**其它账号 —— 一个号没额度不该让整个刷新中断。
 */
export async function refreshCreditsForAll(
  pool: AccountPool,
  log?: (line: string) => void,
  opts: RefreshCreditsOptions = {},
): Promise<CreditsRefreshResult[]> {
  const results: CreditsRefreshResult[] = [];
  const store = pool.getAccountStore();
  const backoff = opts.backoff;
  const staggerMs = opts.staggerMs ?? CREDITS_STAGGER_MS;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;
  const now = Date.now();

  let index = 0;
  for (const account of pool.all()) {
    /* ① 退避窗口内 → 跳过，**不发请求**。 */
    if (backoff?.shouldSkip(account.record.name, now)) {
      const waitMs = backoff.remainingMs(account.record.name, now);
      const detail = `失败退避中，约 ${Math.ceil(waitMs / 1000)} 秒后再试（本轮未请求上游）`;
      results.push({
        account: account.record.name,
        ok: false,
        remaining: null,
        frozen: account.record.frozen === true,
        detail,
        skipped: true,
      });
      log?.(`[额度刷新] 账号 [${account.record.name}] 跳过：${detail}`);
      continue;
    }

    /* ② 错峰：账号之间随机插入间隔，避免密集轮询打崩上游。 */
    if (index > 0 && staggerMs > 0) {
      await sleep(Math.floor(random() * staggerMs));
    }
    index += 1;

    if (!account.credential) {
      results.push({
        account: account.record.name,
        ok: false,
        remaining: null,
        frozen: account.record.frozen === true,
        detail: '未登录',
      });
      continue;
    }

    try {
      const activity = new MinimaxActivity(
        () => account.tokens.accessToken(),
        () => account.credential?.region ?? account.record.region,
      );
      const ledger = await activity.credits();
      backoff?.recordSuccess(account.record.name);
      store.update(account.record.name, {
        lastCredits: {
          at: Date.now(),
          granted: ledger.granted,
          remaining: ledger.remaining,
          consumed: ledger.consumed,
          nextExpireAt: ledger.nextExpireAt,
        },
      });
      /* 余额达标就解冻，不达标就冻结（无限期，等下次刷新）。 */
      pool.applyCreditsBalance(account.record.name, ledger.remaining);
      const refreshed = pool.get(account.record.name);
      const frozen = refreshed?.record.frozen === true;
      const detail = frozen
        ? `剩余 ${ledger.remaining}（低于阈值 ${store.creditsThreshold()}，已冻结）`
        : `剩余 ${ledger.remaining}`;
      results.push({
        account: account.record.name,
        ok: true,
        remaining: ledger.remaining,
        frozen,
        detail,
      });
      log?.(`[额度刷新] 账号 [${account.record.name}]：${detail}`);
    } catch (err) {
      const message = (err as Error).message;
      backoff?.recordFailure(account.record.name, Date.now());
      /* ★ 失败**不**改冻结状态** —— 读不懂账本 ≠ 余额为 0。
         （旧实现里「details 缺失」会返回 0 余额并把账号按阈值冻死，
           上游一次形状抖动就能打死全部账号。） */
      results.push({
        account: account.record.name,
        ok: false,
        remaining: null,
        frozen: account.record.frozen === true,
        detail: message,
      });
      log?.(`[额度刷新] 账号 [${account.record.name}] 失败：${message}`);
    }
  }

  return results;
}
