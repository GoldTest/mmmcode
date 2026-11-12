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

/** 一次生文测活（ping）的快照。 */
export interface ProbeSnapshot {
  at: number;
  ttftMs: number;
  status: 'ok' | 'suspected' | 'paused' | 'error';
  message: string;
}

/** 一次不耗 token 预热的快照。 */
export interface WarmupSnapshot {
  at: number;
  durationMs: number;
  ok: boolean;
  message: string;
}

/** 注册表里的一个账号条目。 */
export interface AccountRecord {
  /** 账号名（目录名，全局唯一）。 */
  name: string;
  /** 所属区域 —— cn / global，**每个账号独立**（不同账号可能分属两区）。 */
  region: MinimaxRegion;
  /** 是否参与自动切换（关掉 = 保留账号但不参与反代轮换）。 */
  enabled: boolean;
  /**
   * 是否参与每日自动签到（默认 true；关掉 = 该账号不参与后台自动签到与全员签到）。
   *
   * 独立于 `enabled`：关掉只停签到，不影响反代流量调度；用户可为某些账号单独停用自动签到。
   */
  checkinEnabled?: boolean;
  /**
   * 优先级层 —— **数字越小越优先**（0 = 最高层）。
   *
   * 新 session 只在「最高层里还有可用账号」时分配到那一层；该层全被冻结 / 冷却
   * 了才下沉到下一层。**同层之内没有先后顺序** —— 可用账号之间随机分配。
   */
  priority: number;
  /**
   * 额度冻结 —— 余额低于阈值时置位，该账号**不参与调度**。
   *
   * 与 `disabledUntil`（冷却）是两回事：冷却是「暂时别碰我」，冻结是
   * 「我真没额度了」。冻结由余额刷新（达标即解冻）或 429 触发。
   */
  frozen?: boolean;
  /** 冻结原因（人话，展示用）。 */
  frozenReason?: string;
  /** 冻结自愈时刻 —— 有值则到点自动回池；为空 = 无限期冻结（等余额刷新解冻）。 */
  frozenUntil?: number;
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
  /** 限流标记 —— 测活超过 20s（疑似限流）或被限流时置位，该账号不参与调度。 */
  rateLimited?: boolean;
  /** 限流原因（人话，展示用）。 */
  rateLimitReason?: string;
  /** 上次生文测活（首字耗时）快照。 */
  lastProbe?: ProbeSnapshot;
  /** 上次无 token 预热快照。 */
  lastWarmup?: WarmupSnapshot;
  /** 备注（网页上可编辑）。 */
  notes?: string;
}

/**
 * 调度模式（全局一个开关，所有优先级层统一生效）。
 *
 *   · `max-cache`（最大缓存）：session 一旦绑定某账号就**永不迁移** ——
 *     最大化上游提示词缓存命中（同账号才有缓存）。
 *   · `balanced`（平衡）：绑定期间行为同 max-cache；但当该账号额度耗尽 /
 *     不可用时，session **无缝滑到**别的可用账号上。
 */
export type PoolMode = 'max-cache' | 'balanced';

export interface AccountsFile {
  version: number;
  /** 全局调度模式。 */
  mode: PoolMode;
  /** 最小可用积分 —— 余额低于它就把账号**冻结**（不参与调度）。 */
  creditsThreshold: number;
  accounts: AccountRecord[];
}

const FILE_VERSION = 2;

/** 默认最小可用积分（余额低于它即冻结）。 */
export const DEFAULT_CREDITS_THRESHOLD = 100;

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
    const empty: AccountsFile = {
      version: FILE_VERSION,
      mode: 'max-cache',
      creditsThreshold: DEFAULT_CREDITS_THRESHOLD,
      accounts: [],
    };
    if (!existsSync(this.filePath)) {
      /* 首次：把磁盘上已有的账号目录**自动登记**进来 —— 用户此前用 mmmcode.sh
         建的账号不该因为换了注册表就「消失」。 */
      const discovered = this.discoverOnDisk();
      const seeded: AccountsFile = { ...empty, accounts: discovered };
      if (discovered.length > 0) {
        this.writeFile(seeded);
      }
      return seeded;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<AccountsFile> & {
        active?: unknown;
        strategy?: unknown;
      };
      const accounts = Array.isArray(parsed.accounts)
        ? parsed.accounts
            .filter((a) => a && typeof a.name === 'string')
            .map((a) => this.normalizeRecord(a))
        : [];
      const migrated: AccountsFile = {
        version: FILE_VERSION,
        mode: parsed.mode === 'balanced' ? 'balanced' : 'max-cache',
        creditsThreshold:
          typeof parsed.creditsThreshold === 'number' && Number.isFinite(parsed.creditsThreshold) && parsed.creditsThreshold >= 0
            ? parsed.creditsThreshold
            : DEFAULT_CREDITS_THRESHOLD,
        accounts,
      };
      /* v1 → v2 的迁移**立刻落盘** —— 否则下次启动又要重新迁一遍，
         而旧文件里的 active/strategy 会一直躺在那儿误导人。 */
      if (parsed.version !== FILE_VERSION) this.writeFile(migrated);
      return migrated;
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

  /**
   * 把一条落盘记录规整到 v2 形状。
   *
   * v1 → v2 的迁移要点：v1 有 `active`（粘性当前账号）与 `strategy`
   * （sticky / round-robin）—— 这两个概念在新模型里**整体消失**
   * （「没有当前账号概念，只有优先级概念」）。迁移时把它们**丢弃**，
   * 原有账号一律继承同一优先级（0），即「同层随机分配」——
   * 这比按旧粘性顺序排优先级更贴近新模型的本意。
   */
  private normalizeRecord(raw: AccountRecord): AccountRecord {
    return {
      ...raw,
      checkinEnabled: raw.checkinEnabled !== false,
      priority: typeof raw.priority === 'number' && Number.isFinite(raw.priority) ? raw.priority : 0,
      frozen: raw.frozen === true,
      frozenReason: typeof raw.frozenReason === 'string' ? raw.frozenReason : undefined,
      rateLimited: raw.rateLimited === true,
      rateLimitReason: typeof raw.rateLimitReason === 'string' ? raw.rateLimitReason : undefined,
    };
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
      checkinEnabled: true,
      priority: 0,
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

  /**
   * 按给定顺序重排账号列表。
   *
   * 用于管理页的「调整顺序」—— 网页上看到的排列顺序即注册表里的顺序。
   * 未出现在 `order` 里的账号保持相对次序，排在已列出的账号之后。
   *
   * 注意：**顺序只影响展示**，调度优先级仍由 `priority` 字段决定。
   */
  reorder(order: string[]): AccountRecord[] {
    const rank = new Map<string, number>();
    order.forEach((name, i) => {
      if (!rank.has(name)) rank.set(name, i);
    });
    /* 未列出的账号排到后面，之间保持原有相对次序。 */
    const tail = this.data.accounts.filter((a) => !rank.has(a.name));
    const head = order
      .map((name) => this.data.accounts.find((a) => a.name === name))
      .filter((a): a is AccountRecord => Boolean(a));
    this.data.accounts = [...head, ...tail];
    this.save();
    return this.list();
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
    this.save();
    return true;
  }

  /** 全局调度模式。 */
  mode(): PoolMode {
    return this.data.mode;
  }

  /** 设置全局调度模式。 */
  setMode(mode: PoolMode): void {
    this.data.mode = mode;
    this.save();
  }

  /** 最小可用积分阈值（低于它冻结账号）。 */
  creditsThreshold(): number {
    return this.data.creditsThreshold;
  }

  /** 设置最小可用积分阈值。 */
  setCreditsThreshold(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.data.creditsThreshold = value;
    this.save();
  }
}
