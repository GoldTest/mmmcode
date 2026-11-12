/**
 * 请求详情与缓存管理模块。
 *
 * 记录通过反代转发的入站请求、模型输入、模型输出（含流式与非流式聚合）、
 * Token 用量、状态码及耗时，并提供先进先出与按时长的缓存淘汰策略。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { approxBytes, clipRecord } from './clip.js';

export interface RequestRecord {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  clientIp?: string;
  keyId?: string | null;
  keyName?: string | null;
  keyMasked?: string | null;
  model?: string | null;
  stream: boolean;
  status: number;
  durationMs: number;
  /**
   * 首字符时间（ms）—— 从收到请求到**第一个响应字节**。
   *
   * 与 `durationMs`（整段耗时）的差别：流式响应里，客户端等的是「第一句话什么时候来」，
   * 那才是体感上的快慢；总耗时还包含了把整段话吐完的时间。
   * 非流式 / 没拿到响应体时为 null。
   */
  firstByteMs?: number | null;
  /**
   * 中转信息 —— 反代内部把入站请求**转译成上游协议**后的情况。
   *
   * 排查「为什么上游收到的东西和我发的不一样」时要看这里。
   */
  transit?: RequestTransit | null;
  account?: string | null;
  input?: {
    messages?: Array<{ role: string; content: unknown }>;
    prompt?: string;
    model?: string;
    temperature?: number;
    max_tokens?: number;
    raw?: unknown;
  } | null;
  output?: {
    text?: string;
    toolCalls?: unknown[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      /** 缓存命中（读）的 token 数。 */
      cached_tokens?: number;
      /** 缓存命中率（0–1）= cached_tokens / prompt_tokens。 */
      cache_hit_rate?: number;
    };
    finish_reason?: string;
    error?: string;
    raw?: unknown;
  } | null;
  error?: string | null;
}

/**
 * 中转信息 —— 反代实际发往上游请求的关键信息。
 *
 * 入站与出站均为原生 Anthropic 协议（剥离仅用于本地识别 session 的非标准顶层字段），
 * 记录实际发给上游的地址、账号与请求体，便于排查「我发的和上游收到的不一样」。
 */
export interface RequestTransit {
  /** 上游地址（不含任何令牌）。 */
  upstream: string;
  /** 实际服务这次请求的账号。 */
  account: string | null;
  /** 出站协议（原生 Anthropic）。 */
  protocol: string;
  /** 实际发给上游的请求体。 */
  payload?: unknown;
}

export interface RequestStoreConfig {
  maxItems: number;
  retentionMs: number; // 0 表示不按时间清除
  /**
   * 内存里的**总字节预算**（含裁剪后的记录）。
   *
   * 条数上限 alone 不够 —— 一条记录的大小由**客户端请求体**决定（Claude Code
   * 一轮上下文可达数 MB）。200 条 × 数 MB = 数百 MB，容器直接被吃干。
   * 所以再加一道**字节闸**：超预算就淘汰最旧的记录。
   */
  maxBytes: number;
}

export interface RequestStats {
  totalLogged: number;
  cachedCount: number;
  successCount: number;
  errorCount: number;
  avgDurationMs: number;
  totalTokens: {
    prompt: number;
    completion: number;
    total: number;
  };
  oldestTimestamp: number | null;
  estimatedMemoryBytes: number;
  config: RequestStoreConfig;
}

export interface RequestListFilter {
  since?: number;
  limit?: number;
  offset?: number;
  status?: 'all' | 'success' | 'error';
  model?: string;
  account?: string;
  search?: string;
}

export const DEFAULT_MAX_ITEMS = 200;
export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000; // 默认保留 24 小时
/** 默认内存字节预算：64MB。配合单条裁剪（48KB）≈ 最多一千多条小记录或几百条大记录。 */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 落盘节流间隔（ms）。
 *
 * ★ 之前是 2 秒 —— 而每次落盘都要把**整个** items 数组 `JSON.stringify` 一遍。
 *   200 条 × 数十 KB = 每 2 秒生成一个几 MB 的临时字符串 → 纯粹的 GC 压力源
 *   （它不是"泄漏"，但会持续推高 RSS 并触发频繁 GC）。
 *   改到 10 秒：请求监控是**事后排查**用的工具，不差这几秒。
 */
const SAVE_THROTTLE_MS = 10_000;

export interface RequestsDataFile {
  version: number;
  updatedAt: number;
  totalLogged: number;
  items: RequestRecord[];
}

export class RequestStore {
  private items: RequestRecord[] = [];
  private totalLogged = 0;
  /** 每条记录的估算字节数（id → bytes）—— 避免每次淘汰都重新 stringify。 */
  private readonly sizes = new Map<string, number>();
  /** 当前留存记录的估算总字节数。 */
  private bytes = 0;
  private config: RequestStoreConfig = {
    maxItems: DEFAULT_MAX_ITEMS,
    retentionMs: DEFAULT_RETENTION_MS,
    maxBytes: DEFAULT_MAX_BYTES,
  };
  private readonly configPath?: string;
  private readonly dataPath?: string;
  private lastFlush = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(configPath?: string, dataPath?: string) {
    this.configPath = configPath;
    this.dataPath = dataPath ?? (configPath ? dirname(configPath) + '/requests.json' : undefined);
    this.loadConfig();
    this.loadData();
  }

  private loadConfig(): void {
    if (!this.configPath || !existsSync(this.configPath)) return;
    try {
      const data = JSON.parse(readFileSync(this.configPath, 'utf8')) as Partial<RequestStoreConfig>;
      if (typeof data.maxItems === 'number' && data.maxItems > 0) {
        this.config.maxItems = Math.min(Math.max(10, data.maxItems), 5000);
      }
      if (typeof data.retentionMs === 'number' && data.retentionMs >= 0) {
        this.config.retentionMs = data.retentionMs;
      }
      if (typeof data.maxBytes === 'number' && data.maxBytes > 0) {
        this.config.maxBytes = Math.min(Math.max(4 * 1024 * 1024, data.maxBytes), 512 * 1024 * 1024);
      }
    } catch {
      // 容错忽略损坏的配置文件
    }
  }

  private saveConfig(): void {
    if (!this.configPath) return;
    try {
      mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 });
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch {
      // 写入失败不中断主流程
    }
  }

  private loadData(): void {
    if (!this.dataPath || !existsSync(this.dataPath)) return;
    try {
      const data = JSON.parse(readFileSync(this.dataPath, 'utf8')) as Partial<RequestsDataFile>;
      if (typeof data.totalLogged === 'number' && data.totalLogged >= 0) {
        this.totalLogged = data.totalLogged;
      }
      if (Array.isArray(data.items)) {
        this.items = data.items.filter((item) => item && typeof item === 'object' && typeof item.id === 'string');
        /* 载入的历史记录也要计字节 —— 否则字节闸会失准（以为自己是空的）。 */
        for (const item of this.items) {
          const bytes = approxBytes(item);
          this.sizes.set(item.id, bytes);
          this.bytes += bytes;
        }
        this.prune();
        if (this.totalLogged < this.items.length) {
          this.totalLogged = this.items.length;
        }
      }
    } catch {
      // 容错忽略损坏的文件
    }
  }

  private saveData(): void {
    if (!this.dataPath) return;
    try {
      mkdirSync(dirname(this.dataPath), { recursive: true, mode: 0o700 });
      const tmp = `${this.dataPath}.tmp-${process.pid}`;
      const data: RequestsDataFile = {
        version: 1,
        updatedAt: Date.now(),
        totalLogged: this.totalLogged,
        items: this.items,
      };
      /* 只 stringify 一次 —— 之前两条路径各 stringify 一遍，白白翻倍瞬时内存。 */
      const text = JSON.stringify(data, null, 2) + '\n';
      writeFileSync(tmp, text, { mode: 0o600 });
      try {
        chmodSync(tmp, 0o600);
      } catch {
        /* Windows */
      }
      try {
        renameSync(tmp, this.dataPath);
      } catch {
        try {
          writeFileSync(this.dataPath, text, { mode: 0o600 });
        } catch {}
        try {
          unlinkSync(tmp);
        } catch {}
      }
    } catch {
      // 写入失败不中断主流程
    }
  }

  private scheduleSave(): void {
    if (!this.dataPath) return;
    const now = Date.now();
    if (now - this.lastFlush >= SAVE_THROTTLE_MS) {
      this.lastFlush = now;
      this.saveData();
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.lastFlush = Date.now();
      this.saveData();
    }, SAVE_THROTTLE_MS);
    this.flushTimer.unref?.();
  }

  /**
   * 立即将未写入的请求记录持久化至磁盘。
   */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.lastFlush = Date.now();
    this.saveData();
  }

  /**
   * 添加一条请求记录并执行清理。
   *
   * ★ 记录在**入库前**先裁剪（`clipRecord`）—— 客户端的请求体大小不受我们控制，
   *   不裁剪的话条数上限形同虚设。
   */
  add(record: RequestRecord): void {
    this.totalLogged += 1;
    const { value, bytes } = clipRecord(record);
    this.items.unshift(value); // 最新记录放前面
    this.sizes.set(value.id, bytes);
    this.bytes += bytes;
    this.prune();
    this.scheduleSave();
  }

  /**
   * 根据保留时长和数量上限清理过期缓存。
   *
   * 三道闸（任一触发就淘汰最旧的）：
   *   ① 保留时长；② 条数上限；③ **字节预算**。
   */
  prune(): void {
    const now = Date.now();
    if (this.config.retentionMs > 0) {
      const cutoff = now - this.config.retentionMs;
      const kept = this.items.filter((item) => item.timestamp >= cutoff);
      if (kept.length !== this.items.length) {
        for (const item of this.items) {
          if (item.timestamp < cutoff) this.dropSize(item.id);
        }
        this.items = kept;
      }
    }
    while (this.items.length > this.config.maxItems) {
      const dropped = this.items.pop();
      if (!dropped) break;
      this.dropSize(dropped.id);
    }
    /* 字节闸：超预算就丢最旧的（items[0] 最新，末尾最旧）。 */
    while (this.bytes > this.config.maxBytes && this.items.length > 1) {
      const dropped = this.items.pop();
      if (!dropped) break;
      this.dropSize(dropped.id);
    }
  }

  /** 丢掉一条记录的字节记账。 */
  private dropSize(id: string): void {
    const size = this.sizes.get(id);
    if (size === undefined) return;
    this.sizes.delete(id);
    this.bytes -= size;
    if (this.bytes < 0) this.bytes = 0;
  }

  /**
   * 获取单条记录。
   */
  get(id: string): RequestRecord | undefined {
    return this.items.find((item) => item.id === id);
  }

  /**
   * 清空所有缓存的请求。
   */
  clear(): void {
    this.items = [];
    this.sizes.clear();
    this.bytes = 0;
    this.saveData();
  }

  /**
   * 更新配置。
   */
  updateConfig(patch: Partial<RequestStoreConfig>): RequestStoreConfig {
    if (typeof patch.maxItems === 'number' && patch.maxItems > 0) {
      this.config.maxItems = Math.min(Math.max(1, patch.maxItems), 5000);
    }
    if (typeof patch.retentionMs === 'number' && patch.retentionMs >= 0) {
      this.config.retentionMs = patch.retentionMs;
    }
    if (typeof patch.maxBytes === 'number' && patch.maxBytes > 0) {
      this.config.maxBytes = Math.min(Math.max(4 * 1024 * 1024, patch.maxBytes), 512 * 1024 * 1024);
    }
    this.saveConfig();
    this.prune();
    this.scheduleSave();
    return { ...this.config };
  }

  getConfig(): RequestStoreConfig {
    return { ...this.config };
  }

  /**
   * 按条件列出请求记录。
   */
  list(filter: RequestListFilter = {}): { items: RequestRecord[]; total: number } {
    this.prune();
    let result = this.items;

    if (typeof filter.since === 'number' && filter.since > 0) {
      result = result.filter((item) => item.timestamp > filter.since!);
    }

    if (filter.status === 'success') {
      result = result.filter((item) => item.status >= 200 && item.status < 300);
    } else if (filter.status === 'error') {
      result = result.filter((item) => item.status >= 400 || item.error);
    }

    if (filter.model) {
      const m = filter.model.toLowerCase();
      result = result.filter((item) => item.model?.toLowerCase().includes(m));
    }

    if (filter.account) {
      result = result.filter((item) => item.account === filter.account);
    }

    if (filter.search) {
      const q = filter.search.toLowerCase();
      result = result.filter((item) => {
        if (item.id.toLowerCase().includes(q)) return true;
        if (item.path.toLowerCase().includes(q)) return true;
        if (item.model?.toLowerCase().includes(q)) return true;
        if (item.keyName?.toLowerCase().includes(q)) return true;
        if (item.account?.toLowerCase().includes(q)) return true;
        if (item.input?.prompt?.toLowerCase().includes(q)) return true;
        if (item.output?.text?.toLowerCase().includes(q)) return true;
        if (item.error?.toLowerCase().includes(q)) return true;
        if (item.input?.messages?.some((msg) => JSON.stringify(msg.content).toLowerCase().includes(q))) return true;
        return false;
      });
    }

    const total = result.length;
    const offset = Math.max(0, filter.offset ?? 0);
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 200));

    return {
      items: result.slice(offset, offset + limit),
      total,
    };
  }

  /**
   * 汇总统计信息。
   */
  stats(): RequestStats {
    this.prune();
    let successCount = 0;
    let errorCount = 0;
    let totalDuration = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let oldestTimestamp: number | null = null;

    for (const item of this.items) {
      if (item.status >= 200 && item.status < 300) {
        successCount += 1;
      } else {
        errorCount += 1;
      }
      totalDuration += item.durationMs || 0;

      if (item.output?.usage) {
        promptTokens += item.output.usage.prompt_tokens ?? 0;
        completionTokens += item.output.usage.completion_tokens ?? 0;
        totalTokens += item.output.usage.total_tokens ?? 0;
      }

      if (oldestTimestamp === null || item.timestamp < oldestTimestamp) {
        oldestTimestamp = item.timestamp;
      }
    }

    // 粗略估算内存使用 —— 用记账的字节数，别再逐条 stringify（那会瞬时翻倍内存）。
    const approxTotal = this.bytes;

    return {
      totalLogged: this.totalLogged,
      cachedCount: this.items.length,
      successCount,
      errorCount,
      avgDurationMs: this.items.length > 0 ? Math.round(totalDuration / this.items.length) : 0,
      totalTokens: {
        prompt: promptTokens,
        completion: completionTokens,
        total: totalTokens,
      },
      oldestTimestamp,
      estimatedMemoryBytes: approxTotal,
      config: { ...this.config },
    };
  }
}
