import { describe, expect, it } from 'vitest';
import {
  dailyJitterOffsetMs,
  isSameZonedDay,
  isValidTimezone,
  nextDateKey,
  normalizeHhMm,
  parseHhMm,
  resolveDailyDueAt,
  resolveWindowRange,
  zonedDateKey,
  zonedTimeToEpoch,
} from './checkin-window.js';

describe('parseHhMm / normalizeHhMm', () => {
  it('接受 HH:mm 与 H:mm，非法格式返回 null', () => {
    expect(parseHhMm('08:30')).toEqual({ hour: 8, minute: 30 });
    expect(parseHhMm('8:30')).toEqual({ hour: 8, minute: 30 });
    expect(parseHhMm('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseHhMm('24:00')).toBeNull();
    expect(parseHhMm('08:60')).toBeNull();
    expect(parseHhMm('8点30')).toBeNull();
    expect(parseHhMm('')).toBeNull();
  });

  it('normalizeHhMm 规整成两位形式', () => {
    expect(normalizeHhMm('8:30')).toBe('08:30');
    expect(normalizeHhMm('08:30')).toBe('08:30');
    expect(normalizeHhMm('bad')).toBeNull();
  });
});

describe('isValidTimezone', () => {
  it('认得 IANA 时区名，拒 nonsense', () => {
    expect(isValidTimezone('Asia/Shanghai')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone(123)).toBe(false);
  });
});

describe('时区换算', () => {
  it('日期键按各自时区算 —— 同一时刻在北京与 UTC 可能是不同日子', () => {
    /* 2026-11-12 23:30 北京 = 2026-11-12 15:30 UTC —— 同一天。 */
    const t = new Date('2026-11-12T15:30:00Z').getTime();
    expect(zonedDateKey(t, 'Asia/Shanghai')).toBe('2026-11-12');
    expect(zonedDateKey(t, 'UTC')).toBe('2026-11-12');

    /* 2026-11-12 23:30 北京 = 2026-11-12 15:30 UTC。 */
    const t2 = new Date('2026-11-12T16:30:00Z').getTime();
    expect(zonedDateKey(t2, 'Asia/Shanghai')).toBe('2026-11-13');
    expect(zonedDateKey(t2, 'UTC')).toBe('2026-11-12');
  });

  it('墙上时间换算回 epoch —— 北京 08:00 = UTC 00:00', () => {
    expect(zonedTimeToEpoch('2026-11-12', 8, 0, 'Asia/Shanghai')).toBe(
      new Date('2026-11-12T00:00:00Z').getTime(),
    );
    expect(zonedTimeToEpoch('2026-11-12', 8, 0, 'UTC')).toBe(
      new Date('2026-11-12T08:00:00Z').getTime(),
    );
  });

  it('isSameZonedDay 按时区判「同一天」', () => {
    /* 北京时间 11-12 23:30 与 11-13 00:30 —— 北京跨天了，UTC 还没跨。 */
    const a = new Date('2026-11-12T15:30:00Z').getTime();
    const b = new Date('2026-11-12T16:30:00Z').getTime();
    expect(isSameZonedDay(a, b, 'Asia/Shanghai')).toBe(false);
    expect(isSameZonedDay(a, b, 'UTC')).toBe(true);
  });

  it('nextDateKey 跨月跨年都对', () => {
    expect(nextDateKey('2026-11-30')).toBe('2026-12-01');
    expect(nextDateKey('2026-12-31')).toBe('2027-01-01');
  });
});

describe('dailyJitterOffsetMs', () => {
  const jitterMs = 30 * 60 * 1000;

  it('固定窗口为 0 时不偏移', () => {
    expect(dailyJitterOffsetMs('seed', '2026-11-12', 'a1', 0)).toBe(0);
  });

  it('同一天同一账号 → 同一个偏移（重启不漂移）', () => {
    const a = dailyJitterOffsetMs('seed', '2026-11-12', 'a1', jitterMs);
    const b = dailyJitterOffsetMs('seed', '2026-11-12', 'a1', jitterMs);
    expect(a).toBe(b);
  });

  it('换一天 → 偏移不同；换账号 → 偏移不同；换种子 → 偏移不同', () => {
    const base = dailyJitterOffsetMs('seed', '2026-11-12', 'a1', jitterMs);
    expect(dailyJitterOffsetMs('seed', '2026-11-13', 'a1', jitterMs)).not.toBe(base);
    expect(dailyJitterOffsetMs('seed', '2026-11-12', 'a2', jitterMs)).not.toBe(base);
    expect(dailyJitterOffsetMs('other-seed', '2026-11-12', 'a1', jitterMs)).not.toBe(base);
  });

  it('偏移始终落在 [-窗口, +窗口] 内', () => {
    for (let i = 0; i < 500; i += 1) {
      const offset = dailyJitterOffsetMs('seed', '2026-11-12', `acc-${i}`, jitterMs);
      expect(Math.abs(offset)).toBeLessThanOrEqual(jitterMs);
    }
  });

  it('向前 / 向后大致各一半（对称分布）', () => {
    let forward = 0;
    let backward = 0;
    for (let i = 0; i < 500; i += 1) {
      const offset = dailyJitterOffsetMs('seed', '2026-11-12', `acc-${i}`, jitterMs);
      if (offset > 0) forward += 1;
      else if (offset < 0) backward += 1;
    }
    expect(forward).toBeGreaterThan(150);
    expect(backward).toBeGreaterThan(150);
  });
});

describe('resolveDailyDueAt / resolveWindowRange', () => {
  it('固定时间 → 正好是那一刻', () => {
    const due = resolveDailyDueAt({
      dateKey: '2026-11-12',
      hour: 8,
      minute: 30,
      offsetMs: 0,
      timeZone: 'Asia/Shanghai',
    });
    expect(due).toBe(new Date('2026-11-12T00:30:00Z').getTime());
  });

  it('随机偏移 → 落在 [窗口起, 窗口止] 内', () => {
    const jitterMs = 30 * 60 * 1000;
    const window = resolveWindowRange({
      dateKey: '2026-11-12',
      hour: 8,
      minute: 30,
      jitterMs,
      timeZone: 'Asia/Shanghai',
    });
    const target = new Date('2026-11-12T00:30:00Z').getTime();
    expect(window.start).toBe(target - jitterMs);
    expect(window.end).toBe(target + jitterMs);

    for (let i = 0; i < 50; i += 1) {
      const offsetMs = dailyJitterOffsetMs('seed', '2026-11-12', `acc-${i}`, jitterMs);
      const due = resolveDailyDueAt({
        dateKey: '2026-11-12',
        hour: 8,
        minute: 30,
        offsetMs,
        timeZone: 'Asia/Shanghai',
      });
      expect(due).toBeGreaterThanOrEqual(window.start);
      expect(due).toBeLessThanOrEqual(window.end);
    }
  });

  it('窗口裁剪在当天之内 —— 靠近午夜的时间也不会跨天', () => {
    const window = resolveWindowRange({
      dateKey: '2026-11-12',
      hour: 0,
      minute: 10,
      jitterMs: 60 * 60 * 1000,
      timeZone: 'Asia/Shanghai',
    });
    const dayStart = zonedTimeToEpoch('2026-11-12', 0, 0, 'Asia/Shanghai');
    expect(window.start).toBe(dayStart);
    expect(window.end).toBeLessThan(zonedTimeToEpoch('2026-11-13', 0, 0, 'Asia/Shanghai'));
  });
});
