/**
 * 每日自动签到的「时间窗口 + 随机时刻」计算 —— 纯函数，无副作用，好测。
 *
 * ## 要解决什么
 * 固定时间签到有个老问题：所有账号、每一天，都在同一个秒数打同一个上游。
 *   · 账号多时，签到请求挤成一坨 —— 容易撞上限流；
 *   · 每天都一样的时刻，等于给上游画了一张「机器行为」的指纹。
 *
 * 所以这里把「签到时间」从一个点变成一个**窗口**：
 *   · `jitterMinutes = 0` → 固定时间（`time` 那一刻，一秒不差）；
 *   · `jitterMinutes = N` → 在 **[time-N, time+N]** 里给每个账号各挑一个随机时刻，
 *     前后各占一半概率（`offset` 在 `[-N, +N]` 上均匀分布）。
 *
 * 例：设 `08:30`、窗口 30 分钟 ⇒ 实际签到时刻落在 **08:00 ~ 09:00** 之间，
 * 每个账号各不相同，当天固定（重启不漂移），每天不同（跨天重新抽）。
 *
 * ## 为什么随机值是「算出来的」而不是「存下来的」
 * 落盘一个「今天随机到几点」当然也行，但会多一份状态要同步（重启、写盘、多实例）。
 * 这里改成**确定性哈希**：`hash(种子 + 日期 + 账号名)` → 偏移。
 *   · 同一天同一个账号 ⇒ 永远同一个偏移（重启不漂移）；
 *   · 换一天 ⇒ 偏移变（跨天不规律）；
 *   · 换账号 ⇒ 偏移变（同一天里各账号错峰）；
 *   · 换安装 ⇒ 种子不同 ⇒ 偏移不同（不同用户、不同机器不会撞在同一秒）。
 *
 * ## 时区
 * **国内账号与海外账号是两套独立的计划**，各自带自己的时区 ——
 * 「08:30」对国内号是北京时间，对海外号则按海外那组的时区解释。
 * 偏移量用 `Intl` 现算（不写死 +8），时区名写错会当场报错而不是悄悄算错。
 */

import { createHash } from 'node:crypto';

/** 国内账号默认时区。 */
export const CN_TIMEZONE = 'Asia/Shanghai';
/** 海外账号默认时区。 */
export const GLOBAL_TIMEZONE = 'UTC';

/** 解析 "HH:mm" → { hour, minute }；格式或取值不合法返回 null。 */
export function parseHhMm(value: string): { hour: number; minute: number } | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** 把 "HH:mm" 规整成两位形式（"8:30" → "08:30"）；不合法返回 null。 */
export function normalizeHhMm(value: string): string | null {
  const parsed = parseHhMm(value);
  if (!parsed) return null;
  return `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`;
}

/**
 * 校验时区名是否可用（IANA 名，如 "Asia/Shanghai" / "UTC"）。
 *
 * 为什么要认真校验：时区写错会让「该签的那一刻」算到别的日子去，
 * 表现是签到时间乱跳 —— 必须当场报错。
 */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 某时刻在指定时区的日历字段。 */
function zonedParts(
  ts: number,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(ts));
  const get = (type: string): number => {
    const raw = parts.find((p) => p.type === type)?.value;
    return raw === undefined ? NaN : Number(raw);
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    /* 某些 ICU 版本会把午夜渲染成 "24" —— 取模回 0。 */
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * 某时刻在指定时区的 UTC 偏移（毫秒）。
 *
 * 用「把当地墙上时间当成 UTC 解析，再和真实时间戳相减」求偏移 ——
 * 这样连 DST 都能算对，不必假设固定 +8。
 */
export function zoneOffsetMs(ts: number, timeZone: string): number {
  const p = zonedParts(ts, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  /* 抹掉毫秒 —— 偏移量总是整分钟/整小时。 */
  const truncated = ts - (ts % 1000);
  return asUtc - truncated;
}

/** 某时刻在指定时区的日期键（"YYYY-MM-DD"）。 */
export function zonedDateKey(ts: number, timeZone: string): string {
  const p = zonedParts(ts, timeZone);
  const mm = String(p.month).padStart(2, '0');
  const dd = String(p.day).padStart(2, '0');
  return `${p.year}-${mm}-${dd}`;
}

/**
 * 两个时刻在指定时区是否为同一天。
 *
 * 「今天签没签过」必须按**该账号所属区域的时区**判断 ——
 * 国内号与海外号的一天不是同一天（差 8 小时）。
 */
export function isSameZonedDay(ts1: number, ts2: number, timeZone: string): boolean {
  return zonedDateKey(ts1, timeZone) === zonedDateKey(ts2, timeZone);
}

/**
 * 解析日期键 "YYYY-MM-DD" → 年月日。
 *
 * 日期键只由 `zonedDateKey` 生成，格式必然正确 —— 这里直接抛错，
 * 好过默默算出一个错到离谱的签到时刻。
 */
function parseDateKey(dateKey: string): { y: number; m: number; d: number } {
  const parts = dateKey.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`日期键不合法：${dateKey}（应为 YYYY-MM-DD）`);
  }
  return { y, m, d };
}

/** 日期键的下一个自然日（用于算「明天」）。 */
export function nextDateKey(dateKey: string): string {
  const { y, m, d } = parseDateKey(dateKey);
  const next = new Date(Date.UTC(y, m - 1, d) + 24 * 3600 * 1000);
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(next.getUTCDate()).padStart(2, '0');
  return `${next.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * 指定时区某天某刻对应的 epoch 毫秒。
 *
 * 先拿「墙上时间当成 UTC」的粗估，再用该时刻的时区偏移校正回去。
 * 对固定偏移的时区（UTC / UTC+8）一次校正就是精确值；
 * 即便有 DST，误差也只在切换那一小时。
 */
export function zonedTimeToEpoch(
  dateKey: string,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const { y, m, d } = parseDateKey(dateKey);
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  return guess - zoneOffsetMs(guess, timeZone);
}

/** 某天在指定时区的起止时刻。 */
export function zonedDayRange(dateKey: string, timeZone: string): { start: number; end: number } {
  return {
    start: zonedTimeToEpoch(dateKey, 0, 0, timeZone),
    end: zonedTimeToEpoch(nextDateKey(dateKey), 0, 0, timeZone),
  };
}

/**
 * 由「种子 + 日期 + 账号名」派生当日的随机偏移（毫秒）。
 *
 * 范围 **[-jitterMs, +jitterMs)** —— 关于 0 对称 ⇒ 向前 / 向后各一半概率。
 * `jitterMs <= 0`（固定时间）时返回 0。
 */
export function dailyJitterOffsetMs(
  seed: string,
  dateKey: string,
  account: string,
  jitterMs: number,
): number {
  if (!Number.isFinite(jitterMs) || jitterMs <= 0) return 0;
  const digest = createHash('sha256')
    .update(`${seed}\u0000${dateKey}\u0000${account}`)
    .digest();
  /* 取 64 位拼成一个 [0,1) 的小数 —— 32 位在 30 分钟窗口里已经够细，
     拼成 64 位只是为了避免「同一天所有账号撞到同一个毫秒」这种巧合。 */
  const frac = (digest.readUInt32BE(0) * 2 ** 32 + digest.readUInt32BE(4)) / 2 ** 64;
  return Math.round((frac * 2 - 1) * jitterMs);
}

/**
 * 算出某账号在指定日期的**应签时刻**。
 *
 * 窗口以 `time` 为中心，向前向后各 `jitterMs`，再**裁剪到当天之内** ——
 * 裁剪是为了让「今天签到」这件事始终发生在今天（哪怕 time 很靠近午夜），
 * 否则「已签到」的判断会跨天打架。
 */
export function resolveDailyDueAt(opts: {
  dateKey: string;
  hour: number;
  minute: number;
  offsetMs: number;
  timeZone: string;
}): number {
  const target = zonedTimeToEpoch(opts.dateKey, opts.hour, opts.minute, opts.timeZone);
  const { start, end } = zonedDayRange(opts.dateKey, opts.timeZone);
  const due = target + opts.offsetMs;
  return Math.min(Math.max(due, start), end - 1);
}

/**
 * 签到窗口的起止（毫秒）—— 给管理页展示「今天会在几点到几点之间签」。
 *
 * 窗口同样裁剪到当天之内。
 */
export function resolveWindowRange(opts: {
  dateKey: string;
  hour: number;
  minute: number;
  jitterMs: number;
  timeZone: string;
}): { start: number; end: number } {
  const target = zonedTimeToEpoch(opts.dateKey, opts.hour, opts.minute, opts.timeZone);
  const { start: dayStart, end: dayEnd } = zonedDayRange(opts.dateKey, opts.timeZone);
  const jitterMs = Number.isFinite(opts.jitterMs) && opts.jitterMs > 0 ? opts.jitterMs : 0;
  return {
    start: Math.min(Math.max(target - jitterMs, dayStart), dayEnd - 1),
    end: Math.min(Math.max(target + jitterMs, dayStart), dayEnd - 1),
  };
}
