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
}

/**
 * 刷新所有已登录账号的余额，并按阈值冻结 / 解冻。
 *
 * 单个账号失败**不影响**其它账号 —— 一个号没额度不该让整个刷新中断。
 */
export async function refreshCreditsForAll(
  pool: AccountPool,
  log?: (line: string) => void,
): Promise<CreditsRefreshResult[]> {
  const results: CreditsRefreshResult[] = [];
  const store = pool.getAccountStore();

  for (const account of pool.all()) {
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
