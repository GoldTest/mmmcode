/**
 * 多账号注册表 —— 账号的**持久化状态中枢**。
 *
 * ## 为什么要单独的注册表（而不是只靠 credential.json）
 * `credential.json` 只存**令牌**，不存「这个账号现在什么状态」：
 * 哪个账号在用、哪个被顶掉了、今天签到没、上次余额多少、该冷却多久。
 * 这些是**运营状态**，且必须**跨进程持久**（服务重启、Docker 重启后还在）。
 * 于是分成两层：
 *
 *   · 令牌层：`<账号目录>/mmcode/credential.json`（0600，core 约定不动）
 *   · 状态层：`~/.waygate/mmcode/accounts.json`（本文件负责，原子写）
 *
 * ## 目录布局
 *   ~/.waygate/mmcode/credential.json          默认单账户（兼容老用法）
 *   ~/.waygate/accounts/<name>/mmcode/…        多账户（与 mmmcode.sh 约定一致）
 *   ~/.waygate/mmcode/accounts.json            注册表（本模块）
 *
 * ⚠️ 账号根目录**锚定在 HOME**（不跟 WAYGATE_HOME 走）：
 * `mmmcode.sh` 把 `WAYGATE_HOME` 指向单个账号目录来做 per-account 覆盖，
 * 若状态层也跟着漂，每个账号就会各持一份互不可见的注册表 —— 多账号切换直接失效。
 * 令牌层仍走 WAYGATE_HOME（`credentialPath()`），保持老行为不变。
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MinimaxRegion } from './credential.js';
import { readSavedCredential, resolveRegion } from './credential.js';

/** 账号健康状态。`unauthorized` = 凭证被别处登录顶掉（需重新授权）。 */
export type AccountHealth = 'unknown' | 'healthy' | 'unauthorized' | 'rate_limited' | 'error';

/** 一次签到的结果（持久化，便于网页上回看「今天签了没」）。 */
export interface CheckinSnapshot {
  at: number;
  outcome: 'claimed' | 'already' | 'unavailable' | 'error';
  points: number | null;
  streak: number | null;
  message: string;
}

/** 一次积分查询的快照。 */
export interface CreditsSnapshot {
  at: number;
  granted: number;
  remaining: number;
  consumed: number;
  nextExpireAt: number | null;
}

/** 注册表里的一个账号条目。 */
export interface AccountRecord {
  /** 账号名（目录名，全局唯一）。 */
  name: string;
  /** 所属区域 —— cn / global，**每个账号独立**（不同账号可能分属两区）。 */
  region: MinimaxRegion;
  /** 是否参与自动切换（关掉 = 保留账号但不参与反代轮换）。 */
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  health: AccountHealth;
  healthDetail?: string;
  /** 冷却截止时刻（epoch ms）—— 401/429 后暂时跳过该账号。 */
  disabledUntil?: number;
  /** 上次被反代真正用到的时间。 */
  lastUsedAt?: number;
  /** 上次签到结果。 */
  lastCheckin?: CheckinSnapshot;
  /** 上次积分查询结果。 */
  lastCredits?: CreditsSnapshot;
  /** 备注（网页上可编辑）。 */
  notes?: string;
}

/** 账号切换策略。 */
export type PoolStrategy = 'sticky' | 'round-robin';

export interface AccountsFile {
  version: number;
  /** 粘性策略下的当前账号。 */
  active: string | null;
  strategy: PoolStrategy;
  accounts: AccountRecord[];
}

const FILE_VERSION = 1;

/* ─────────────────────── 路径 ─────────────────────── */

/**
 * Waygate 根目录。
 *
 * 锚定 HOME（与 `mmmcode.sh` 的 `~/.waygate/accounts` 约定一致），
 * 可用 `MMCODE_HOME` 覆盖（测试 / 便携部署）。
 */
export function waygateRoot(): string {
  const override = (process.env.MMCODE_HOME ?? '').trim();
  return override || join(homedir(), '.waygate');
}

/** 保留名：默认单账户（沿用老布局 `~/.waygate/mmcode/`）。 */
export const DEFAULT_ACCOUNT_NAME = 'default';

/** 多账户根目录（每个账号一个子目录）。 */
export function accountsRoot(): string {
  return join(waygateRoot(), 'accounts');
}

/** 某账号的**令牌目录**（其下是 credential.json / login-state.json）。 */
export function accountDir(name: string): string {
  return join(accountsRoot(), name, 'mmcode');
}

/** 默认单账户的令牌目录（老布局：`~/.waygate/mmcode/`）。 */
export function defaultAccountDir(): string {
  return join(waygateRoot(), 'mmcode');
}

/**
 * 按账号名解析令牌目录。
 *
 * `default` 走老布局（`~/.waygate/mmcode/`），其余走 `accounts/<name>/mmcode`
 * —— 与 `mmmcode.sh` 的既有布局逐字节一致，老凭证不用迁移。
 */
export function resolveAccountDir(name: string): string {
  return name === DEFAULT_ACCOUNT_NAME ? defaultAccountDir() : accountDir(name);
}

/** 注册表文件路径。 */
export function accountsFilePath(): string {
  return join(waygateRoot(), 'mmcode', 'accounts.json');
}

/* ─────────────────────── 原子写 ─────────────────────── */

function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows 上 chmod 语义有限 */
  }
  renameSync(tmp, path);
}

/* ─────────────────────── 注册表 ─────────────────────── */

export interface AccountStoreOptions {
  /** 覆盖注册表文件路径（测试用）。 */
  filePath?: string;
}

/**
 * 账号注册表。
 *
 * 读-改-写全程走内存快照 + 原子落盘；`save()` 是唯一的写入口。
 */
export class AccountStore {
  private data: AccountsFile;
  private readonly filePath: string;

  constructor(opts: AccountStoreOptions = {}) {
    this.filePath = opts.filePath ?? accountsFilePath();
    this.data = this.load();
  }

  private load(): AccountsFile {
    const empty: AccountsFile = { version: FILE_VERSION, active: null, strategy: 'sticky', accounts: [] };
    if (!existsSync(this.filePath)) {
      /* 首次：把磁盘上已有的账号目录**自动登记**进来 —— 用户此前用 mmmcode.sh
         建的账号不该因为换了注册表就「消失」。 */
      const discovered = this.discoverOnDisk();
      const seeded: AccountsFile = { ...empty, accounts: discovered };
      if (discovered.length > 0) {
        seeded.active = discovered[0]?.name ?? null;
        this.writeFile(seeded);
      }
      return seeded;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as AccountsFile;
      return {
        version: parsed.version ?? FILE_VERSION,
        active: typeof parsed.active === 'string' ? parsed.active : null,
        strategy: parsed.strategy === 'round-robin' ? 'round-robin' : 'sticky',
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts.filter((a) => a && typeof a.name === 'string') : [],
      };
    } catch {
      /* 坏文件不吞掉整站：备份后从空表起步，并**立刻写一份干净的** ——
         否则下次启动又会撞上「文件不存在 → 走首次发现分支」的另一条路径，
         行为不唯一。 */
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* 备份失败也继续 */
      }
      this.writeFile(empty);
      return empty;
    }
  }

  /** 扫描磁盘上已存在的账号目录，自动登记 —— 用户此前用 mmmcode.sh 建的账号
   *  不该因为换了注册表就「消失」。包含老布局的默认单账户（`default`）。 */
  private discoverOnDisk(): AccountRecord[] {
    const out: AccountRecord[] = [];

    /* ① 默认单账户（老布局 ~/.waygate/mmcode/credential.json）。 */
    if (existsSync(join(defaultAccountDir(), 'credential.json'))) {
      const cred = readSavedCredential(defaultAccountDir());
      out.push(this.newRecord(DEFAULT_ACCOUNT_NAME, cred?.region ?? resolveRegion()));
    }

    /* ② 多账户目录。 */
    const root = accountsRoot();
    if (!existsSync(root)) return out;
    let entries: string[] = [];
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return out;
    }
    for (const name of entries) {
      if (name === DEFAULT_ACCOUNT_NAME) continue;
      const dir = accountDir(name);
      if (!existsSync(join(dir, 'credential.json'))) continue;
      const cred = readSavedCredential(dir);
      out.push(this.newRecord(name, cred?.region ?? resolveRegion()));
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  private newRecord(name: string, region: MinimaxRegion): AccountRecord {
    const now = Date.now();
    return {
      name,
      region,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      health: 'unknown',
    };
  }

  private writeFile(data: AccountsFile): void {
    writeJsonAtomic(this.filePath, data);
  }

  /** 落盘当前状态。 */
  save(): void {
    this.writeFile(this.data);
  }

  /** 全部账号（按创建顺序）。 */
  list(): AccountRecord[] {
    return this.data.accounts.map((a) => ({ ...a }));
  }

  /**
   * 重新扫描磁盘，把**新出现**的账号目录登记进来。
   *
   * 已有条目的状态**不动**（不覆盖冷却/健康/签到记录）——
   * 否则每次扫描都会把刚记下的「刚被顶掉」抹掉。
   *
   * 为什么需要：账号可能是**登录之后**才有的（`mmcode login` 写到默认目录），
   * 而注册表在进程启动时就已加载 —— 不重扫就发现不了它。
   */
  rescan(): AccountRecord[] {
    const discovered = this.discoverOnDisk();
    const added: AccountRecord[] = [];
    for (const rec of discovered) {
      if (!this.data.accounts.some((a) => a.name === rec.name)) {
        this.data.accounts.push(rec);
        added.push(rec);
      }
    }
    if (added.length > 0) this.save();
    return added;
  }

  /** 按名取账号（不存在返回 null）。 */
  get(name: string): AccountRecord | null {
    const found = this.data.accounts.find((a) => a.name === name);
    return found ? { ...found } : null;
  }

  /** 注册（或更新）一个账号。已存在则只更新区域等可变项，**不覆盖状态**。 */
  upsert(name: string, region?: MinimaxRegion): AccountRecord {
    const existing = this.data.accounts.find((a) => a.name === name);
    if (existing) {
      if (region && region !== existing.region) {
        existing.region = region;
        existing.updatedAt = Date.now();
        this.save();
      }
      return { ...existing };
    }
    const record = this.newRecord(name, region ?? resolveRegion());
    this.data.accounts.push(record);
    this.save();
    return { ...record };
  }

  /** 局部更新一个账号；返回更新后的副本（账号不存在返回 null）。 */
  update(name: string, patch: Partial<Omit<AccountRecord, 'name' | 'createdAt'>>): AccountRecord | null {
    const target = this.data.accounts.find((a) => a.name === name);
    if (!target) return null;
    Object.assign(target, patch, { updatedAt: Date.now() });
    this.save();
    return { ...target };
  }

  /** 移除账号条目（**不删令牌文件** —— 删令牌由调用方显式做，避免误删）。 */
  remove(name: string): boolean {
    const idx = this.data.accounts.findIndex((a) => a.name === name);
    if (idx < 0) return false;
    this.data.accounts.splice(idx, 1);
    if (this.data.active === name) {
      this.data.active = this.data.accounts[0]?.name ?? null;
    }
    this.save();
    return true;
  }

  /** 当前粘性账号名。 */
  activeName(): string | null {
    return this.data.active;
  }

  /** 设置粘性账号。 */
  setActive(name: string | null): void {
    this.data.active = name;
    this.save();
  }

  /** 切换策略。 */
  strategy(): PoolStrategy {
    return this.data.strategy;
  }

  /** 设置切换策略。 */
  setStrategy(strategy: PoolStrategy): void {
    this.data.strategy = strategy;
    this.save();
  }
}
