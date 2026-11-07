/**
 * 入站密钥注册表 —— 给**客户端**用的那些 token。
 *
 * ## 为什么要有「多把」
 * 客户端 token 是**长期凭据**：填在 Claude Code / Cursor / 脚本里。
 * 一把钥匙用久了会带来几个实际麻烦：
 *   · **泄露后无法精确吊销** —— 只能整体换掉，把所有客户端一起打断；
 *   · **无法区分用途** —— 不知道哪把是哪台机器/哪个脚本在用；
 *   · **不知道谁在用** —— 没有使用记录，轮换全靠猜。
 * 所以这里管**一把把独立的密钥**，各自可命名、可单独吊销、可单独停用。
 *
 * ## 与 core 的兼容
 * core 的 `resolveKey()` 只认**单数**一把密钥（`~/.waygate/mmcode/key`）。
 * 为了不破坏既有行为与现有客户端配置：
 *   · 注册表存**全部**密钥（`~/.waygate/mmcode/keys.json`）；
 *   · 其中**主密钥**额外写一份到 `~/.waygate/mmcode/key` —— core 读到的就是它，
 *     现有客户端配置**不用改**；
 *   · 吊销主密钥时**重新生成一把**新的并写回 `key` 文件（吊销 = 换掉，不是留空）。
 *
 * ## 落盘
 * 原子写（临时文件 + rename），0600。密钥本体明文存本地 —— 与 core 的 `key`
 * 文件同级别，不引入新的暴露面。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { waygateRoot } from './accounts.js';

export interface InboundKey {
  /** 稳定 id（吊销/改名都用它，不用密钥本体）。 */
  id: string;
  /** 用途名（如「Claude Code」「脚本 A」）。 */
  name: string;
  /** 密钥本体（`sk-mmcode-<32hex>`）。 */
  key: string;
  createdAt: number;
  /** 最后一次被用来成功鉴权的时刻。 */
  lastUsedAt?: number;
  /** 是否参与鉴权。停用 = 暂时冻结，可随时恢复。 */
  enabled: boolean;
  /** 是否为主密钥（写在 core 的 `key` 文件里）。 */
  primary: boolean;
  /** 可选：过期时刻（epoch ms）；null = 不过期。 */
  expiresAt?: number | null;
  /** 可选：备注。 */
  purpose?: string;
}

interface KeysFile {
  version: number;
  keys: InboundKey[];
}

/** 注册表文件路径。 */
export function keysFilePath(): string {
  return join(waygateRoot(), 'mmcode', 'keys.json');
}

/**
 * 主密钥文件路径（core 的 `resolveKey()` 读它）。
 *
 * 与 core 的 `commandDir('mmcode')/key` 保持一致 —— 正常情况下两者同路径。
 */
export function primaryKeyFilePath(): string {
  return join(waygateRoot(), 'mmcode', 'key');
}

/** 密钥形态：与 core 的 `generateKey` 一致（`sk-<cmd>-<32hex>`）。 */
export function generateInboundKey(): string {
  return `sk-mmcode-${randomBytes(16).toString('hex')}`;
}

/** 打码（列表里默认显示这个，复制时用完整值）。 */
export function maskInboundKey(key: string): string {
  if (key.length <= 20) return key.slice(0, 6) + '…';
  return `${key.slice(0, 14)}…${key.slice(-4)}`;
}

function writePrivateAtomic(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows 上 chmod 语义有限 */
  }
  renameSync(tmp, path);
}

/**
 * 入站密钥注册表。
 *
 * 内存快照 + 原子落盘；`save()` 是唯一写入口。
 */
export class KeyRegistry {
  private data: KeysFile;
  private readonly file: string;
  private readonly primaryFile: string;

  constructor(opts: { filePath?: string; primaryPath?: string } = {}) {
    this.file = opts.filePath ?? keysFilePath();
    this.primaryFile = opts.primaryPath ?? primaryKeyFilePath();
    this.data = this.load();
  }

  private load(): KeysFile {
    const empty: KeysFile = { version: 1, keys: [] };

    if (!existsSync(this.file)) {
      return this.seedFromLegacy(empty);
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as KeysFile;
      const keys = Array.isArray(parsed.keys)
        ? parsed.keys.filter((k) => k && typeof k.key === 'string' && typeof k.id === 'string')
        : [];
      this.data = { version: parsed.version ?? 1, keys };
      /* 兼容：万一注册表里没有主密钥，补一个（沿用 core 的 key 文件）。 */
      if (!keys.some((k) => k.primary)) {
        const legacy = this.readLegacyPrimary();
        if (legacy) {
          this.data.keys.unshift({
            id: 'primary',
            name: '默认密钥',
            key: legacy,
            createdAt: Date.now(),
            enabled: true,
            primary: true,
          });
          this.persist();
        }
      }
      return this.data;
    } catch {
      /* 坏文件不吞掉整站：备份后**退回从 core 的 key 文件导入** ——
         那把钥匙多半还有效，丢掉就等于把既有客户端全踢下线。 */
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* 备份失败也继续 */
      }
      return this.seedFromLegacy(empty);
    }
  }

  /** 从 core 的单密钥文件导入一把主密钥（没有就返回空表）。 */
  private seedFromLegacy(empty: KeysFile): KeysFile {
    const legacy = this.readLegacyPrimary();
    if (!legacy) {
      this.data = empty;
      return empty;
    }
    const seeded: KeysFile = {
      version: 1,
      keys: [
        {
          id: 'primary',
          name: '默认密钥',
          key: legacy,
          createdAt: Date.now(),
          enabled: true,
          primary: true,
        },
      ],
    };
    this.data = seeded;
    this.persist();
    return seeded;
  }

  /** 读 core 的单密钥文件（老布局）。 */
  private readLegacyPrimary(): string | null {
    try {
      const v = readFileSync(this.primaryFile, 'utf8').trim();
      return v || null;
    } catch {
      return null;
    }
  }

  /** 落盘：注册表 + 主密钥文件（保持 core 兼容）。 */
  private persist(): void {
    writePrivateAtomic(this.file, JSON.stringify(this.data, null, 2) + '\n');
    const primary = this.data.keys.find((k) => k.primary);
    if (primary) {
      writePrivateAtomic(this.primaryFile, primary.key + '\n');
    }
  }

  /** 全部密钥。 */
  list(): InboundKey[] {
    return this.data.keys.map((k) => ({ ...k }));
  }

  /** 按 id 取。 */
  get(id: string): InboundKey | null {
    const found = this.data.keys.find((k) => k.id === id);
    return found ? { ...found } : null;
  }

  /** 主密钥（没有则 null）。 */
  primary(): InboundKey | null {
    const found = this.data.keys.find((k) => k.primary);
    return found ? { ...found } : null;
  }

  /** 主密钥的明文（给启动输出与客户端配置用）。 */
  primaryKey(): string | null {
    return this.primary()?.key ?? null;
  }

  /**
   * 新建一把密钥。
   *
   * 第一把自动成为主密钥（并写进 core 的 `key` 文件）。
   */
  create(name: string, opts: { purpose?: string; expiresAt?: number | null } = {}): InboundKey {
    const trimmed = name.trim() || `密钥 ${this.data.keys.length + 1}`;
    const key: InboundKey = {
      id: randomBytes(6).toString('hex'),
      name: trimmed,
      key: generateInboundKey(),
      createdAt: Date.now(),
      enabled: true,
      primary: this.data.keys.length === 0,
      expiresAt: opts.expiresAt ?? null,
      purpose: opts.purpose,
    };
    this.data.keys.push(key);
    this.persist();
    return { ...key };
  }

  /** 改元信息（名字/备注/启用状态/过期时间）。**不动密钥本体**。 */
  update(id: string, patch: Partial<Omit<InboundKey, 'id' | 'key' | 'createdAt'>>): InboundKey | null {
    const target = this.data.keys.find((k) => k.id === id);
    if (!target) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) target.name = patch.name.trim().slice(0, 60);
    if (typeof patch.enabled === 'boolean') target.enabled = patch.enabled;
    if (typeof patch.purpose === 'string') target.purpose = patch.purpose.slice(0, 200);
    if ('expiresAt' in patch) target.expiresAt = patch.expiresAt ?? null;
    this.persist();
    return { ...target };
  }

  /**
   * 吊销一把密钥。
   *
   * 吊销**主密钥**时：生成一把新的顶上并写回 core 的 `key` 文件 ——
   * 「吊销」是「换掉」，不是「留个空」。否则 core 侧会读到陈旧值。
   */
  revoke(id: string): boolean {
    const idx = this.data.keys.findIndex((k) => k.id === id);
    if (idx < 0) return false;
    const wasPrimary = this.data.keys[idx]?.primary === true;
    this.data.keys.splice(idx, 1);

    if (wasPrimary) {
      /* 优先让另一把接管主密钥；没有就生成一把新的。 */
      const next = this.data.keys[0];
      if (next) {
        next.primary = true;
      } else {
        this.data.keys.push({
          id: randomBytes(6).toString('hex'),
          name: '默认密钥',
          key: generateInboundKey(),
          createdAt: Date.now(),
          enabled: true,
          primary: true,
        });
      }
    }
    this.persist();
    return true;
  }

  /** 轮换一把密钥的**本体**（名字/元信息保留）。 */
  rotate(id: string): InboundKey | null {
    const target = this.data.keys.find((k) => k.id === id);
    if (!target) return null;
    target.key = generateInboundKey();
    this.persist();
    return { ...target };
  }

  /**
   * 这把密钥能不能通过鉴权。
   *
   * 存在 + 启用 + 未过期。恒定时间比较（不泄露前缀信息）。
   */
  accepts(candidate: string | undefined | null): boolean {
    if (!candidate || !candidate.trim()) return false;
    const value = candidate.trim();
    const now = Date.now();
    return this.data.keys.some(
      (k) =>
        k.enabled &&
        (k.expiresAt === null || k.expiresAt === undefined || k.expiresAt > now) &&
        k.key.length === value.length &&
        timingSafeEqualStr(k.key, value),
    );
  }

  /** 记录一次成功使用（用于「谁在用」）。 */
  markUsed(candidate: string | undefined | null): void {
    if (!candidate) return;
    const value = candidate.trim();
    const hit = this.data.keys.find((k) => k.key === value);
    if (!hit) return;
    hit.lastUsedAt = Date.now();
    this.persist();
  }
}

/** 恒定时间字符串比较（长度不等直接 false）。 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = Buffer.from(a, 'utf8');
  const hb = Buffer.from(b, 'utf8');
  if (ha.length !== hb.length) return false;
  let diff = 0;
  for (let i = 0; i < ha.length; i += 1) diff |= (ha[i] ?? 0) ^ (hb[i] ?? 0);
  return diff === 0;
}
