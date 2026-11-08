import { describe, expect, it } from 'vitest';
import { RequestStore, type RequestRecord } from './requests.js';

describe('RequestStore', () => {
  const createSample = (id: string, ageMs = 0, status = 200): RequestRecord => ({
    id,
    timestamp: Date.now() - ageMs,
    method: 'POST',
    path: '/v1/chat/completions',
    clientIp: '127.0.0.1',
    keyId: 'k1',
    keyName: 'default',
    keyMasked: 'sk-...1234',
    model: 'MiniMax-M3',
    stream: false,
    status,
    durationMs: 150,
    account: 'acc-1',
    input: {
      messages: [{ role: 'user', content: `Hello from ${id}` }],
      model: 'MiniMax-M3',
    },
    output: {
      text: `Reply to ${id}`,
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    },
  });

  it('添加与获取记录，最新记录排在最前', () => {
    const store = new RequestStore();
    store.add(createSample('req-1', 100));
    store.add(createSample('req-2', 0));

    expect(store.get('req-1')?.id).toBe('req-1');
    expect(store.get('req-2')?.id).toBe('req-2');

    const list = store.list();
    expect(list.total).toBe(2);
    expect(list.items[0].id).toBe('req-2');
    expect(list.items[1].id).toBe('req-1');
  });

  it('数量超出上限时自动淘汰最旧记录 (FIFO)', () => {
    const store = new RequestStore();
    store.updateConfig({ maxItems: 3 });

    store.add(createSample('req-1', 300));
    store.add(createSample('req-2', 200));
    store.add(createSample('req-3', 100));
    store.add(createSample('req-4', 0));

    const list = store.list();
    expect(list.total).toBe(3);
    expect(list.items.map((i) => i.id)).toEqual(['req-4', 'req-3', 'req-2']);
    expect(store.get('req-1')).toBeUndefined();
  });

  it('保留时间超出时自动淘汰过期记录', () => {
    const store = new RequestStore();
    store.updateConfig({ retentionMs: 1000 }); // 1秒

    store.add(createSample('req-old', 2000));
    store.add(createSample('req-fresh', 100));

    const list = store.list();
    expect(list.total).toBe(1);
    expect(list.items[0].id).toBe('req-fresh');
  });

  it('过滤与搜索功能', () => {
    const store = new RequestStore();
    store.add(createSample('req-ok', 0, 200));
    store.add(createSample('req-err', 0, 500));

    const okList = store.list({ status: 'success' });
    expect(okList.total).toBe(1);
    expect(okList.items[0].id).toBe('req-ok');

    const errList = store.list({ status: 'error' });
    expect(errList.total).toBe(1);
    expect(errList.items[0].id).toBe('req-err');

    const searchList = store.list({ search: 'req-err' });
    expect(searchList.total).toBe(1);
    expect(searchList.items[0].id).toBe('req-err');
  });

  it('统计指标计算', () => {
    const store = new RequestStore();
    store.add(createSample('req-1', 0, 200));
    store.add(createSample('req-2', 0, 500));

    const stats = store.stats();
    expect(stats.totalLogged).toBe(2);
    expect(stats.cachedCount).toBe(2);
    expect(stats.successCount).toBe(1);
    expect(stats.errorCount).toBe(1);
    expect(stats.totalTokens.total).toBe(60);
  });
});
