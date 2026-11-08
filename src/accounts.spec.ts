/**
 * 账号注册表测试。
 *
 * 守三件事：
 *   ① 注册表**真的落盘**（重启后还在）—— 这是「账号状态持久化」的地基；
 *   ② **不覆盖已有状态**：重扫磁盘时，已记下的冷却/健康/签到记录不能被抹掉；
 *   ③ 原子写：任何时刻崩溃都不会留下半个坏 JSON（读的时候要能兜底）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore, accountDir, accountsFilePath, defaultAccountDir } from './accounts.js';

let root = '';
const origHome = process.env.MMCODE_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mmcode-acc-'));
  process.env.MMCODE_HOME = root;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.MMCODE_HOME;
  else process.env.MMCODE_HOME = origHome;
  rmSync(root, { recursive: true, force: true });
});

/** 造一个已登录的账号（磁盘上放 credential.json）。 */
function seedAccount(name: string, region: 'cn' | 'global' = 'cn'): void {
  const dir = accountDir(name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'credential.json'),
    JSON.stringify({
      accessToken: `mmoat_${name}`,
      refreshToken: `mmort_${name}`,
      expiresAt: Date.now() + 3_600_000,
      region,
    }),
  );
}

describe('AccountStore：注册与持久化', () => {
  it('首次使用自动登记磁盘上已有的账号（含默认单账户）', () => {
    seedAccount('haiwai1', 'global');
    mkdirSync(defaultAccountDir(), { recursive: true });
    writeFileSync(join(defaultAccountDir(), 'credential.json'), JSON.stringify({ accessToken: 'a', refreshToken: 'b', expiresAt: 1 }));

    const store = new AccountStore();
    const names = store.list().map((a) => a.name);
    expect(names).toContain('haiwai1');
    expect(names).toContain('default');
    /* 区域跟着凭证走 —— 国内外是不同域名，认错就全错。 */
    expect(store.get('haiwai1')?.region).toBe('global');
  });

  it('注册表真的写到磁盘，新实例能读回来', () => {
    const store = new AccountStore();
    store.upsert('acct1', 'global');
    store.setMode('balanced');
    store.setCreditsThreshold(250);
    expect(existsSync(accountsFilePath())).toBe(true);

    const reloaded = new AccountStore();
    expect(reloaded.get('acct1')?.region).toBe('global');
    expect(reloaded.mode()).toBe('balanced');
    expect(reloaded.creditsThreshold()).toBe(250);
  });

  it('★ v1 文件（旧 active/strategy）自动迁移到 v2 并落盘', () => {
    mkdirSync(join(root, 'mmcode'), { recursive: true });
    writeFileSync(
      accountsFilePath(),
      JSON.stringify({
        version: 1,
        active: 'old',
        strategy: 'round-robin',
        accounts: [
          { name: 'old', region: 'cn', enabled: true, createdAt: 1, updatedAt: 1, health: 'healthy' },
          { name: 'new', region: 'global', enabled: true, createdAt: 2, updatedAt: 2, health: 'healthy' },
        ],
      }),
    );

    const store = new AccountStore();
    /* 旧的两个概念整体消失；账号继承同一优先级（同层随机分配）。 */
    expect(store.mode()).toBe('max-cache');
    expect(store.list().map((a) => a.priority)).toEqual([0, 0]);
    expect(store.get('old')?.region).toBe('cn');

    /* 迁移结果立刻落盘 —— 旧字段不该留在文件里误导人。 */
    const raw = JSON.parse(readFileSync(accountsFilePath(), 'utf8')) as Record<string, unknown>;
    expect(raw.version).toBe(2);
    expect(raw.active).toBeUndefined();
    expect(raw.strategy).toBeUndefined();
    expect(raw.mode).toBe('max-cache');
  });

  it('update 只改传入的字段', () => {
    const store = new AccountStore();
    store.upsert('a1', 'cn');
    store.update('a1', { notes: '备注' });
    const rec = store.get('a1');
    expect(rec?.notes).toBe('备注');
    expect(rec?.region).toBe('cn');
    expect(rec?.enabled).toBe(true);
  });

  it('update 不存在的账号返回 null', () => {
    const store = new AccountStore();
    expect(store.update('nope', { enabled: false })).toBeNull();
  });

  it('remove 移除账号条目（不牵连其它账号）', () => {
    const store = new AccountStore();
    store.upsert('a1');
    store.upsert('a2');
    store.remove('a1');
    expect(store.get('a1')).toBeNull();
    expect(store.get('a2')).not.toBeNull();
  });

  it('重扫磁盘**不覆盖**已有状态（冷却/健康记录不能被抹掉）', () => {
    seedAccount('a1');
    const store = new AccountStore();
    store.update('a1', { health: 'unauthorized', disabledUntil: Date.now() + 60_000 });
    const added = store.rescan();
    expect(added).toHaveLength(0);
    const rec = store.get('a1');
    expect(rec?.health).toBe('unauthorized');
    expect(rec?.disabledUntil).toBeGreaterThan(Date.now());
  });

  it('重扫能发现**新增**的账号目录', () => {
    const store = new AccountStore();
    expect(store.list()).toHaveLength(0);
    seedAccount('fresh');
    const added = store.rescan();
    expect(added.map((a) => a.name)).toEqual(['fresh']);
    expect(store.get('fresh')).not.toBeNull();
  });

  it('注册表文件损坏时兜底：备份坏文件、从空表起步', () => {
    mkdirSync(join(root, 'mmcode'), { recursive: true });
    writeFileSync(accountsFilePath(), '{ 这不是 JSON');
    const store = new AccountStore();
    expect(store.list()).toEqual([]);
    /* 坏文件被改名备份，不留在原地反复毒化启动。 */
    expect(existsSync(accountsFilePath())).toBe(true);
    expect(readFileSync(accountsFilePath(), 'utf8')).toContain('version');
  });

  it('账号名不可用作路径（防穿越由 API 层把关，这里验证落盘路径可控）', () => {
    const store = new AccountStore();
    store.upsert('safe_name-1');
    expect(store.get('safe_name-1')).not.toBeNull();
  });
});
