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

/**
 * 某一天的签到记录 —— 按**账号所属时区**的自然日归档。
 *
 * ## 为什么要有它
 * `lastCheckin` 只留**最近一次**，答不了「昨天签没签」。
 * 而「昨天签没签」恰恰是判断**自动签到到底有没有在跑**的唯一硬证据：
 * 没有台账，页面只能显示「上次签到成功」，看不出那是今天、昨天还是上上周。
 *
 * ## 一个账号一天只留一条
 * 同一天可能签很多次（失败重试、手动补签），这里**合并成一条**：
 *   · `outcome` / `at` / `message` = 当天**最后一次尝试**（用于「上次是否有异常」）；
 *   · `signed` / `signedAt` = 当天**签成的那一刻**（成功后再失败也不会被抹掉）；
 *   · `points` = 当天拿到的积分（第一次成功时记下）。
 */
export interface CheckinDayEntry {
  /** 当天**最后一次签到尝试**的时刻（epoch ms）。 */
  at: number;
  /** 当天最后一次尝试的结果。 */
  outcome: 'claimed' | 'already' | 'unavailable' | 'error';
  /** 当天是否签到成功（`claimed` / `already` 都算 —— 上游说「今天已签」也是签过了）。 */
  signed: boolean;
  /** 当天**签成的那一刻**（epoch ms）；没签成过为 null。 */
  signedAt: number | null;
  /** 当天拿到的积分；没拿到为 null。 */
  points: number | null;
  /** 上游回报的连续签到天数。 */
  streak: number | null;
  /** 最后一次尝试的说明（异常时是错误信息）。 */
  message: string;
}

/** 签到台账保留的自然日天数 —— 够看「昨天/今天」又不至于把注册表撑大。 */
export const CHECKIN_LEDGER_DAYS = 7;

/**
 * 清洗签到台账 —— 只保留结构合法的条目。
 *
 * 为什么必须清洗：台账是从磁盘读回来的**外部数据**（用户可能手改过 accounts.json），
 * 字段类型不对就直接用会让管理页渲染炸掉。宁可丢掉这条，也不要整个页面 500。
 */
export function sanitizeCheckinDays(raw: unknown): Record<string, CheckinDayEntry> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, CheckinDayEntry> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    /* 日期键必须是 "YYYY-MM-DD" —— 字典序即时间序，裁剪时靠它排序。 */
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const outcome = v['outcome'];
    if (
      outcome !== 'claimed' &&
      outcome !== 'already' &&
      outcome !== 'unavailable' &&
      outcome !== 'error'
    ) {
      continue;
    }
    const at = Number(v['at']);
    if (!Number.isFinite(at)) continue;
    const num = (x: unknown): number | null => {
      if (x == null) return null;
      const n = Number(x);
      return Number.isFinite(n) ? n : null;
    };
    out[key] = {
      at,
      outcome,
      signed: v['signed'] === true,
      signedAt: num(v['signedAt']),
      points: num(v['points']),
      streak: num(v['streak']),
      message: typeof v['message'] === 'string' ? v['message'] : '',
    };
  }
  return out;
}

/**
 * 往台账里写一次签到尝试 —— 同一天合并，只保留最近 `keep` 天。
 *
 * 合并规则（见 `CheckinDayEntry` 注释）：成功是**粘性**的 ——
 * 当天签成之后再来一次失败重试，不能把「今天签了」抹成「今天没签」。
 */
export function recordCheckinDay(
  days: Record<string, CheckinDayEntry> | undefined,
  dateKey: string,
  attempt: {
    at: number;
    outcome: CheckinDayEntry['outcome'];
    points: number | null;
    streak: number | null;
    message: string;
  },
  keep: number = CHECKIN_LEDGER_DAYS,
): Record<string, CheckinDayEntry> {
  const next = { ...sanitizeCheckinDays(days) };
  const prev = next[dateKey];
  const ok = attempt.outcome === 'claimed' || attempt.outcome === 'already';
  next[dateKey] = {
    at: attempt.at,
    outcome: attempt.outcome,
    signed: ok || prev?.signed === true,
    signedAt: ok ? attempt.at : (prev?.signedAt ?? null),
    points: attempt.points ?? prev?.points ?? null,
    streak: attempt.streak ?? prev?.streak ?? null,
    message: attempt.message,
  };
  /* 只保留最近的 N 天 —— 日期键字典序即时间序，从最老的开始丢。 */
  const keys = Object.keys(next).sort();
  const limit = Math.max(1, Math.floor(keep));
  while (keys.length > limit) {
    const dropped = keys.shift();
    if (dropped) delete next[dropped];
  }
  return next;
}

/** 一次签到奖励快照（获取到奖励的时刻与积分值）。 */
export interface RewardSnapshot {
  at: number;
  points: number;
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
   * 了才下沉到下一层。**同层之内没有先后顺序** —— 可用账号之间按剩余积分加权随机。
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
  /**
   * 每日签到台账 —— key 是该账号所属时区下的自然日（"YYYY-MM-DD"）。
   *
   * 回答「昨天签没签 / 什么时候签的 / 拿到多少积分 / 上次有没有异常」；
   * 只保留最近 `CHECKIN_LEDGER_DAYS` 天。
   */
  checkinDays?: Record<string, CheckinDayEntry>;
  /** 上次获取到的签到奖励（积分 + 获得时间）。 */
  lastReward?: RewardSnapshot;
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
 *   · `burn`（蹬额度 / 消耗临期）：新会话**优先分配给有临近到期积分（且剩余积分 > 0）的账号**；
 *     若多个账号临期，按最早到期时刻优先；无临期账号时回退到最高可用层加权分配。
 */
export type PoolMode = 'max-cache' | 'balanced' | 'burn';

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
      const validMode =
        parsed.mode === 'balanced' || parsed.mode === 'burn' ? parsed.mode : 'max-cache';
      const migrated: AccountsFile = {
        version: FILE_VERSION,
        mode: validMode,
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
   * 原有账号一律继承同一优先级（0），即「同层加权随机分配」——
   * 这比按旧粘性顺序排优先级更贴近新模型的本意。
   */
  private normalizeRecord(raw: AccountRecord): AccountRecord {
    const lastReward =
      raw.lastReward && typeof raw.lastReward.at === 'number' && typeof raw.lastReward.points === 'number'
        ? raw.lastReward
        : raw.lastCheckin?.points != null
          ? { at: raw.lastCheckin.at, points: raw.lastCheckin.points }
          : undefined;
    return {
      ...raw,
      checkinEnabled: raw.checkinEnabled !== false,
      priority: typeof raw.priority === 'number' && Number.isFinite(raw.priority) ? raw.priority : 0,
      frozen: raw.frozen === true,
      frozenReason: typeof raw.frozenReason === 'string' ? raw.frozenReason : undefined,
      rateLimited: raw.rateLimited === true,
      rateLimitReason: typeof raw.rateLimitReason === 'string' ? raw.rateLimitReason : undefined,
      /* 台账是外部数据 —— 读进来先清洗，别让坏字段流到页面上。 */
      checkinDays: (() => {
        const days = sanitizeCheckinDays(raw.checkinDays);
        return Object.keys(days).length > 0 ? days : undefined;
      })(),
      ...(lastReward ? { lastReward } : {}),
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
