/**
 * 请求详情与缓存管理模块。
 *
 * 记录通过反代转发的入站请求、模型输入、模型输出（含流式与非流式聚合）、
 * Token 用量、状态码及耗时，并提供先进先出与按时长的缓存淘汰策略。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    finish_reason?: string;
    error?: string;
    raw?: unknown;
  } | null;
  error?: string | null;
}

export interface RequestStoreConfig {
  maxItems: number;
  retentionMs: number; // 0 表示不按时间清除
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

export class RequestStore {
  private items: RequestRecord[] = [];
  private totalLogged = 0;
  private config: RequestStoreConfig = {
    maxItems: DEFAULT_MAX_ITEMS,
    retentionMs: DEFAULT_RETENTION_MS,
  };
  private readonly configPath?: string;

  constructor(configPath?: string) {
    this.configPath = configPath;
    this.loadConfig();
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
    } catch {
      // 容错忽略损坏的配置文件
    }
  }

  private saveConfig(): void {
    if (!this.configPath) return;
    try {
      mkdirSync(dirname(this.configPath), { recursive: true });
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch {
      // 写入失败不中断主流程
    }
  }

  /**
   * 添加一条请求记录并执行清理。
   */
  add(record: RequestRecord): void {
    this.totalLogged += 1;
    this.items.unshift(record); // 最新记录放前面
    this.prune();
  }

  /**
   * 根据保留时长和数量上限清理过期缓存。
   */
  prune(): void {
    const now = Date.now();
    if (this.config.retentionMs > 0) {
      const cutoff = now - this.config.retentionMs;
      this.items = this.items.filter((item) => item.timestamp >= cutoff);
    }
    if (this.items.length > this.config.maxItems) {
      this.items.length = this.config.maxItems;
    }
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
    this.saveConfig();
    this.prune();
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

    // 粗略估算内存使用
    const approxBytes = this.items.reduce((acc, item) => {
      const inLen = item.input ? JSON.stringify(item.input).length : 0;
      const outLen = item.output ? JSON.stringify(item.output).length : 0;
      return acc + 300 + inLen + outLen;
    }, 0);

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
      estimatedMemoryBytes: approxBytes,
      config: { ...this.config },
    };
  }
}
