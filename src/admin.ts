/**
 * 管理端密钥与会话。
 *
 * ## 需求
 * 管理网页（`mmcode web`）**必须**持密钥才能进；未设置时**自动生成一个**；
 * 之后**可修改**。
 *
 * ## 为什么用「文件 + 首次打印」而不是「环境变量」
 * 环境变量方案有两个硬伤：
 *   1. 容器重启 / `docker compose up` 时环境变量往往不会重新生成 —— 用户拿不到稳定密钥；
 *   2. 与「未设置则默认生成一个」直接矛盾（环境变量缺失应该是**报错**，不是生成）。
 * 于是落盘到 `~/.waygate/mmcode/admin.json`（0600）：
 *   · 重启不丢、容器里挂卷即可持久；
 *   · 不进版本库、不进日志归档；
 *   · 首次启动时**打印到 stdout**（容器场景看 `docker logs` 即可拿到），
 *     同时登录页提示该文件路径，运维随时能查。
 *
 * ⚠️ 与反代的**入站密钥**（`~/.waygate/mmcode/key`，给 Claude Code / Anthropic SDK 用）
 * 是**两把不同的钥匙**：
 *   · 入站密钥 = 调模型用（客户端持有）；
 *   · 管理密钥 = 进管理页用（只有管理员持有）。
 * 两者互不替代，也互不通用。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { waygateRoot } from './accounts.js';

/** 管理密钥文件。 */
export interface AdminKeyFile {
  version: number;
  /** 密钥本体（明文；文件权限 0600，仅本机可读）。 */
  key: string;
  createdAt: number;
  updatedAt: number;
}

/** 密钥形态：`adm-mmcode-<32hex>`，与 core 的 `sk-<cmd>-<32hex>` 区分开。 */
export function generateAdminKey(): string {
  return `adm-mmcode-${randomBytes(16).toString('hex')}`;
}

/** 管理密钥文件路径。 */
export function adminKeyPath(): string {
  return join(waygateRoot(), 'mmcode', 'admin.json');
}

/** 会话持久化文件路径。 */
export function sessionsFilePath(): string {
  return join(waygateRoot(), 'mmcode', 'sessions.json');
}

/** 安全原子写 JSON 文件（0600，跨设备重命名失败自动回退）。 */
function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows 上 chmod 语义有限 */
  }
  try {
    renameSync(tmp, path);
  } catch {
    try {
      writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/** 常量时间比较（长度不等也算不匹配）。 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** 读管理密钥文件（无则 null）。 */
export function readAdminKeyFile(): AdminKeyFile | null {
  const path = adminKeyPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as AdminKeyFile;
    if (!parsed || typeof parsed.key !== 'string' || !parsed.key.trim()) return null;
    return {
      version: parsed.version ?? 1,
      key: parsed.key.trim(),
      createdAt: parsed.createdAt ?? Date.now(),
      updatedAt: parsed.updatedAt ?? parsed.createdAt ?? Date.now(),
    };
  } catch {
    return null;
  }
}

function writeAdminKeyFile(file: AdminKeyFile): void {
  writeJsonAtomic(adminKeyPath(), file);
}

export interface EnsureAdminKeyResult {
  key: string;
  /** 本次调用是否**新生成**的（首次启动 = true，用于打印醒目提示）。 */
  generated: boolean;
  path: string;
}

/**
 * 取管理密钥；不存在则**生成并落盘**。
 *
 * 这是「未设置则默认生产一个」的唯一实现点 —— 幂等：已存在则原样返回。
 */
export function ensureAdminKey(): EnsureAdminKeyResult {
  const existing = readAdminKeyFile();
  if (existing) {
    return { key: existing.key, generated: false, path: adminKeyPath() };
  }
  const now = Date.now();
  const file: AdminKeyFile = {
    version: 1,
    key: generateAdminKey(),
    createdAt: now,
    updatedAt: now,
  };
  writeAdminKeyFile(file);
  return { key: file.key, generated: true, path: adminKeyPath() };
}

/** 校验管理密钥（常量时间）。 */
export function verifyAdminKey(candidate: string | undefined | null): boolean {
  const file = readAdminKeyFile();
  if (!file) return false;
  if (!candidate || !candidate.trim()) return false;
  return safeEqual(candidate.trim(), file.key);
}

/**
 * 直接设置新的管理密钥（无需输入旧密钥验证），原子写入并持久化至 admin.json。
 *
 * 长度至少 6 个字符。返回修改后的新密钥；不合法返回 null。
 */
export function setAdminKey(newKey: string): string | null {
  const file = readAdminKeyFile();
  const trimmed = (newKey ?? '').trim();
  if (trimmed.length < 6) return null;
  const now = Date.now();
  const updated: AdminKeyFile = {
    version: file?.version ?? 1,
    key: trimmed,
    createdAt: file?.createdAt ?? now,
    updatedAt: now,
  };
  writeAdminKeyFile(updated);
  return trimmed;
}

/**
 * 修改管理密钥（向后兼容），直接重置为新密钥并持久化落盘。
 */
export function changeAdminKey(_currentKey: string, newKey: string): string | null {
  return setAdminKey(newKey);
}

/** 打码（网页展示用，只留头尾）。 */
export function maskAdminKey(key: string): string {
  if (key.length <= 16) return key.slice(0, 4) + '…';
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}

/* ─────────────────────── 会话 ─────────────────────── */

/** 会话有效期（3 天）。 */
export const SESSION_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = 3 * 24 * 60 * 60;

/** 续期写盘节流间隔（ms）—— 管理页每个请求都会 verify，不必每次都重写文件。 */
const SESSION_SAVE_THROTTLE_MS = 60_000;

/**
 * 会话存储表。
 *
 * 持久化至 ~/.waygate/mmcode/sessions.json，容器重启或更新镜像不丢失登录态。
 * 管理密钥修改时会主动清空所有已有会话。
 */
export class SessionStore {
  private readonly sessions = new Map<string, number>();
  private readonly filePath?: string;
  /** 上次落盘时刻（续期写盘节流用）。 */
  private lastSaveAt = 0;

  constructor(filePath?: string) {
    this.filePath = filePath ?? sessionsFilePath();
    this.load();
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as {
        sessions?: Record<string, number>;
      };
      if (parsed && typeof parsed.sessions === 'object') {
        const now = Date.now();
        for (const [token, exp] of Object.entries(parsed.sessions)) {
          if (typeof exp === 'number' && exp > now) {
            this.sessions.set(token, exp);
          }
        }
      }
    } catch {
      /* 容错忽略损坏的会话文件 */
    }
  }

  private save(): void {
    if (!this.filePath) return;
    const now = Date.now();
    /* ★ 过期会话必须**从内存里删掉** —— 之前只在写盘时过滤，内存 Map 一直留着，
       每登录一次涨一条（虽然每个 token 会续期，但换浏览器/清 cookie 就多一条新的），
       长期跑就是无界增长。 */
    for (const [token, exp] of this.sessions) {
      if (exp <= now) this.sessions.delete(token);
    }
    const obj: Record<string, number> = {};
    for (const [token, exp] of this.sessions.entries()) {
      if (exp > now) {
        obj[token] = exp;
      }
    }
    writeJsonAtomic(this.filePath, { version: 1, sessions: obj });
    this.lastSaveAt = now;
  }

  /** 清掉所有已过期的会话（内存 + 落盘）。 */
  pruneExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [token, exp] of this.sessions) {
      if (exp <= now) {
        this.sessions.delete(token);
        removed += 1;
      }
    }
    if (removed > 0) this.save();
    return removed;
  }

  /** 建会话，返回 token。 */
  create(ttlMs = SESSION_TTL_MS): string {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, Date.now() + ttlMs);
    this.save();
    return token;
  }

  /** 校验会话；有效则续期并返回 true。 */
  verify(token: string | undefined | null): boolean {
    if (!token) return false;
    const exp = this.sessions.get(token);
    if (exp === undefined) return false;
    if (Date.now() > exp) {
      this.sessions.delete(token);
      this.save();
      return false;
    }
    /* 滑动续期：活跃用户不会半路被踢。 */
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    /* 续期不必每次都落盘 —— 管理页每次请求都会 verify，
       每次都重写整个 sessions.json 是纯粹的 IO 抖动。60 秒一次足够。 */
    const now = Date.now();
    if (now - this.lastSaveAt >= SESSION_SAVE_THROTTLE_MS) {
      this.lastSaveAt = now;
      this.save();
    }
    return true;
  }

  /** 作废一个会话（登出）。 */
  revoke(token: string | undefined | null): void {
    if (token) {
      this.sessions.delete(token);
      this.save();
    }
  }

  /** 清空全部会话（改密钥后调用 —— 旧密钥的会话必须立刻失效）。 */
  clear(): void {
    this.sessions.clear();
    this.save();
  }
}
