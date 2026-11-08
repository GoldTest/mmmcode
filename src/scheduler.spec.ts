import { describe, expect, it, vi } from 'vitest';
import { isSameDayInShanghai, SchedulerService } from './scheduler.js';
import { AccountStore } from './accounts.js';
import { AccountPool } from './pool.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('SchedulerService', () => {
  it('isSameDayInShanghai 正确判断同日与异日', () => {
    // 2026-11-08 12:00:00 UTC+8
    const t1 = new Date('2026-11-08T04:00:00Z').getTime();
    const t2 = new Date('2026-11-08T15:00:00Z').getTime(); // 23:00 UTC+8
    const t3 = new Date('2026-11-08T16:01:00Z').getTime(); // 2026-11-09 00:01 UTC+8

    expect(isSameDayInShanghai(t1, t2)).toBe(true);
    expect(isSameDayInShanghai(t1, t3)).toBe(false);
  });

  it('初始状态和配置加载/更新', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmcode-test-'));
    const store = new AccountStore({ filePath: join(dir, 'accounts.json') });
    const pool = new AccountPool(store);
    const scheduler = new SchedulerService(pool, { configPath: join(dir, 'scheduler.json') });

    const initial = scheduler.getConfig();
    expect(initial.autoCheckin.enabled).toBe(true);
    expect(initial.autoRefresh.enabled).toBe(true);

    const updated = scheduler.updateConfig({
      autoCheckin: { enabled: false, time: '09:30', intervalMinutes: 60 },
    });
    expect(updated.autoCheckin.enabled).toBe(false);
    expect(updated.autoCheckin.time).toBe('09:30');

    const status = scheduler.getStatus();
    expect(status.autoCheckin.enabled).toBe(false);
    scheduler.stop();
  });
});
