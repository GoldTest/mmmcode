/**
 * 自动任务后台调度服务：负责自动签到与自动令牌刷新。
 *
 * 在 Web 服务运行期间常驻后台：
 * 1. 自动签到：每日定时检查所有已登录账号并自动签到，避免断签；
 * 2. 自动令牌刷新：定期巡检所有已登录账号，当 access_token 临近过期（默认余量 30 分钟）时自动刷新，
 *    避免客户端请求发生时因现刷 token 引起阻塞或竞争。
 *
 * ## 签到计划按**区域**分两套
 * MiniMax 的国内站与海外站是**两套独立服务**，账号也分属两区，
 * 所以签到计划天然要分两套：`autoCheckin.cn` 与 `autoCheckin.global`。
 * 每套计划有自己的**时区** —— 「08:30」对国内号是北京时间，
 * 对海外号则按海外那组配的时区解释（默认 UTC），互不干扰。
 *
 * ## 每套计划里的「时间」与「随机窗口」
 * `time` 是**签到窗口的中心点**，`jitterMinutes` 是窗口半径：
 *   · `jitterMinutes = 0` → 固定时间（`time` 那一刻）；
 *   · `jitterMinutes = N` → 每个账号在 **[time-N, time+N]** 里各有一个自己的随机时刻。
 *
 * 为什么要随机：所有账号每天挤在同一秒打同一个上游，既容易撞限流，
 * 也等于给上游画了一张「机器行为」的指纹。详见 `checkin-window.ts`。
 *
 * ⚠️ 兼容说明：`time` 这个字段以前**根本没被用过** —— 老逻辑只看「今天签没签过」，
 * 所以服务一起来（3 秒后）就立刻签。现在它真正生效了：没到点就等，
 * 错过了当天窗口才补签（宁可晚签也别断签）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AccountPool, PoolAccount } from './pool.js';
import type { AccountRecord } from './accounts.js';
import type { MinimaxRegion } from './credential.js';
import { MinimaxActivity, type SigninResult } from './activity.js';
import {
  refreshCreditsForAll,
  InMemoryCreditsBackoff,
  type CreditsRefreshResult,
} from './credits-refresh.js';
import {
  CN_TIMEZONE,
  GLOBAL_TIMEZONE,
  dailyJitterOffsetMs,
  isSameZonedDay,
  isValidTimezone,
  nextDateKey,
  normalizeHhMm,
  parseHhMm,
  resolveDailyDueAt,
  resolveWindowRange,
  zonedDateKey,
} from './checkin-window.js';

/** 一套签到计划（按区域划分）。 */
export interface CheckinSchedule {
  /** 每日计划签到时间 (24小时制 HH:mm，如 "08:00") —— 签到窗口的中心点。 */
  time: string;
  /**
   * 随机窗口半径（分钟）。
   *
   * · `0` → 固定时间，就在 `time` 那一刻签；
   * · `>0` → 在 `[time-N, time+N]` 内给**每个账号各挑一个随机时刻**（前后各半概率）。
   */
  jitterMinutes: number;
  /**
   * 这套计划用的时区（IANA 名，如 "Asia/Shanghai" / "UTC"）。
   *
   * `time` 按这个时区解释 —— 国内号与海外号各按各的来。
   */
  timezone: string;
}

/** 一套签到计划的补丁（部分字段）。 */
export type CheckinSchedulePatch = Partial<CheckinSchedule>;

/**
 * `autoCheckin` 的补丁形态。
 *
 * 除了 `cn` / `global` 两套分区计划，还兼容**旧形态** `time` / `jitterMinutes`
 * （一个时间两区共用）—— 旧脚本与旧前端不必改。
 */
export interface AutoCheckinPatch extends CheckinSchedulePatch {
  enabled?: boolean;
  intervalMinutes?: number;
  cn?: CheckinSchedulePatch;
  global?: CheckinSchedulePatch;
}

/** 调度配置的补丁形态。 */
export interface SchedulerConfigPatch extends Omit<Partial<SchedulerConfig>, 'autoCheckin'> {
  autoCheckin?: AutoCheckinPatch;
}

/**
 * 合并 `autoCheckin` 补丁 —— **兼容旧形态**。
 *
 * 旧形态只有一个 `time` / `jitterMinutes`（两区共用）；新形态是 `cn` / `global`
 * 两套各自的 `time` / `jitterMinutes` / `timezone`。
 * 两者同时出现时，以**分区计划为准**，旧字段只作为兜底。
 */
export function mergeAutoCheckin(
  base: SchedulerConfig['autoCheckin'],
  patch: AutoCheckinPatch,
): SchedulerConfig['autoCheckin'] {
  const next: SchedulerConfig['autoCheckin'] = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : base.enabled,
    cn: { ...base.cn },
    global: { ...base.global },
    intervalMinutes:
      patch.intervalMinutes !== undefined && Number.isFinite(Number(patch.intervalMinutes))
        ? Number(patch.intervalMinutes)
        : base.intervalMinutes,
  };
  const legacyTime = typeof patch.time === 'string' ? patch.time : undefined;
  const legacyJitter = typeof patch.jitterMinutes === 'number' ? patch.jitterMinutes : undefined;
  for (const region of ['cn', 'global'] as const) {
    const partial = patch[region];
    if (partial && typeof partial === 'object') next[region] = { ...next[region], ...partial };
    if (legacyTime !== undefined) next[region].time = legacyTime;
    if (legacyJitter !== undefined) next[region].jitterMinutes = legacyJitter;
  }
  return next;
}

export interface SchedulerConfig {
  autoCheckin: {
    enabled: boolean;
    /** 国内账号（cn）的签到计划。 */
    cn: CheckinSchedule;
    /** 海外账号（global）的签到计划。 */
    global: CheckinSchedule;
    /** 轮询检测间隔（分钟，默认 30 分钟）—— 兜底巡检，防止精确唤醒被漏掉。 */
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

/** 单个区域的签到状态（管理页按区域展示两行）。 */
export interface CheckinRegionStatus {
  /** 签到窗口中心点。 */
  time: string;
  /** 随机窗口半径（分钟）。 */
  jitterMinutes: number;
  /** 该区域使用的时区。 */
  timezone: string;
  /** 今日窗口的起止（epoch ms）。 */
  windowStart: number | null;
  windowEnd: number | null;
  /** 该区域下一个该签的时刻（epoch ms）。 */
  nextRunAt: number | null;
  /** 该区域待签账号数（已排定但还没到点）。 */
  pendingCount: number;
  /** 该区域纳入自动签到的账号数。 */
  accountCount: number;
}

export interface SchedulerStatus {
  autoCheckin: {
    enabled: boolean;
    intervalMinutes: number;
    lastRunAt: number | null;
    /** 全部区域里最近的一个应签时刻（epoch ms）—— 精确唤醒定时器的目标。 */
    nextRunAt: number | null;
    /** 按区域拆分的签到计划与状态。 */
    regions: Record<MinimaxRegion, CheckinRegionStatus>;
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

/**
 * 签到失败后的最小重试间隔（ms）。
 *
 * 为什么需要：签到失败时「今天已签」的标记不会写上，账号仍算未签到 ——
 * 若不加这个间隔，精确唤醒会立刻再次触发，反复打上游（热循环）。
 */
export const CHECKIN_RETRY_DELAY_MS = 10 * 60 * 1000;

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  autoCheckin: {
    enabled: true,
    /* 国内账号：北京时间 08:00 固定签到。 */
    cn: { time: '08:00', jitterMinutes: 0, timezone: CN_TIMEZONE },
    /* 海外账号：默认按美国东部时间解释（可在管理页改成任意 IANA 时区）。 */
    global: { time: '08:00', jitterMinutes: 0, timezone: GLOBAL_TIMEZONE },
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
 *
 * 保留这个函数是为了兼容旧调用方 —— 新代码请用 `isSameZonedDay(ts1, ts2, tz)`，
 * 按账号所属区域的时区判断（「今天」在不同区域不是同一个日子）。
 */
export function isSameDayInShanghai(ts1: number, ts2: number): boolean {
  return isSameZonedDay(ts1, ts2, CN_TIMEZONE);
}

export class SchedulerService {
  private config: SchedulerConfig;
  private readonly configPath?: string;
  private readonly pool: AccountPool;
  private readonly log: (line: string) => void;

  /**
   * 随机种子 —— 每日随机时刻的派生材料。
   *
   * 落盘是为了「同一台机器上的不同安装、不同用户」不会撞到同一秒；
   * 一旦生成就不再变（否则重启会重抽，签到时刻在一天内漂移）。
   */
  private randomSeed: string;

  private checkinTimer: NodeJS.Timeout | null = null;
  /**
   * **精确唤醒**定时器 —— 直接睡到「下一个该签的账号该签的那一刻」。
   *
   * 为什么不能只靠 `intervalMinutes` 轮询：轮询粒度是 30 分钟，
   * 而随机窗口可能只有 ±5 分钟 —— 轮询会把所有签到挤到窗口边界，
   * 随机就白随机了。精确唤醒保证「随机时刻」落在窗口内。
   */
  private checkinWakeTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private creditsTimer: NodeJS.Timeout | null = null;

  private lastCheckinRun: number | null = null;
  private lastRefreshRun: number | null = null;
  private lastCreditsRun: number | null = null;

  /**
   * 每个账号最近一次**签到尝试**的时刻。
   *
   * 用途：签到失败（网络抖动、上游 5xx）后当天仍算「未签到」，
   * 如果不记这个时间，精确唤醒会立刻再次触发 → **热循环**刷上游。
   * 有了它，失败账号至少隔 `CHECKIN_RETRY_DELAY_MS` 才会再试。
   */
  private readonly lastCheckinAttempt = new Map<string, number>();

  private checkinHistory: CheckinHistoryItem[] = [];
  private refreshHistory: RefreshHistoryItem[] = [];
  private creditsHistory: CreditsHistoryItem[] = [];

  /**
   * 防重入标记 —— 上一轮还没跑完就**不启动新一轮**。
   *
   * ★ 这是内存问题的隐形放大器：`setInterval` 触发的是**异步**任务，JS 不会等它完成。
   *   一轮额度巡检要打 N 次上游（每次最多 20s 超时 × 3 次重试），账号多时单轮可能
   *   跑好几分钟 —— **超过轮询间隔**。于是下一轮又起一批，两三轮并发叠在一起：
   *   每轮都持有完整的请求/响应体，内存 = 轮数 × N × 响应体大小，
   *   而且上游看到的压力也在翻倍。
   */
  private running = { checkin: false, refresh: false, credits: false };

  /** 额度刷新的退避表（按账号记录连续失败次数）。 */
  private readonly creditsBackoff = new InMemoryCreditsBackoff();

  constructor(pool: AccountPool, opts: { configPath?: string; log?: (line: string) => void } = {}) {
    this.pool = pool;
    this.configPath = opts.configPath;
    this.log = opts.log ?? (() => {});
    this.config = { ...DEFAULT_SCHEDULER_CONFIG };
    this.randomSeed = randomBytes(8).toString('hex');
    this.loadConfig();
  }

  /**
   * 读取配置。
   *
   * 兼容两种文件形态：
   *   · 新版：`{ version, config, randomSeed }`；
   *   · 旧版：直接是配置对象（平铺）—— 老用户的 `scheduler-config.json` 不能丢。
   *
   * 还兼容**更老的一层语义**：旧配置里只有 `autoCheckin.time`（一个时间、两区共用、
   * 隐含按北京时间算）。这时把那个时间套到两套计划上，时间区各归各 ——
   * 老用户升级后行为不突变。
   */
  private loadConfig(): void {
    if (!this.configPath || !existsSync(this.configPath)) {
      /* 首次运行：把种子写下来（之后永远不变）。 */
      this.saveConfig();
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.configPath, 'utf8')) as Record<string, unknown>;
      /* 新版形态：config 字段在顶层。 */
      const data = (
        raw && typeof raw === 'object' && raw['config'] && typeof raw['config'] === 'object'
          ? (raw['config'] as Partial<SchedulerConfig>)
          : (raw as Partial<SchedulerConfig>)
      );
      if (data.autoCheckin) {
        const legacy = data.autoCheckin as Partial<SchedulerConfig['autoCheckin']> & {
          time?: string;
          jitterMinutes?: number;
        };
        this.config.autoCheckin = mergeAutoCheckin(this.config.autoCheckin, legacy);
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
      const seed = raw['randomSeed'];
      if (typeof seed === 'string' && seed.length > 0) this.randomSeed = seed;
      this.config = this.sanitizeConfig(this.config);
    } catch {
      // 容错
    }
  }

  /**
   * 配置清洗 —— 任何来源（文件、API）进来的值都要过一遍。
   *
   * 签到时间写坏了会导致「永远等不到该签的那一刻」，所以宁可不改也不能写坏。
   */
  private sanitizeConfig(config: SchedulerConfig): SchedulerConfig {
    const sanitizeSchedule = (
      schedule: Partial<CheckinSchedule> | undefined,
      fallback: CheckinSchedule,
    ): CheckinSchedule => {
      const time = normalizeHhMm(String(schedule?.time ?? '')) ?? fallback.time;
      const jitter = Number(schedule?.jitterMinutes);
      const timezone = isValidTimezone(schedule?.timezone) ? schedule!.timezone! : fallback.timezone;
      return {
        time,
        jitterMinutes: Number.isFinite(jitter)
          ? Math.min(240, Math.max(0, Math.round(jitter)))
          : fallback.jitterMinutes,
        timezone,
      };
    };
    const interval = Number(config.autoCheckin.intervalMinutes);
    return {
      ...config,
      autoCheckin: {
        ...config.autoCheckin,
        enabled: config.autoCheckin.enabled !== false,
        cn: sanitizeSchedule(config.autoCheckin.cn, DEFAULT_SCHEDULER_CONFIG.autoCheckin.cn),
        global: sanitizeSchedule(
          config.autoCheckin.global,
          DEFAULT_SCHEDULER_CONFIG.autoCheckin.global,
        ),
        intervalMinutes: Number.isFinite(interval) ? Math.min(1440, Math.max(1, Math.round(interval))) : 30,
      },
    };
  }

  private saveConfig(): void {
    if (!this.configPath) return;
    try {
      mkdirSync(dirname(this.configPath), { recursive: true });
      writeFileSync(
        this.configPath,
        JSON.stringify({ version: 2, config: this.config, randomSeed: this.randomSeed }, null, 2),
        'utf8',
      );
    } catch {
      // 容错
    }
  }

  /**
   * 启动后台轮询定时器。
   */
  start(): void {
    this.stop();

    // 启动自动签到定时器（兜底巡检：防精确唤醒被漏掉，也兜住配置变更）
    const checkinIntervalMs = Math.max(1, this.config.autoCheckin.intervalMinutes) * 60 * 1000;
    this.checkinTimer = setInterval(() => {
      void this.checkAndRunAutoCheckin();
    }, checkinIntervalMs);
    this.checkinTimer.unref?.();

    /* 精确唤醒：直接睡到下一个该签的时刻。 */
    this.scheduleCheckinWake();

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
    if (this.checkinWakeTimer) {
      clearTimeout(this.checkinWakeTimer);
      this.checkinWakeTimer = null;
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
   *
   * 兼容旧形态的补丁：`{ autoCheckin: { time, jitterMinutes } }`（一个时间两区共用）
   * 会被套到 `cn` 与 `global` 两套计划上 —— 老脚本/老前端不会因此报错。
   */
  updateConfig(patch: SchedulerConfigPatch): SchedulerConfig {
    if (patch.autoCheckin) {
      this.config.autoCheckin = mergeAutoCheckin(this.config.autoCheckin, patch.autoCheckin);
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
    /* 过一遍清洗 —— 写坏的时间会让「该签的那一刻」永远算不出来。 */
    this.config = this.sanitizeConfig(this.config);
    this.saveConfig();
    this.start();
    return JSON.parse(JSON.stringify(this.config)) as SchedulerConfig;
  }

  getConfig(): SchedulerConfig {
    return JSON.parse(JSON.stringify(this.config)) as SchedulerConfig;
  }

  getStatus(): SchedulerStatus {
    const now = Date.now();
    const regions = {} as Record<MinimaxRegion, CheckinRegionStatus>;
    for (const region of ['cn', 'global'] as const) {
      regions[region] = this.regionStatus(region, now);
    }
    return {
      autoCheckin: {
        enabled: this.config.autoCheckin.enabled,
        intervalMinutes: this.config.autoCheckin.intervalMinutes,
        lastRunAt: this.lastCheckinRun,
        nextRunAt: this.nextDueAt(now),
        regions,
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
   *
   * ★ **防重入的唯一入口** —— 定时器与管理页的手动刷新都走这里，
   *   所以「后台轮询撞上手动刷新」也不会并发叠加。
   */
  async checkCreditsAll(): Promise<CreditsRefreshResult[]> {
    if (this.running.credits) {
      this.log('[额度巡检] 已有巡检在跑，本次跳过（防并发叠加）');
      return [];
    }
    this.running.credits = true;
    this.lastCreditsRun = Date.now();
    try {
      /* 带退避 + 错峰 —— 避免密集轮询打崩上游（也顺带压住内存）。 */
      const results = await refreshCreditsForAll(this.pool, this.log, {
        backoff: this.creditsBackoff,
      });
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
    } finally {
      this.running.credits = false;
    }
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
    const accounts = this.eligibleAccounts();
    const results: Array<{ account: string; result: SigninResult }> = [];

    for (const account of accounts) {
      this.lastCheckinAttempt.set(account.record.name, Date.now());
      try {
        const activity = new MinimaxActivity(
          () => account.tokens.accessToken(),
          () => account.credential?.region ?? account.record.region,
        );
        const result = await activity.checkin();
        const update: Partial<AccountRecord> = {
          lastCheckin: { at: Date.now(), ...result },
        };
        if (result.outcome === 'claimed' && result.points != null) {
          update.lastReward = { at: Date.now(), points: result.points };
        } else if (result.outcome === 'already' && result.points != null && !account.record.lastReward) {
          update.lastReward = { at: Date.now(), points: result.points };
        }
        this.pool.getAccountStore().update(account.record.name, update);

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
    /* 防重入：上一轮没跑完就跳过本轮（否则多轮并发，内存与上游压力都翻倍）。 */
    if (this.running.checkin) {
      this.log('[后台自动签到] 上一轮尚未结束，本轮跳过');
      return;
    }
    this.running.checkin = true;
    try {
      await this.runAutoCheckin();
    } finally {
      this.running.checkin = false;
      /* 跑完重排唤醒 —— 下一批账号的应签时刻可能已经变了。 */
      this.scheduleCheckinWake();
    }
  }

  /**
   * 自动签到的实际执行体（与防重入解耦，便于单测）。
   *
   * ★ 核心门控：**没到点不签**。
   *   每个账号今天的「应签时刻」由 `checkin-window.ts` 算出（固定时间 or 窗口内随机时刻），
   *   时刻按**该账号所属区域**的时区与计划来算 —— 国内号与海外号各签各的。
   *   到了才签；没到就跳过，交给精确唤醒定时器准时回来。
   *   错过窗口（服务停了一上午）照样会补签 —— 晚签比断签好。
   */
  private async runAutoCheckin(): Promise<void> {
    const now = Date.now();
    const accounts = this.eligibleAccounts();

    for (const account of accounts) {
      if (this.checkedInToday(account, now)) continue;

      /* 未到点 —— 跳过（精确唤醒定时器会准时回来）。 */
      const region = account.record.region ?? 'cn';
      const schedule = this.scheduleFor(region);
      const dateKey = zonedDateKey(now, schedule.timezone);
      if (now < this.accountDueAt(account.record.name, region, dateKey)) continue;

      this.lastCheckinAttempt.set(account.record.name, Date.now());
      try {
        const activity = new MinimaxActivity(
          () => account.tokens.accessToken(),
          () => account.credential?.region ?? account.record.region,
        );
        const result = await activity.checkin();
        const update: Partial<AccountRecord> = {
          lastCheckin: { at: Date.now(), ...result },
        };
        if (result.outcome === 'claimed' && result.points != null) {
          update.lastReward = { at: Date.now(), points: result.points };
        } else if (result.outcome === 'already' && result.points != null && !account.record.lastReward) {
          update.lastReward = { at: Date.now(), points: result.points };
        }
        this.pool.getAccountStore().update(account.record.name, update);

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

  /* ─────────────────── 签到时刻的计算与调度 ─────────────────── */

  /** 参与自动签到的账号（已登录 + 启用 + 开了自动签到）。 */
  private eligibleAccounts(): PoolAccount[] {
    return this.pool
      .all()
      .filter((a) => a.credential !== null && a.record.enabled && a.record.checkinEnabled !== false);
  }

  /** 某区域对应的签到计划（国内 / 海外两套）。 */
  private scheduleFor(region: MinimaxRegion): CheckinSchedule {
    return this.config.autoCheckin[region] ?? this.config.autoCheckin.cn;
  }

  /** 该账号今天是否已经签到成功（claimed / already 都算 —— 上游说「今天已签」也是签过了）。 */
  private checkedInToday(account: PoolAccount, now: number): boolean {
    const last = account.record.lastCheckin;
    if (!last?.at) return false;
    const region = account.record.region ?? 'cn';
    const timezone = this.scheduleFor(region).timezone;
    return (
      isSameZonedDay(last.at, now, timezone) &&
      (last.outcome === 'claimed' || last.outcome === 'already')
    );
  }

  /**
   * 某账号在某一天的**应签时刻**（epoch ms）。
   *
   * · 固定时间（jitter = 0）→ 就是 `time` 那一刻（按该区域的时区）；
   * · 有随机窗口 → `time` 前后各取一个该账号当天的专属随机偏移。
   */
  private accountDueAt(accountName: string, region: MinimaxRegion, dateKey: string): number {
    const schedule = this.scheduleFor(region);
    const parsed = parseHhMm(schedule.time) ?? { hour: 8, minute: 0 };
    const jitterMs = Math.max(0, schedule.jitterMinutes) * 60_000;
    const offsetMs = dailyJitterOffsetMs(this.randomSeed, dateKey, accountName, jitterMs);
    return resolveDailyDueAt({
      dateKey,
      hour: parsed.hour,
      minute: parsed.minute,
      offsetMs,
      timeZone: schedule.timezone,
    });
  }

  /** 某区域今日的签到窗口（给管理页展示）。 */
  private currentWindow(region: MinimaxRegion, now: number): { start: number; end: number } | null {
    const schedule = this.scheduleFor(region);
    const parsed = parseHhMm(schedule.time);
    if (!parsed) return null;
    const dateKey = zonedDateKey(now, schedule.timezone);
    return resolveWindowRange({
      dateKey,
      hour: parsed.hour,
      minute: parsed.minute,
      jitterMs: Math.max(0, schedule.jitterMinutes) * 60_000,
      timeZone: schedule.timezone,
    });
  }

  /** 已排定但还没到点的账号（管理页展示「N 个账号待签」）。 */
  private pendingAccounts(now: number): Array<{ account: PoolAccount; dueAt: number }> {
    const out: Array<{ account: PoolAccount; dueAt: number }> = [];
    for (const account of this.eligibleAccounts()) {
      if (this.checkedInToday(account, now)) continue;
      const region = account.record.region ?? 'cn';
      const schedule = this.scheduleFor(region);
      const dateKey = zonedDateKey(now, schedule.timezone);
      const dueAt = this.accountDueAt(account.record.name, region, dateKey);
      if (now < dueAt) out.push({ account, dueAt });
    }
    return out;
  }

  /** 某个区域的签到状态（管理页按区域展示）。 */
  private regionStatus(region: MinimaxRegion, now: number): CheckinRegionStatus {
    const schedule = this.scheduleFor(region);
    const window = this.currentWindow(region, now);
    const accounts = this.eligibleAccounts().filter((a) => (a.record.region ?? 'cn') === region);
    const pending = this.pendingAccounts(now).filter(
      (p) => (p.account.record.region ?? 'cn') === region,
    );
    let nextRunAt: number | null = null;
    const todayKey = zonedDateKey(now, schedule.timezone);
    const tomorrowKey = nextDateKey(todayKey);
    for (const account of accounts) {
      const dueAt = this.checkedInToday(account, now)
        ? this.accountDueAt(account.record.name, region, tomorrowKey)
        : this.accountDueAt(account.record.name, region, todayKey);
      if (nextRunAt === null || dueAt < nextRunAt) nextRunAt = dueAt;
    }
    return {
      time: schedule.time,
      jitterMinutes: schedule.jitterMinutes,
      timezone: schedule.timezone,
      windowStart: window?.start ?? null,
      windowEnd: window?.end ?? null,
      nextRunAt,
      pendingCount: pending.length,
      accountCount: accounts.length,
    };
  }

  /**
   * 下一次「该签的时刻」（epoch ms）—— 跨区域取最近的一个。
   *
   * 今天签完的账号 → 排到明天（明天的随机时刻与今天不同）；
   * 今天没签成的 → 排到今天该签的那一刻（已过则立即补签），
   * 但**失败重试至少隔 10 分钟** —— 否则「没签上」会让唤醒定时器变成热循环。
   */
  private nextDueAt(now: number): number | null {
    const accounts = this.eligibleAccounts();
    if (accounts.length === 0) return null;
    let best: number | null = null;
    const bump = (value: number): void => {
      if (best === null || value < best) best = value;
    };

    for (const account of accounts) {
      const region = account.record.region ?? 'cn';
      const schedule = this.scheduleFor(region);
      const todayKey = zonedDateKey(now, schedule.timezone);
      const tomorrowKey = nextDateKey(todayKey);
      if (this.checkedInToday(account, now)) {
        bump(this.accountDueAt(account.record.name, region, tomorrowKey));
        continue;
      }
      const dueAt = this.accountDueAt(account.record.name, region, todayKey);
      const attempted = this.lastCheckinAttempt.get(account.record.name);
      const retryAt =
        attempted === undefined ? dueAt : Math.max(dueAt, attempted + CHECKIN_RETRY_DELAY_MS);
      bump(retryAt);
    }
    return best;
  }

  /**
   * 排下一次**精确唤醒** —— 直接睡到下一个该签的那一刻。
   *
   * 为什么必须精确：兜底轮询是 30 分钟粒度，而随机窗口可能只有 ±5 分钟 ——
   * 只靠轮询会把所有签到挤到窗口边界上，随机就白随机了。
   */
  private scheduleCheckinWake(): void {
    if (this.checkinWakeTimer) {
      clearTimeout(this.checkinWakeTimer);
      this.checkinWakeTimer = null;
    }
    if (!this.config.autoCheckin.enabled) return;
    const now = Date.now();
    const due = this.nextDueAt(now);
    if (due === null) return;
    /* 提前 1 秒醒 —— 宁可早一点，也不要因为定时器精度错过窗口。 */
    const delay = Math.max(0, due - now - 1000);
    this.checkinWakeTimer = setTimeout(() => {
      this.checkinWakeTimer = null;
      void this.checkAndRunAutoCheckin();
    }, delay);
    this.checkinWakeTimer.unref?.();
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
    /* 防重入：同上。 */
    if (this.running.refresh) {
      this.log('[后台自动刷新] 上一轮尚未结束，本轮跳过');
      return;
    }
    this.running.refresh = true;
    try {
      await this.runAutoRefresh();
    } finally {
      this.running.refresh = false;
    }
  }

  /** 自动令牌刷新的实际执行体（与防重入解耦，便于单测）。 */
  private async runAutoRefresh(): Promise<void> {
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
