/**
 * 「破坏性操作可撤销」的回归测试。
 *
 * 背景：管理页有「清空请求缓存」和「清空统计」两个破坏性按钮。
 * 误点就没了，所以后端留了一份快照，前端提示里给「撤销」。
 * 这里锁住三件事：
 *   ① 清空后确实为空；② 撤销后数据完整回来；③ 没有快照时撤销要安全失败。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestStore, type RequestRecord } from './requests.js';
import { InsightsLedger } from './insights.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mmcode-undo-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeRecord(id: string): RequestRecord {
  return {
    id,
    timestamp: Date.now(),
    method: 'POST',
    path: '/v1/messages',
    stream: false,
    status: 200,
    durationMs: 80,
    model: 'MiniMax-M3',
    account: 'acc-a',
  };
}

describe('RequestStore：清空请求缓存可撤销', () => {
  it('清空后为空，撤销后记录完整恢复', () => {
    const store = new RequestStore(join(root, 'requests.json'));
    store.add(makeRecord('req-1'));
    store.add(makeRecord('req-2'));
    expect(store.list().total).toBe(2);

    store.clear();
    expect(store.list().total).toBe(0);
    expect(store.canUndoClear()).toBe(true);

    expect(store.undoClear()).toBe(true);
    const restored = store.list();
    expect(restored.total).toBe(2);
    expect(restored.items.map((r) => r.id).sort()).toEqual(['req-1', 'req-2']);
    /* 恢复的不只是条目 —— 关键字段（模型、账号）也得在，
       否则撤销出来的记录是「空壳」，排查问题时会被误导。 */
    expect(restored.items[0].model).toBe('MiniMax-M3');
    expect(restored.items[0].account).toBe('acc-a');
  });

  it('撤销只认最近一次清空，且用掉即失效', () => {
    const store = new RequestStore(join(root, 'requests.json'));
    store.add(makeRecord('req-1'));

    store.clear();
    expect(store.undoClear()).toBe(true);
    /* 快照已经用掉了 —— 再撤一次应该干净地失败，而不是把数据清成空。 */
    expect(store.undoClear()).toBe(false);
    expect(store.list().total).toBe(1);
  });

  it('从未清空过时撤销安全失败', () => {
    const store = new RequestStore(join(root, 'requests.json'));
    store.add(makeRecord('req-1'));
    expect(store.canUndoClear()).toBe(false);
    expect(store.undoClear()).toBe(false);
    expect(store.list().total).toBe(1);
  });

  it('连续两次清空只保留最后一份快照', () => {
    const store = new RequestStore(join(root, 'requests.json'));
    store.add(makeRecord('req-1'));
    store.clear();
    store.add(makeRecord('req-2'));
    store.clear();

    expect(store.undoClear()).toBe(true);
    /* 第二次清空前只有 req-2 —— 第一次的 req-1 不该被「复活」。 */
    expect(store.list().items.map((r) => r.id)).toEqual(['req-2']);
  });

  it('清空后的字节记账归零，撤销后重新算回来', () => {
    const store = new RequestStore(join(root, 'requests.json'));
    store.add(makeRecord('req-1'));
    const before = store.stats().estimatedMemoryBytes;
    expect(before).toBeGreaterThan(0);

    store.clear();
    expect(store.stats().estimatedMemoryBytes).toBe(0);

    store.undoClear();
    expect(store.stats().estimatedMemoryBytes).toBe(before);
  });

  it('清空后新进来的请求不会被撤销操作抹掉', () => {
    const store = new RequestStore(join(root, 'requests.json'));
    store.add(makeRecord('req-old'));
    store.clear();
    /* 清空之后又来了一个新请求 —— 撤销应该把它保住。 */
    store.add(makeRecord('req-new'));

    expect(store.undoClear()).toBe(true);
    expect(store.list().items.map((r) => r.id).sort()).toEqual(['req-new', 'req-old']);
  });

  it('撤销不改动「历史累计条数」—— 改了就等于漏计', () => {
    const store = new RequestStore(join(root, 'requests.json'));
    store.add(makeRecord('req-1'));
    store.clear();
    store.add(makeRecord('req-2'));
    const totalBefore = store.stats().totalLogged;

    store.undoClear();
    expect(store.stats().totalLogged).toBe(totalBefore);
  });
});

describe('InsightsLedger：清空统计可撤销', () => {
  it('清空后为空，撤销后各账号用量完整恢复', () => {
    const ledger = new InsightsLedger({ filePath: join(root, 'insights.json') });
    ledger.record({ account: 'acc-a', promptTokens: 100, completionTokens: 20, cachedTokens: 10, model: 'MiniMax-M3' });
    ledger.record({ account: 'acc-b', promptTokens: 50, completionTokens: 5, cachedTokens: 0, model: 'MiniMax-M3' });
    expect(ledger.totals().totalTokens).toBe(175);

    ledger.resetAll();
    expect(ledger.totals().totalTokens).toBe(0);
    expect(ledger.snapshot()).toHaveLength(0);
    expect(ledger.canUndoReset()).toBe(true);

    expect(ledger.undoResetAll()).toBe(true);
    const totals = ledger.totals();
    expect(totals.totalTokens).toBe(175);
    expect(totals.promptTokens).toBe(150);
    expect(totals.completionTokens).toBe(25);
    expect(ledger.snapshot().map((a) => a.name).sort()).toEqual(['acc-a', 'acc-b']);
  });

  it('撤销用掉即失效，重复撤销安全失败', () => {
    const ledger = new InsightsLedger({ filePath: join(root, 'insights.json') });
    ledger.record({ account: 'acc-a', promptTokens: 10, completionTokens: 2, cachedTokens: 0 });
    ledger.resetAll();
    expect(ledger.undoResetAll()).toBe(true);
    expect(ledger.undoResetAll()).toBe(false);
    expect(ledger.totals().totalTokens).toBe(12);
  });

  it('从未清空过时撤销安全失败', () => {
    const ledger = new InsightsLedger({ filePath: join(root, 'insights.json') });
    ledger.record({ account: 'acc-a', promptTokens: 10, completionTokens: 2, cachedTokens: 0 });
    expect(ledger.canUndoReset()).toBe(false);
    expect(ledger.undoResetAll()).toBe(false);
    expect(ledger.totals().totalTokens).toBe(12);
  });

  it('清空后的新记账不会被旧快照覆盖', () => {
    const ledger = new InsightsLedger({ filePath: join(root, 'insights.json') });
    ledger.record({ account: 'acc-a', promptTokens: 10, completionTokens: 2, cachedTokens: 0 });
    ledger.resetAll();
    /* 清空之后又有新请求进来了 —— 撤销应该把旧数据接回来，
       而不是把这段新数据抹掉。 */
    ledger.record({ account: 'acc-c', promptTokens: 7, completionTokens: 3, cachedTokens: 0 });

    expect(ledger.undoResetAll()).toBe(true);
    const names = ledger.snapshot().map((a) => a.name).sort();
    expect(names).toEqual(['acc-a', 'acc-c']);
  });

  it('单账号清除也可撤销，且不影响其他账号', () => {
    const ledger = new InsightsLedger({ filePath: join(root, 'insights.json') });
    ledger.record({ account: 'acc-a', promptTokens: 10, completionTokens: 2, cachedTokens: 0 });
    ledger.record({ account: 'acc-b', promptTokens: 20, completionTokens: 4, cachedTokens: 0 });

    expect(ledger.resetAccount('acc-a')).toBe(true);
    expect(ledger.snapshot().map((a) => a.name)).toEqual(['acc-b']);
    expect(ledger.canUndoReset()).toBe(true);

    expect(ledger.undoResetAll()).toBe(true);
    const names = ledger.snapshot().map((a) => a.name).sort();
    expect(names).toEqual(['acc-a', 'acc-b']);
    /* acc-b 的用量不能被 acc-a 的快照冲掉 —— 合并而不是整体覆盖。 */
    const b = ledger.snapshot().find((a) => a.name === 'acc-b');
    expect(b?.totalTokens).toBe(24);
  });

  it('清除不存在的账号不产生可撤销快照', () => {
    const ledger = new InsightsLedger({ filePath: join(root, 'insights.json') });
    ledger.record({ account: 'acc-a', promptTokens: 10, completionTokens: 2, cachedTokens: 0 });
    expect(ledger.resetAccount('not-exist')).toBe(false);
    expect(ledger.canUndoReset()).toBe(false);
  });
});
