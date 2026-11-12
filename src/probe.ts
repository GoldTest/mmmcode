/**
 * 预热与测活服务。
 *
 * ## 1. 预热（Warm-up）
 * 目的：不占用 token 地让接口返回一次，验证凭证链路并保持连接/网关活跃。
 * 做法：调用 `/mavis/api/v1/llm/v1/messages/count_tokens`（Anthropic 计数端点），
 * 该端点走完整的鉴权与 LLM 网关路径，但不触发文本生成，消耗 0 token。
 *
 * ## 2. 测活（Liveness Probe）
 * 目的：ping 生文接口 `/mavis/api/v1/llm/v1/messages`（stream=true, max_tokens=1），
 * 测量**首字返回时间（TTFT）**，收到首字后立即中止连接以减少消耗。
 *
 * 阈值判定：
 *   · ttftMs <= 20s ：正常（若此前被标记为限流，自动解除限流标记并恢复 healthy）
 *   · 20s < ttftMs <= 30s ：危险，标记为「疑似被限流」（`rateLimited = true`），不再参与调度
 *   · ttftMs > 30s 或超时 ：严重限流/无响应，直接**暂停账号**（`enabled = false` + `rateLimited = true`）
 */

import { DEFAULT_MMCODE_CHAT_PATH, DEFAULT_MMCODE_COUNT_TOKENS_PATH } from './adapter.js';
import { getAgentBase, resolveRegion } from './credential.js';
import type { AccountRecord, ProbeSnapshot, WarmupSnapshot } from './accounts.js';
import type { AccountPool, PoolAccount } from './pool.js';

/** 首字延迟警戒阈值（ms）：超过 20s 标记疑似被限流。 */
export const PROBE_SUSPECTED_MS = 20_000;
/** 首字延迟暂停阈值（ms）：超过 30s 直接暂停账号。 */
export const PROBE_PAUSE_MS = 30_000;
/** 测活最大等待时长（ms）：略大于 30s 以保证能捕捉到超过 30s 的边界。 */
export const PROBE_TIMEOUT_MS = 32_000;
/** 预热请求超时（ms）。 */
export const WARMUP_TIMEOUT_MS = 15_000;

export interface ProbeOptions {
  baseUrl?: string;
  chatPath?: string;
  countTokensPath?: string;
  model?: string;
  suspectedMs?: number;
  pauseMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface WarmupResult {
  account: string;
  ok: boolean;
  durationMs: number;
  message: string;
  skipped?: boolean;
}

export interface ProbeResult {
  account: string;
  ok: boolean;
  status: ProbeSnapshot['status'];
  ttftMs: number;
  rateLimited: boolean;
  paused: boolean;
  message: string;
  skipped?: boolean;
}

function baseUrlFor(account: PoolAccount, override?: string): string {
  if (override) return override.replace(/\/+$/, '');
  const region = account.credential?.region ?? account.record.region ?? resolveRegion();
  return getAgentBase(region);
}

/**
 * 单账号预热：调用 count_tokens 接口，不占用 token 地让接口返回一次。
 */
export async function warmupAccount(
  pool: AccountPool,
  account: PoolAccount,
  opts: ProbeOptions = {},
): Promise<WarmupResult> {
  const name = account.record.name;
  const store = pool.getAccountStore();
  const fetchFn = opts.fetchImpl ?? fetch;

  if (!account.credential) {
    return { account: name, ok: false, durationMs: 0, message: '未登录，无法预热', skipped: true };
  }

  let token: string;
  try {
    token = await account.tokens.accessToken();
  } catch (err) {
    const msg = `获取令牌失败：${(err as Error).message}`;
    const snap: WarmupSnapshot = { at: Date.now(), durationMs: 0, ok: false, message: msg };
    store.update(name, { lastWarmup: snap, health: 'unauthorized', healthDetail: msg });
    return { account: name, ok: false, durationMs: 0, message: msg };
  }

  const url = `${baseUrlFor(account, opts.baseUrl)}${opts.countTokensPath ?? DEFAULT_MMCODE_COUNT_TOKENS_PATH}`;
  const model = opts.model ?? 'MiniMax-M3';
  const start = Date.now();

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'anthropic-version': '2023-06-01',
        'user-agent': 'MiniMaxCode',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? WARMUP_TIMEOUT_MS),
    });

    const durationMs = Date.now() - start;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const msg = `预热失败（HTTP ${res.status}${text ? `：${text.slice(0, 120)}` : ''}）`;
      const snap: WarmupSnapshot = { at: Date.now(), durationMs, ok: false, message: msg };
      const patch: Partial<AccountRecord> = { lastWarmup: snap };
      if (res.status === 401 || res.status === 403) {
        patch.health = 'unauthorized';
        patch.healthDetail = msg;
      } else if (res.status === 429) {
        patch.health = 'rate_limited';
        patch.rateLimited = true;
        patch.rateLimitReason = '预热收到 429 限流响应';
        patch.healthDetail = msg;
      }
      store.update(name, patch);
      return { account: name, ok: false, durationMs, message: msg };
    }

    await res.text().catch(() => '');
    const msg = `预热成功（${durationMs}ms，0 token）`;
    const snap: WarmupSnapshot = { at: Date.now(), durationMs, ok: true, message: msg };
    store.update(name, { lastWarmup: snap });
    return { account: name, ok: true, durationMs, message: msg };
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = `预热异常：${(err as Error).message}`;
    const snap: WarmupSnapshot = { at: Date.now(), durationMs, ok: false, message: msg };
    store.update(name, { lastWarmup: snap });
    return { account: name, ok: false, durationMs, message: msg };
  }
}

/**
 * 判断一段 SSE 文本缓冲区中是否已经包含「首字」内容。
 *
 * Anthropic 流式事件里，生文开始通常是 `content_block_delta`（带有 text_delta / thinking_delta），
 * 或带有非空 text 的 `content_block_start`。
 */
function hasFirstTokenInSse(buffer: string): boolean {
  const lines = buffer.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const ev = JSON.parse(payload) as Record<string, unknown>;
      if (ev.type === 'content_block_delta') {
        const delta = ev.delta as Record<string, unknown> | undefined;
        if (delta) {
          if (typeof delta.text === 'string' && delta.text.length > 0) return true;
          if (typeof delta.thinking === 'string' && delta.thinking.length > 0) return true;
          if (delta.type === 'text_delta' || delta.type === 'thinking_delta') return true;
        }
      }
      if (ev.type === 'content_block_start') {
        const cb = ev.content_block as Record<string, unknown> | undefined;
        if (cb && typeof cb.text === 'string' && cb.text.length > 0) return true;
      }
    } catch {
      /* 半包 JSON 继续等下一个 chunk */
    }
  }
  return false;
}

/**
 * 单账号测活：ping 生文接口，测量首字返回时间（TTFT）。
 *
 *   · <= 20s：正常，解除限流标记
 *   · > 20s 且 <= 30s：危险，标记账号疑似被限流（不再调度）
 *   · > 30s 或超时未返回首字：直接暂停账号（enabled=false + 限流标记）
 */
export async function probeAccount(
  pool: AccountPool,
  account: PoolAccount,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const name = account.record.name;
  const store = pool.getAccountStore();
  const fetchFn = opts.fetchImpl ?? fetch;
  const suspectedMs = opts.suspectedMs ?? PROBE_SUSPECTED_MS;
  const pauseMs = opts.pauseMs ?? PROBE_PAUSE_MS;
  const timeoutMs = opts.timeoutMs ?? Math.max(PROBE_TIMEOUT_MS, pauseMs + 2_000);

  if (!account.credential) {
    return {
      account: name,
      ok: false,
      status: 'error',
      ttftMs: 0,
      rateLimited: Boolean(account.record.rateLimited),
      paused: !account.record.enabled,
      message: '未登录，跳过测活',
      skipped: true,
    };
  }

  let token: string;
  try {
    token = await account.tokens.accessToken();
  } catch (err) {
    const msg = `获取令牌失败：${(err as Error).message}`;
    const snap: ProbeSnapshot = { at: Date.now(), ttftMs: 0, status: 'error', message: msg };
    store.update(name, { lastProbe: snap, health: 'unauthorized', healthDetail: msg });
    return {
      account: name,
      ok: false,
      status: 'error',
      ttftMs: 0,
      rateLimited: Boolean(account.record.rateLimited),
      paused: !account.record.enabled,
      message: msg,
    };
  }

  const url = `${baseUrlFor(account, opts.baseUrl)}${opts.chatPath ?? DEFAULT_MMCODE_CHAT_PATH}`;
  const model = opts.model ?? 'MiniMax-M3';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'anthropic-version': '2023-06-01',
        'user-agent': 'MiniMaxCode',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '1' }],
        max_tokens: 1,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const ttftMs = Date.now() - start;
      const text = await res.text().catch(() => '');
      const detail = `HTTP ${res.status}${text ? `：${text.slice(0, 120)}` : ''}`;

      if (res.status === 429) {
        const msg = `测活触发 429 限流（${detail}），已标记限流并暂停调度`;
        const snap: ProbeSnapshot = { at: Date.now(), ttftMs, status: 'suspected', message: msg };
        store.update(name, {
          lastProbe: snap,
          rateLimited: true,
          rateLimitReason: '测活收到上游 429 限流',
          health: 'rate_limited',
          healthDetail: msg,
        });
        return {
          account: name,
          ok: false,
          status: 'suspected',
          ttftMs,
          rateLimited: true,
          paused: !account.record.enabled,
          message: msg,
        };
      }

      if (res.status === 401 || res.status === 403) {
        const msg = `测活鉴权失败（${detail}），凭证已失效`;
        const snap: ProbeSnapshot = { at: Date.now(), ttftMs, status: 'error', message: msg };
        store.update(name, {
          lastProbe: snap,
          health: 'unauthorized',
          healthDetail: msg,
        });
        return {
          account: name,
          ok: false,
          status: 'error',
          ttftMs,
          rateLimited: Boolean(account.record.rateLimited),
          paused: !account.record.enabled,
          message: msg,
        };
      }

      const msg = `测活失败（${detail}）`;
      const snap: ProbeSnapshot = { at: Date.now(), ttftMs, status: 'error', message: msg };
      store.update(name, { lastProbe: snap, health: 'error', healthDetail: msg });
      return {
        account: name,
        ok: false,
        status: 'error',
        ttftMs,
        rateLimited: Boolean(account.record.rateLimited),
        paused: !account.record.enabled,
        message: msg,
      };
    }

    let ttftMs: number | null = null;
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream') && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (hasFirstTokenInSse(buffer)) {
            ttftMs = Date.now() - start;
            break;
          }
          /* 一旦等待时间已超过暂停阈值，无需再死等，直接判定超时。 */
          if (Date.now() - start > pauseMs) {
            ttftMs = Date.now() - start;
            break;
          }
        }
      } finally {
        /* 拿到首字或超时即主动取消流，节省时间和 token。 */
        controller.abort();
        await reader.cancel().catch(() => {});
      }
      if (ttftMs === null) {
        ttftMs = Date.now() - start;
      }
    } else {
      await res.text().catch(() => '');
      ttftMs = Date.now() - start;
    }

    return applyProbeThreshold(pool, account, ttftMs, suspectedMs, pauseMs);
  } catch (err) {
    const elapsed = Date.now() - start;
    const isAbort = (err as Error)?.name === 'AbortError' || controller.signal.aborted;
    if (isAbort || elapsed >= pauseMs) {
      return applyProbeThreshold(pool, account, Math.max(elapsed, pauseMs + 1), suspectedMs, pauseMs);
    }
    const msg = `测活网络异常：${(err as Error).message}`;
    const snap: ProbeSnapshot = { at: Date.now(), ttftMs: elapsed, status: 'error', message: msg };
    store.update(name, { lastProbe: snap, health: 'error', healthDetail: msg });
    return {
      account: name,
      ok: false,
      status: 'error',
      ttftMs: elapsed,
      rateLimited: Boolean(account.record.rateLimited),
      paused: !account.record.enabled,
      message: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

function applyProbeThreshold(
  pool: AccountPool,
  account: PoolAccount,
  ttftMs: number,
  suspectedMs: number,
  pauseMs: number,
): ProbeResult {
  const name = account.record.name;
  const store = pool.getAccountStore();
  const secStr = (ttftMs / 1000).toFixed(1);

  if (ttftMs > pauseMs) {
    const msg = `首字响应超过 ${Math.round(pauseMs / 1000)}s（${secStr}s），已自动暂停账号并标记限流`;
    const snap: ProbeSnapshot = { at: Date.now(), ttftMs, status: 'paused', message: msg };
    store.update(name, {
      enabled: false,
      rateLimited: true,
      rateLimitReason: `测活首字超时 ${secStr}s（>${Math.round(pauseMs / 1000)}s），已自动暂停`,
      health: 'rate_limited',
      healthDetail: msg,
      lastProbe: snap,
    });
    return {
      account: name,
      ok: false,
      status: 'paused',
      ttftMs,
      rateLimited: true,
      paused: true,
      message: msg,
    };
  }

  if (ttftMs > suspectedMs) {
    const msg = `首字响应耗时 ${secStr}s（>${Math.round(suspectedMs / 1000)}s），疑似被限流，已暂停调度`;
    const snap: ProbeSnapshot = { at: Date.now(), ttftMs, status: 'suspected', message: msg };
    store.update(name, {
      rateLimited: true,
      rateLimitReason: `首字延迟 ${secStr}s（疑似被限流）`,
      health: 'rate_limited',
      healthDetail: msg,
      lastProbe: snap,
    });
    return {
      account: name,
      ok: false,
      status: 'suspected',
      ttftMs,
      rateLimited: true,
      paused: !account.record.enabled,
      message: msg,
    };
  }

  const msg = `首字响应耗时 ${ttftMs}ms，状态正常`;
  const snap: ProbeSnapshot = { at: Date.now(), ttftMs, status: 'ok', message: msg };
  store.update(name, {
    rateLimited: false,
    rateLimitReason: undefined,
    health: 'healthy',
    healthDetail: undefined,
    lastProbe: snap,
  });
  return {
    account: name,
    ok: true,
    status: 'ok',
    ttftMs,
    rateLimited: false,
    paused: !account.record.enabled,
    message: msg,
  };
}

/** 简单的并发控制执行器。 */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await fn(items[current]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 批量预热：对所有已登录的账号（或指定列表）执行预热。
 */
export async function warmupAllAccounts(
  pool: AccountPool,
  opts: ProbeOptions & { names?: string[]; concurrency?: number } = {},
): Promise<WarmupResult[]> {
  const targets = selectTargets(pool, opts.names);
  return runWithConcurrency(targets, opts.concurrency ?? 4, (acc) => warmupAccount(pool, acc, opts));
}

/**
 * 批量测活：对所有已登录且未停用的账号（或指定列表）执行测活。
 */
export async function probeAllAccounts(
  pool: AccountPool,
  opts: ProbeOptions & { names?: string[]; concurrency?: number } = {},
): Promise<ProbeResult[]> {
  const targets = selectTargets(pool, opts.names);
  return runWithConcurrency(targets, opts.concurrency ?? 3, (acc) => probeAccount(pool, acc, opts));
}

function selectTargets(pool: AccountPool, names?: string[]): PoolAccount[] {
  const all = pool.refresh();
  if (Array.isArray(names) && names.length > 0) {
    const set = new Set(names);
    return all.filter((a) => set.has(a.record.name));
  }
  return all.filter((a) => a.credential !== null && a.record.enabled);
}
