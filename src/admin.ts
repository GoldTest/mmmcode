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
 * ⚠️ 与反代的**入站密钥**（`~/.waygate/mmcode/key`，给 Claude Code / Cursor 用）
 * 是**两把不同的钥匙**：
 *   · 入站密钥 = 调模型用（客户端持有）；
 *   · 管理密钥 = 进管理页用（只有管理员持有）。
 * 两者互不替代，也互不通用。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  const path = adminKeyPath();
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows 上 chmod 语义有限 */
  }
  renameSync(tmp, path);
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
 * 修改管理密钥：必须提供**当前正确的旧密钥**。
 *
 * 返回新密钥；旧密钥错误返回 null（不改任何文件）。
 */
export function changeAdminKey(currentKey: string, newKey: string): string | null {
  const file = readAdminKeyFile();
  if (!file) return null;
  if (!safeEqual(currentKey.trim(), file.key)) return null;
  const trimmed = newKey.trim();
  if (trimmed.length < 16) return null;
  writeAdminKeyFile({ ...file, key: trimmed, updatedAt: Date.now() });
  return trimmed;
}

/** 打码（网页展示用，只留头尾）。 */
export function maskAdminKey(key: string): string {
  if (key.length <= 16) return key.slice(0, 4) + '…';
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}

/* ─────────────────────── 会话 ─────────────────────── */

/** 会话有效期（默认 12 小时）。 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * 内存会话表。
 *
 * 为什么不用 JWT/签名 cookie：会话**只需在服务重启后失效**（重新输一次密钥即可），
 * 而「重启即失效」本身就是更安全的默认值 —— 密钥改了、进程重启了，旧会话自动作废。
 * 无状态签名反而会让旧密钥签发的会话在改密钥后继续可用。
 */
export class SessionStore {
  private readonly sessions = new Map<string, number>();

  /** 建会话，返回 token。 */
  create(ttlMs = SESSION_TTL_MS): string {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, Date.now() + ttlMs);
    return token;
  }

  /** 校验会话；有效则续期并返回 true。 */
  verify(token: string | undefined | null): boolean {
    if (!token) return false;
    const exp = this.sessions.get(token);
    if (exp === undefined) return false;
    if (Date.now() > exp) {
      this.sessions.delete(token);
      return false;
    }
    /* 滑动续期：活跃用户不会半路被踢。 */
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    return true;
  }

  /** 作废一个会话（登出）。 */
  revoke(token: string | undefined | null): void {
    if (token) this.sessions.delete(token);
  }

  /** 清空全部会话（改密钥后调用 —— 旧密钥的会话必须立刻失效）。 */
  clear(): void {
    this.sessions.clear();
  }
}
