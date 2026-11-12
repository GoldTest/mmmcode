/**
 * 账号用量洞察台账 —— 「各个账号到底用了多少 token」。
 *
 * ## 数据从哪来
 * 上游 mavis 回的是 **Anthropic 事件流**，其中 `message_start` / `message_delta`
 * 带权威 usage。本模块在**适配器侧**把用量摘出来（见 `adapter.ts` 的用量采集），
 * 连同「这次请求实际用了哪个账号」一起记账 —— 因此统计口径是**账号级真实消耗**，
 * 而不是估算。
 *
 * ## 口径（与 `protocol/usage.ts` 保持一致）
 *   prompt_tokens     = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 *   completion_tokens = output_tokens
 *   cached_tokens     = cache_read_input_tokens（只算**读**命中；写入不算命中）
 *
 * ## 为什么单独落一个台账，而不是从请求日志里聚合
 * 请求日志（`requests.ts`）是**环形缓冲**（条数上限 + 保留时长），会淘汰旧记录 ——
 * 拿它做「累计用量」会随时间失真。台账是**累计型**的，独立落盘。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { waygateRoot } from './accounts.js';

/** 一天用量。 */
export interface DayUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
}

/** 单个账号的累计用量。 */
export interface AccountInsight {
  /** 服务该账号的请求数。 */
  requests: number;
  /** 命中过该账号的**不同 session** 数（近似值，见 `sessionKeys` 说明）。 */
  sessions: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  firstUsedAt: number | null;
  lastUsedAt: number | null;
  /** 按模型拆分。 */
  byModel: Record<string, { requests: number; totalTokens: number }>;
  /** 按天拆分（key = YYYY-MM-DD）。 */
  byDay: Record<string, DayUsage>;
  /**
   * 最近命中的 session key（**哈希**，非明文）。
   *
   * 保留它是为了让「不同 session 数」在重启后仍然准 —— 只存计数的话，
   * 重启后内存里的集合清零，同一个会话会被重复计数。数组有上限，防止无限增长。
   */
  sessionKeys: string[];
}

/** 一次记账的输入。 */
export interface UsageRecord {
  /** 服务这次请求的账号名。 */
  account: string;
  /** 本次请求的 session key（哈希）。 */
  sessionKey?: string;
  /** 模型名。 */
  model?: string;
  /** 输入 token（含缓存写入 / 读取）。 */
  promptTokens: number;
  /** 输出 token。 */
  completionTokens: number;
  /** 缓存命中（读）。 */
  cachedTokens: number;
  /** 记账时刻。 */
  at?: number;
}

interface InsightsFile {
  version: number;
  updatedAt: number;
  accounts: Record<string, AccountInsight>;
}

const FILE_VERSION = 1;

/** 每个账号保留的 session key 上限。 */
const MAX_SESSION_KEYS = 500;

/** 按天桶保留的上限（天）。 */
const MAX_DAYS = 90;

/** 落盘节流间隔（ms）—— 高频请求下别每次都写盘。 */
const FLUSH_THROTTLE_MS = 2_000;

function emptyInsight(): AccountInsight {
  return {
    requests: 0,
    sessions: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    firstUsedAt: null,
    lastUsedAt: null,
    byModel: {},
    byDay: {},
    sessionKeys: [],
  };
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 缓存命中率 = **缓存命中的 token / 输入 token**。
 *
 * 分母是「输入 token 总数」（原始输入 + 缓存写入 + 缓存读取）—— 也就是
 * 「这次输入里有多少直接命中了缓存」。上游没给缓存字段时为 0。
 */
function hitRate(insight: { cachedTokens: number; promptTokens: number }): number {
  if (!Number.isFinite(insight.promptTokens) || insight.promptTokens <= 0) return 0;
  return Math.max(0, Math.min(1, insight.cachedTokens / insight.promptTokens));
}

/** 台账文件路径。 */
export function insightsFilePath(): string {
  return join(waygateRoot(), 'mmcode', 'insights.json');
}

export class InsightsLedger {
  private data: InsightsFile;
  private readonly filePath: string;
  private lastFlush = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(opts: { filePath?: string } = {}) {
    this.filePath = opts.filePath ?? insightsFilePath();
    this.data = this.load();
  }

  private load(): InsightsFile {
    const empty: InsightsFile = { version: FILE_VERSION, updatedAt: 0, accounts: {} };
    if (!existsSync(this.filePath)) return empty;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<InsightsFile>;
      const accounts: Record<string, AccountInsight> = {};
      if (parsed.accounts && typeof parsed.accounts === 'object') {
        for (const [name, raw] of Object.entries(parsed.accounts)) {
          if (!raw || typeof raw !== 'object') continue;
          accounts[name] = { ...emptyInsight(), ...raw } as AccountInsight;
        }
      }
      return { version: FILE_VERSION, updatedAt: parsed.updatedAt ?? 0, accounts };
    } catch {
      /* 坏文件：从空台账起步（丢了只是丢历史统计，不影响服务）。 */
      return empty;
    }
  }

  private write(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    this.data.updatedAt = Date.now();
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* Windows 上 chmod 语义有限 */
    }
    try {
      renameSync(tmp, this.filePath);
    } catch {
      try {
        writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
      } catch {
        /* 落盘失败不影响记账（内存里还在）。 */
      }
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  /** 记账一次请求的用量。 */
  record(rec: UsageRecord): void {
    const at = rec.at ?? Date.now();
    const insight = this.data.accounts[rec.account] ?? (this.data.accounts[rec.account] = emptyInsight());

    const prompt = Number.isFinite(rec.promptTokens) ? rec.promptTokens : 0;
    const completion = Number.isFinite(rec.completionTokens) ? rec.completionTokens : 0;
    const cached = Number.isFinite(rec.cachedTokens) ? rec.cachedTokens : 0;

    insight.requests += 1;
    insight.promptTokens += prompt;
    insight.completionTokens += completion;
    insight.cachedTokens += cached;
    insight.totalTokens += prompt + completion;
    insight.firstUsedAt = insight.firstUsedAt === null ? at : Math.min(insight.firstUsedAt, at);
    insight.lastUsedAt = insight.lastUsedAt === null ? at : Math.max(insight.lastUsedAt, at);

    const model = rec.model && rec.model.trim() ? rec.model.trim() : 'unknown';
    const m = insight.byModel[model] ?? (insight.byModel[model] = { requests: 0, totalTokens: 0 });
    m.requests += 1;
    m.totalTokens += prompt + completion;

    const day = insight.byDay[dayKey(at)] ?? (insight.byDay[dayKey(at)] = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
    });
    day.requests += 1;
    day.promptTokens += prompt;
    day.completionTokens += completion;
    day.cachedTokens += cached;
    day.totalTokens += prompt + completion;

    if (rec.sessionKey) {
      const keys = insight.sessionKeys;
      if (!keys.includes(rec.sessionKey)) {
        keys.push(rec.sessionKey);
        if (keys.length > MAX_SESSION_KEYS) keys.splice(0, keys.length - MAX_SESSION_KEYS);
      }
      insight.sessions = keys.length;
    }

    this.prune(insight);
    this.scheduleFlush();
  }

  /** 老的按天桶丢掉（保留最近 MAX_DAYS 天）。 */
  private prune(insight: AccountInsight): void {
    const days = Object.keys(insight.byDay).sort();
    if (days.length <= MAX_DAYS) return;
    for (const day of days.slice(0, days.length - MAX_DAYS)) {
      delete insight.byDay[day];
    }
  }

  /** 节流落盘。 */
  private scheduleFlush(): void {
    const now = Date.now();
    if (now - this.lastFlush >= FLUSH_THROTTLE_MS) {
      this.lastFlush = now;
      this.write();
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.lastFlush = Date.now();
      this.write();
    }, FLUSH_THROTTLE_MS);
    this.flushTimer.unref?.();
  }

  /** 立即落盘（退出前/管理接口调用）。 */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.lastFlush = Date.now();
    this.write();
  }

  /** 全部账号的快照（按总 token 倒序）。 */
  snapshot(): Array<AccountInsight & { name: string; cacheHitRate: number }> {
    return Object.entries(this.data.accounts)
      .map(([name, insight]) => ({ name, ...insight, cacheHitRate: hitRate(insight) }))
      .sort((a, b) => b.totalTokens - a.totalTokens);
  }

  /** 单账号快照（与 `snapshot()` 同形 —— 含派生的缓存命中率）。 */
  get(name: string): (AccountInsight & { name: string; cacheHitRate: number }) | null {
    const found = this.data.accounts[name];
    return found ? { name, ...found, cacheHitRate: hitRate(found) } : null;
  }

  /** 汇总。 */
  totals(): {
    accounts: number;
    requests: number;
    sessions: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    totalTokens: number;
    /** 整体缓存命中率（0–1）。 */
    cacheHitRate: number;
  } {
    let requests = 0;
    let sessions = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    let totalTokens = 0;
    for (const insight of Object.values(this.data.accounts)) {
      requests += insight.requests;
      sessions += insight.sessions;
      promptTokens += insight.promptTokens;
      completionTokens += insight.completionTokens;
      cachedTokens += insight.cachedTokens;
      totalTokens += insight.totalTokens;
    }
    return {
      accounts: Object.keys(this.data.accounts).length,
      requests,
      sessions,
      promptTokens,
      completionTokens,
      cachedTokens,
      totalTokens,
      cacheHitRate: hitRate({ cachedTokens, promptTokens }),
    };
  }

  /** 清掉某个账号的统计。 */
  resetAccount(name: string): boolean {
    if (!(name in this.data.accounts)) return false;
    delete this.data.accounts[name];
    this.flush();
    return true;
  }

  /** 清空全部统计。 */
  resetAll(): void {
    this.data.accounts = {};
    this.flush();
  }
}
