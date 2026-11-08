/**
 * 自动任务后台调度服务：负责自动签到与自动令牌刷新。
 *
 * 在 Web 服务运行期间常驻后台：
 * 1. 自动签到：以 Asia/Shanghai 时区为准，每日定时检查所有已登录账号并自动签到，避免断签；
 * 2. 自动令牌刷新：定期巡检所有已登录账号，当 access_token 临近过期（默认余量 30 分钟）时自动刷新，
 *    避免客户端请求发生时因现刷 token 引起阻塞或竞争。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AccountPool, PoolAccount } from './pool.js';
import { MinimaxActivity, type SigninResult } from './activity.js';
import { refreshCreditsForAll, type CreditsRefreshResult } from './credits-refresh.js';

export interface SchedulerConfig {
  autoCheckin: {
    enabled: boolean;
    /** 每日计划签到时间 (24小时制 HH:mm，如 "08:00") */
    time: string;
    /** 轮询检测间隔（分钟，默认 30 分钟） */
    intervalMinutes: number;
  };
  autoRefresh: {
    enabled: boolean;
    /** 轮询检测间隔（分钟，默认 15 分钟） */
    intervalMinutes: number;
    /** 提前刷新缓冲时间（分钟，默认 30 分钟） */
    marginMinutes: number;
  };
  /**
   * 额度巡检：拉积分余额，低于阈值就**冻结**该账号（余额回到阈值以上自动解冻）。
   *
   * 上游不回报单次请求消耗 —— 「这个号还有多少额度」只能问账户级账本。
   */
  autoCredits: {
    enabled: boolean;
    /** 轮询检测间隔（分钟，默认 5 分钟） */
    intervalMinutes: number;
  };
}

export interface CheckinHistoryItem {
  at: number;
  account: string;
  outcome: 'claimed' | 'already' | 'unavailable' | 'error';
  points: number | null;
  streak: number | null;
  message: string;
}

export interface RefreshHistoryItem {
  at: number;
  account: string;
  ok: boolean;
  detail: string;
}

export interface SchedulerStatus {
  autoCheckin: {
    enabled: boolean;
    time: string;
    intervalMinutes: number;
    lastRunAt: number | null;
    history: CheckinHistoryItem[];
  };
  autoRefresh: {
    enabled: boolean;
    intervalMinutes: number;
    marginMinutes: number;
    lastRunAt: number | null;
    history: RefreshHistoryItem[];
  };
  autoCredits: {
    enabled: boolean;
    intervalMinutes: number;
    lastRunAt: number | null;
    history: CreditsHistoryItem[];
  };
}

/** 一次额度巡检的结果。 */
export interface CreditsHistoryItem {
  at: number;
  account: string;
  ok: boolean;
  remaining: number | null;
  frozen: boolean;
  detail: string;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  autoCheckin: {
    enabled: true,
    time: '08:00',
    intervalMinutes: 30,
  },
  autoRefresh: {
    enabled: true,
    intervalMinutes: 15,
    marginMinutes: 30,
  },
  autoCredits: {
    enabled: true,
    intervalMinutes: 5,
  },
};

/**
 * 判断两个时间戳在 Asia/Shanghai 时区是否为同一天。
 */
export function isSameDayInShanghai(ts1: number, ts2: number): boolean {
  const f = (ts: number) =>
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ts));
  return f(ts1) === f(ts2);
}

export class SchedulerService {
  private config: SchedulerConfig;
  private readonly configPath?: string;
  private readonly pool: AccountPool;
  private readonly log: (line: string) => void;

  private checkinTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private creditsTimer: NodeJS.Timeout | null = null;

  private lastCheckinRun: number | null = null;
  private lastRefreshRun: number | null = null;
  private lastCreditsRun: number | null = null;

  private checkinHistory: CheckinHistoryItem[] = [];
  private refreshHistory: RefreshHistoryItem[] = [];
  private creditsHistory: CreditsHistoryItem[] = [];

  constructor(pool: AccountPool, opts: { configPath?: string; log?: (line: string) => void } = {}) {
    this.pool = pool;
    this.configPath = opts.configPath;
    this.log = opts.log ?? (() => {});
    this.config = { ...DEFAULT_SCHEDULER_CONFIG };
    this.loadConfig();
  }

  private loadConfig(): void {
    if (!this.configPath || !existsSync(this.configPath)) return;
    try {
      const data = JSON.parse(readFileSync(this.configPath, 'utf8')) as Partial<SchedulerConfig>;
      if (data.autoCheckin) {
        this.config.autoCheckin = {
          ...this.config.autoCheckin,
          ...data.autoCheckin,
        };
      }
      if (data.autoRefresh) {
        this.config.autoRefresh = {
          ...this.config.autoRefresh,
          ...data.autoRefresh,
        };
      }
      if (data.autoCredits) {
        this.config.autoCredits = {
          ...this.config.autoCredits,
          ...data.autoCredits,
        };
      }
    } catch {
      // 容错
    }
  }

  private saveConfig(): void {
    if (!this.configPath) return;
    try {
      mkdirSync(dirname(this.configPath), { recursive: true });
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch {
      // 容错
    }
  }

  /**
   * 启动后台轮询定时器。
   */
  start(): void {
    this.stop();

    // 启动自动签到定时器
    const checkinIntervalMs = Math.max(1, this.config.autoCheckin.intervalMinutes) * 60 * 1000;
    this.checkinTimer = setInterval(() => {
      void this.checkAndRunAutoCheckin();
    }, checkinIntervalMs);
    this.checkinTimer.unref?.();

    // 启动自动刷新定时器
    const refreshIntervalMs = Math.max(1, this.config.autoRefresh.intervalMinutes) * 60 * 1000;
    this.refreshTimer = setInterval(() => {
      void this.checkAndRunAutoRefresh();
    }, refreshIntervalMs);
    this.refreshTimer.unref?.();

    // 启动额度巡检定时器（拉余额 → 冻结 / 解冻）
    const creditsIntervalMs = Math.max(1, this.config.autoCredits.intervalMinutes) * 60 * 1000;
    this.creditsTimer = setInterval(() => {
      void this.checkAndRunAutoCredits();
    }, creditsIntervalMs);
    this.creditsTimer.unref?.();

    // 启动时延迟 3 秒执行初次检测
    setTimeout(() => {
      void this.checkAndRunAutoRefresh();
      void this.checkAndRunAutoCheckin();
      void this.checkAndRunAutoCredits();
    }, 3000).unref?.();
  }

  /**
   * 停止所有定时器。
   */
  stop(): void {
    if (this.checkinTimer) {
      clearInterval(this.checkinTimer);
      this.checkinTimer = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.creditsTimer) {
      clearInterval(this.creditsTimer);
      this.creditsTimer = null;
    }
  }

  /**
   * 更新调度配置。
   */
  updateConfig(patch: Partial<SchedulerConfig>): SchedulerConfig {
    if (patch.autoCheckin) {
      this.config.autoCheckin = {
        ...this.config.autoCheckin,
        ...patch.autoCheckin,
      };
    }
    if (patch.autoRefresh) {
      this.config.autoRefresh = {
        ...this.config.autoRefresh,
        ...patch.autoRefresh,
      };
    }
    if (patch.autoCredits) {
      this.config.autoCredits = {
        ...this.config.autoCredits,
        ...patch.autoCredits,
      };
    }
    this.saveConfig();
    this.start();
    return JSON.parse(JSON.stringify(this.config)) as SchedulerConfig;
  }

  getConfig(): SchedulerConfig {
    return JSON.parse(JSON.stringify(this.config)) as SchedulerConfig;
  }

  getStatus(): SchedulerStatus {
    return {
      autoCheckin: {
        enabled: this.config.autoCheckin.enabled,
        time: this.config.autoCheckin.time,
        intervalMinutes: this.config.autoCheckin.intervalMinutes,
        lastRunAt: this.lastCheckinRun,
        history: this.checkinHistory.slice(0, 30),
      },
      autoRefresh: {
        enabled: this.config.autoRefresh.enabled,
        intervalMinutes: this.config.autoRefresh.intervalMinutes,
        marginMinutes: this.config.autoRefresh.marginMinutes,
        lastRunAt: this.lastRefreshRun,
        history: this.refreshHistory.slice(0, 30),
      },
      autoCredits: {
        enabled: this.config.autoCredits.enabled,
        intervalMinutes: this.config.autoCredits.intervalMinutes,
        lastRunAt: this.lastCreditsRun,
        history: this.creditsHistory.slice(0, 30),
      },
    };
  }

  /**
   * 立即巡检所有账号的额度余额（并按阈值冻结 / 解冻）。
   */
  async checkCreditsAll(): Promise<CreditsRefreshResult[]> {
    this.lastCreditsRun = Date.now();
    const results = await refreshCreditsForAll(this.pool, this.log);
    for (const r of results) {
      this.creditsHistory.unshift({
        at: Date.now(),
        account: r.account,
        ok: r.ok,
        remaining: r.remaining,
        frozen: r.frozen,
        detail: r.detail,
      });
    }
    if (this.creditsHistory.length > 50) this.creditsHistory.length = 50;
    return results;
  }

  /** 后台额度巡检入口（定时器调用）。 */
  async checkAndRunAutoCredits(): Promise<void> {
    if (!this.config.autoCredits.enabled) return;
    await this.checkCreditsAll();
  }

  /**
   * 立即为所有可用账号执行签到。
   */
  async checkinAll(): Promise<Array<{ account: string; result: SigninResult }>> {
    this.lastCheckinRun = Date.now();
    const accounts = this.pool.all().filter((a) => a.credential !== null && a.record.enabled);
    const results: Array<{ account: string; result: SigninResult }> = [];

    for (const account of accounts) {
      try {
        const activity = new MinimaxActivity(
          () => account.tokens.accessToken(),
          () => account.credential?.region ?? account.record.region,
        );
        const result = await activity.checkin();
        this.pool.getAccountStore().update(account.record.name, {
          lastCheckin: { at: Date.now(), ...result },
        });

        const historyItem: CheckinHistoryItem = {
          at: Date.now(),
          account: account.record.name,
          outcome: result.outcome,
          points: result.points,
          streak: result.streak,
          message: result.message,
        };
        this.checkinHistory.unshift(historyItem);
        if (this.checkinHistory.length > 50) this.checkinHistory.length = 50;

        results.push({ account: account.record.name, result });
        this.log(`[自动签到] 账号 [${account.record.name}] 签到完成：${result.outcome} (${result.message})`);
      } catch (err) {
        const errMsg = (err as Error).message;
        const errResult: SigninResult = {
          outcome: 'error',
          points: null,
          streak: null,
          message: errMsg,
        };
        this.checkinHistory.unshift({
          at: Date.now(),
          account: account.record.name,
          outcome: 'error',
          points: null,
          streak: null,
          message: errMsg,
        });
        results.push({ account: account.record.name, result: errResult });
        this.log(`[自动签到] 账号 [${account.record.name}] 签到出错：${errMsg}`);
      }
    }

    return results;
  }

  /**
   * 自动检测并签到尚未在今日签到的账号。
   */
  async checkAndRunAutoCheckin(): Promise<void> {
    if (!this.config.autoCheckin.enabled) return;

    const now = Date.now();
    const accounts = this.pool.all().filter((a) => a.credential !== null && a.record.enabled);

    for (const account of accounts) {
      const last = account.record.lastCheckin;
      const alreadyToday = last?.at && isSameDayInShanghai(last.at, now) && (last.outcome === 'claimed' || last.outcome === 'already');
      if (alreadyToday) continue;

      try {
        const activity = new MinimaxActivity(
          () => account.tokens.accessToken(),
          () => account.credential?.region ?? account.record.region,
        );
        const result = await activity.checkin();
        this.pool.getAccountStore().update(account.record.name, {
          lastCheckin: { at: Date.now(), ...result },
        });

        this.checkinHistory.unshift({
          at: Date.now(),
          account: account.record.name,
          outcome: result.outcome,
          points: result.points,
          streak: result.streak,
          message: result.message,
        });
        if (this.checkinHistory.length > 50) this.checkinHistory.length = 50;

        this.log(`[后台自动签到] 账号 [${account.record.name}]：${result.outcome} (${result.message})`);
      } catch (err) {
        this.log(`[后台自动签到] 账号 [${account.record.name}] 失败：${(err as Error).message}`);
      }
    }
    this.lastCheckinRun = now;
  }

  /**
   * 立即刷新所有账号令牌（支持 force）。
   */
  async refreshAll(force = false): Promise<Array<{ account: string; ok: boolean; detail: string }>> {
    this.lastRefreshRun = Date.now();
    const accounts = this.pool.all().filter((a) => a.credential !== null);
    const results: Array<{ account: string; ok: boolean; detail: string }> = [];

    for (const account of accounts) {
      try {
        let token = '';
        if (force) {
          token = await account.tokens.forceRefresh();
        } else {
          token = await account.tokens.accessToken();
        }
        const item: RefreshHistoryItem = {
          at: Date.now(),
          account: account.record.name,
          ok: true,
          detail: `令牌刷新成功（${token.slice(0, 8)}…）`,
        };
        this.refreshHistory.unshift(item);
        if (this.refreshHistory.length > 50) this.refreshHistory.length = 50;

        this.pool.getAccountStore().update(account.record.name, {
          health: 'healthy',
          healthDetail: undefined,
          disabledUntil: undefined,
        });
        results.push({ account: account.record.name, ok: true, detail: item.detail });
      } catch (err) {
        const detail = (err as Error).message;
        const item: RefreshHistoryItem = {
          at: Date.now(),
          account: account.record.name,
          ok: false,
          detail,
        };
        this.refreshHistory.unshift(item);
        if (this.refreshHistory.length > 50) this.refreshHistory.length = 50;
        results.push({ account: account.record.name, ok: false, detail });
      }
    }

    return results;
  }

  /**
   * 自动检测并刷新即将过期的令牌。
   */
  async checkAndRunAutoRefresh(): Promise<void> {
    if (!this.config.autoRefresh.enabled) return;

    const now = Date.now();
    const marginMs = Math.max(1, this.config.autoRefresh.marginMinutes) * 60 * 1000;
    const accounts = this.pool.all().filter((a) => a.credential !== null);

    for (const account of accounts) {
      const expiresAt = account.credential?.expiresAt;
      const needsRefresh = !expiresAt || expiresAt - now <= marginMs;

      if (needsRefresh) {
        try {
          const token = await account.tokens.accessToken();
          this.refreshHistory.unshift({
            at: Date.now(),
            account: account.record.name,
            ok: true,
            detail: `自动巡检续期成功（${token.slice(0, 8)}…）`,
          });
          if (this.refreshHistory.length > 50) this.refreshHistory.length = 50;
          this.pool.getAccountStore().update(account.record.name, {
            health: 'healthy',
            healthDetail: undefined,
          });
        } catch (err) {
          const detail = (err as Error).message;
          this.refreshHistory.unshift({
            at: Date.now(),
            account: account.record.name,
            ok: false,
            detail: `自动巡检续期失败：${detail}`,
          });
          if (this.refreshHistory.length > 50) this.refreshHistory.length = 50;
        }
      }
    }
    this.lastRefreshRun = now;
  }
}
