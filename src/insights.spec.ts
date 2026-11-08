/**
 * 用量洞察台账测试 —— 「各账号用了多少 token」。
 *
 * 守四件事：
 *   ① 累计口径正确（输入 / 输出 / 缓存命中分开算，总数 = 输入 + 输出）；
 *   ② 按模型、按天分桶；
 *   ③ **落盘且能读回来**（服务重启后历史不丢）；
 *   ④ 同一个 session 只算一次（不同 session 数）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InsightsLedger, insightsFilePath } from './insights.js';

let root = '';
const origHome = process.env.MMCODE_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mmcode-insights-'));
  process.env.MMCODE_HOME = root;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.MMCODE_HOME;
  else process.env.MMCODE_HOME = origHome;
  rmSync(root, { recursive: true, force: true });
});

describe('记账', () => {
  it('★ 累计各账号的 token 用量', () => {
    const ledger = new InsightsLedger();
    ledger.record({ account: 'a1', model: 'MiniMax-M3', promptTokens: 100, completionTokens: 20, cachedTokens: 30 });
    ledger.record({ account: 'a1', model: 'MiniMax-M3', promptTokens: 50, completionTokens: 10, cachedTokens: 5 });
    ledger.record({ account: 'a2', model: 'MiniMax-M2.7', promptTokens: 10, completionTokens: 1, cachedTokens: 0 });

    const a1 = ledger.get('a1')!;
    expect(a1.requests).toBe(2);
    expect(a1.promptTokens).toBe(150);
    expect(a1.completionTokens).toBe(30);
    expect(a1.cachedTokens).toBe(35);
    expect(a1.totalTokens).toBe(180);

    const totals = ledger.totals();
    expect(totals.requests).toBe(3);
    expect(totals.totalTokens).toBe(191);
    expect(totals.accounts).toBe(2);
  });

  it('★ 缓存命中率 = 缓存命中 token / 输入 token', () => {
    const ledger = new InsightsLedger();
    ledger.record({ account: 'a1', promptTokens: 160, completionTokens: 30, cachedTokens: 40 });
    ledger.record({ account: 'a1', promptTokens: 40, completionTokens: 5, cachedTokens: 0 });
    /* 累计：命中 40 / 输入 200 = 20%。 */
    expect(ledger.get('a1')!.cacheHitRate).toBeCloseTo(0.2, 5);
    expect(ledger.totals().cacheHitRate).toBeCloseTo(0.2, 5);
  });

  it('输入为 0 时命中率不除零（返回 0）', () => {
    const ledger = new InsightsLedger();
    ledger.record({ account: 'a1', promptTokens: 0, completionTokens: 0, cachedTokens: 0 });
    expect(ledger.get('a1')!.cacheHitRate).toBe(0);
  });

  it('按模型分桶', () => {
    const ledger = new InsightsLedger();
    ledger.record({ account: 'a1', model: 'MiniMax-M3', promptTokens: 10, completionTokens: 2, cachedTokens: 0 });
    ledger.record({ account: 'a1', model: 'MiniMax-M2.7', promptTokens: 20, completionTokens: 3, cachedTokens: 0 });
    const a1 = ledger.get('a1')!;
    expect(a1.byModel['MiniMax-M3'].requests).toBe(1);
    expect(a1.byModel['MiniMax-M3'].totalTokens).toBe(12);
    expect(a1.byModel['MiniMax-M2.7'].totalTokens).toBe(23);
  });

  it('按天分桶', () => {
    const ledger = new InsightsLedger();
    const day = new Date(2026, 0, 15, 10, 0, 0).getTime();
    ledger.record({ account: 'a1', promptTokens: 10, completionTokens: 1, cachedTokens: 0, at: day });
    const a1 = ledger.get('a1')!;
    const key = Object.keys(a1.byDay)[0];
    expect(key).toBe('2026-01-15');
    expect(a1.byDay[key].requests).toBe(1);
    expect(a1.byDay[key].totalTokens).toBe(11);
  });

  it('★ 同一个 session 只算一次（不同 session 数）', () => {
    const ledger = new InsightsLedger();
    ledger.record({ account: 'a1', sessionKey: 's1', promptTokens: 1, completionTokens: 1, cachedTokens: 0 });
    ledger.record({ account: 'a1', sessionKey: 's1', promptTokens: 1, completionTokens: 1, cachedTokens: 0 });
    ledger.record({ account: 'a1', sessionKey: 's2', promptTokens: 1, completionTokens: 1, cachedTokens: 0 });
    expect(ledger.get('a1')!.sessions).toBe(2);
  });
});

describe('持久化', () => {
  it('★ 台账落盘，新实例读得回来', () => {
    const ledger = new InsightsLedger();
    ledger.record({ account: 'a1', model: 'M3', promptTokens: 100, completionTokens: 20, cachedTokens: 0 });
    ledger.flush();
    expect(existsSync(insightsFilePath())).toBe(true);

    const reloaded = new InsightsLedger();
    const a1 = reloaded.get('a1')!;
    expect(a1.requests).toBe(1);
    expect(a1.totalTokens).toBe(120);
  });

  it('清空统计', () => {
    const ledger = new InsightsLedger();
    ledger.record({ account: 'a1', promptTokens: 1, completionTokens: 1, cachedTokens: 0 });
    ledger.record({ account: 'a2', promptTokens: 1, completionTokens: 1, cachedTokens: 0 });
    expect(ledger.resetAccount('a1')).toBe(true);
    expect(ledger.get('a1')).toBeNull();
    expect(ledger.get('a2')).not.toBeNull();
    ledger.resetAll();
    expect(ledger.snapshot()).toHaveLength(0);
  });
});
