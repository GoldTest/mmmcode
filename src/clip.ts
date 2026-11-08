/**
 * 请求记录裁剪 —— 给「调试留痕」用的**有界**快照。
 *
 * ## 为什么需要它
 * 反代会把每次请求的**入站体**、**转译后出站体**、**上游响应体**全量留下来（排查
 * 「我发的和上游收到的不一样」时要用）。但这些体的大小是**客户端说了算**的 ——
 * Claude Code 一轮上下文能到几百 KB～几 MB。一条不留上限，200 条记录就是几百 MB；
 * 再叠加每 2s 一次的整数组 `JSON.stringify` 落盘，容器 RSS 直接起飞。
 *
 * ## 裁剪策略（两级）
 *   ① `clipValue` —— 逐字段裁：超长字符串截断、超长数组截断、深度封顶。
 *      裁完仍超预算 → ② `tighten` —— 再狠一点（字符串 1.5KB、数组 12 项），
 *      并把体积最大的 `raw` 整体换成一句占位说明。
 *
 * ## 不变的性质
 *   · **形状不变** —— 还是合法 JSON，对象/数组结构保留，管理页的
 *     `JSON.stringify(record.input, null, 2)` 照常渲染；
 *   · **可辨识** —— 被截断的地方留 `…[已截断]` 标记，不会让人误以为原文就这么短；
 *   · **不编造** —— 只裁长度，不改内容语义。
 */

/** 单个字符串保留的最大字符数（第一级）。 */
export const MAX_STRING_CHARS = 16 * 1024;

/** 单个数组保留的最大元素数（第一级）。 */
export const MAX_ARRAY_ITEMS = 100;

/** 递归裁剪的最大深度。 */
export const MAX_DEPTH = 8;

/** 第一级裁剪后，单条记录的目标字节数（超了就升级到第二级）。 */
export const RECORD_BUDGET_BYTES = 48 * 1024;

/** 第二级裁剪的字符串上限。 */
const TIGHT_STRING_CHARS = 1536;

/** 第二级裁剪的数组上限。 */
const TIGHT_ARRAY_ITEMS = 12;

/** 截断标记。 */
const TRUNCATED = '…[已截断]';

/** 深度超限的占位。 */
const TOO_DEEP = '…[层级过深，已省略]';

/**
 * 裁一个值：超长字符串截断、超长数组截断、过深对象换成占位符。
 *
 * 数组被裁时**保留前 N 项**，并追加一个标记项 —— 这样「后面还有内容」是可见的，
 * 不会让人误判为数组本来就这么短。
 */
export function clipValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING_CHARS ? value.slice(0, MAX_STRING_CHARS) + TRUNCATED : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return TOO_DEEP;

  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY_ITEMS).map((v) => clipValue(v, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      kept.push({ __truncated: true, omitted: value.length - MAX_ARRAY_ITEMS, note: TRUNCATED });
    }
    return kept;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = clipValue(v, depth + 1);
  }
  return out;
}

/** 更狠的一档裁剪（字符串/数组都更小）。 */
function clipTight(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > TIGHT_STRING_CHARS ? value.slice(0, TIGHT_STRING_CHARS) + TRUNCATED : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return TOO_DEEP;

  if (Array.isArray(value)) {
    const kept = value.slice(0, TIGHT_ARRAY_ITEMS).map((v) => clipTight(v, depth + 1));
    if (value.length > TIGHT_ARRAY_ITEMS) {
      kept.push({ __truncated: true, omitted: value.length - TIGHT_ARRAY_ITEMS, note: TRUNCATED });
    }
    return kept;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = clipTight(v, depth + 1);
  }
  return out;
}

/**
 * 把一条记录裁进预算里。
 *
 * 先按第一级裁；量完还超预算 → 按第二级裁，并把 `input.raw` / `output.raw`
 * 这两块「原始体」换成占位（它们是体积的大头，且管理页另有专门的查看入口）。
 *
 * @returns 裁剪后的记录，以及它的 JSON 字节数（粗略按字符数算，中文偏保守）。
 */
export function clipRecord<T extends object>(record: T): { value: T; bytes: number } {
  const first = clipValue(record) as T;
  let bytes = approxBytes(first);
  if (bytes <= RECORD_BUDGET_BYTES) return { value: first, bytes };

  const tight = clipTight(first) as T;
  /* raw 是体积大头 —— 换掉它通常就够了。 */
  const tightRecord = tight as unknown as Record<string, unknown>;
  if (tightRecord.input && typeof tightRecord.input === 'object') {
    tightRecord.input = { ...(tightRecord.input as Record<string, unknown>), raw: '[原始入站体过大，已省略]' };
  }
  if (tightRecord.output && typeof tightRecord.output === 'object') {
    tightRecord.output = { ...(tightRecord.output as Record<string, unknown>), raw: '[原始出站体过大，已省略]' };
  }
  bytes = approxBytes(tight);
  if (bytes <= RECORD_BUDGET_BYTES) return { value: tight, bytes };

  /* 还是超 —— 再砍一刀数组与字符串。 */
  const tighter = clipTight(tight) as T;
  bytes = approxBytes(tighter);
  return { value: tighter, bytes };
}

/** 粗略估算一个值的 JSON 字节数（够用即可，不追求精确）。 */
export function approxBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}
