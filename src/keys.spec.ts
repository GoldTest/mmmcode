/**
 * 入站密钥注册表测试。
 *
 * 守四件事：
 *   ① **兼容**：老布局的 `~/.waygate/mmcode/key` 会被导入 —— 既有客户端配置不能失效；
 *   ② **吊销主密钥 = 换掉**，不是留空（core 侧 `resolveKey` 读的就是这个文件）；
 *   ③ **鉴权**：停用/过期/不存在的密钥一律不通过；
 *   ④ **落盘**：注册表与主密钥文件同步写，重启后状态一致。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'mmcode-keys-'));
process.env.MMCODE_HOME = tmpHome;

const { KeyRegistry, keysFilePath, maskInboundKey, primaryKeyFilePath } = await import('./keys.js');

function newRegistry(): InstanceType<typeof KeyRegistry> {
  return new KeyRegistry();
}

beforeEach(() => {
  rmSync(join(tmpHome, 'mmcode'), { recursive: true, force: true });
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('导入与兼容', () => {
  it('★ 老布局的 key 文件被导入成主密钥（既有客户端配置不失效）', () => {
    mkdirSync(join(tmpHome, 'mmcode'), { recursive: true });
    writeFileSync(primaryKeyFilePath(), 'sk-mmcode-legacyvalue0000000000000000000\n');

    const reg = newRegistry();
    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.key).toBe('sk-mmcode-legacyvalue0000000000000000000');
    expect(list[0]?.primary).toBe(true);
    expect(list[0]?.enabled).toBe(true);
    /* 导入后注册表也落盘了。 */
    expect(existsSync(keysFilePath())).toBe(true);
  });

  it('什么都没有时是空表（不凭空造密钥）', () => {
    expect(newRegistry().list()).toEqual([]);
  });

  it('注册表损坏时不吞掉整站：退回从 key 文件导入', () => {
    mkdirSync(join(tmpHome, 'mmcode'), { recursive: true });
    writeFileSync(primaryKeyFilePath(), 'sk-mmcode-survivor000000000000000000\n');
    writeFileSync(keysFilePath(), '{ 坏文件');

    const reg = newRegistry();
    expect(reg.list().map((k) => k.key)).toEqual(['sk-mmcode-survivor000000000000000000']);
  });
});

describe('生成', () => {
  it('第一把自动成为主密钥，并写进 core 的 key 文件', () => {
    const reg = newRegistry();
    const created = reg.create('Claude Code');
    expect(created.primary).toBe(true);
    expect(created.key).toMatch(/^sk-mmcode-[0-9a-f]{32}$/);
    expect(readFileSync(primaryKeyFilePath(), 'utf8').trim()).toBe(created.key);
  });

  it('后续的密钥不是主密钥，主密钥文件不变', () => {
    const reg = newRegistry();
    const first = reg.create('A');
    const second = reg.create('B');
    expect(second.primary).toBe(false);
    expect(readFileSync(primaryKeyFilePath(), 'utf8').trim()).toBe(first.key);
  });

  it('密钥形态正确且互不相同', () => {
    const reg = newRegistry();
    const a = reg.create('A');
    const b = reg.create('B');
    expect(a.key).not.toBe(b.key);
    expect(b.key).toMatch(/^sk-mmcode-[0-9a-f]{32}$/);
  });
});

describe('鉴权', () => {
  it('启用中的密钥通过', () => {
    const reg = newRegistry();
    const k = reg.create('A');
    expect(reg.accepts(k.key)).toBe(true);
  });

  it('★ 停用的密钥不通过', () => {
    const reg = newRegistry();
    const k = reg.create('A');
    reg.update(k.id, { enabled: false });
    expect(reg.accepts(k.key)).toBe(false);
    /* 重新启用后恢复。 */
    reg.update(k.id, { enabled: true });
    expect(reg.accepts(k.key)).toBe(true);
  });

  it('过期的密钥不通过', () => {
    const reg = newRegistry();
    const k = reg.create('A', { expiresAt: Date.now() - 1000 });
    expect(reg.accepts(k.key)).toBe(false);
  });

  it('没过期的不通过？—— 反之：未到期的通过', () => {
    const reg = newRegistry();
    const k = reg.create('A', { expiresAt: Date.now() + 60_000 });
    expect(reg.accepts(k.key)).toBe(true);
  });

  it('空值 / 乱填 / 不存在的一律不通过', () => {
    const reg = newRegistry();
    reg.create('A');
    expect(reg.accepts('')).toBe(false);
    expect(reg.accepts(undefined)).toBe(false);
    expect(reg.accepts(null)).toBe(false);
    expect(reg.accepts('sk-mmcode-nonexistent00000000000000000000')).toBe(false);
  });

  it('★ 吊销后立即不通过', () => {
    const reg = newRegistry();
    const k = reg.create('A');
    expect(reg.accepts(k.key)).toBe(true);
    reg.revoke(k.id);
    expect(reg.accepts(k.key)).toBe(false);
  });
});

describe('吊销与轮换', () => {
  it('★ 吊销主密钥 → 换一把新的顶上，key 文件同步更新', () => {
    const reg = newRegistry();
    const primary = reg.create('A');
    expect(readFileSync(primaryKeyFilePath(), 'utf8').trim()).toBe(primary.key);

    reg.revoke(primary.id);
    const newPrimary = reg.primary();
    expect(newPrimary).not.toBeNull();
    expect(newPrimary!.key).not.toBe(primary.key);
    /* 旧的不再有效，新的有效。 */
    expect(reg.accepts(primary.key)).toBe(false);
    expect(reg.accepts(newPrimary!.key)).toBe(true);
    expect(readFileSync(primaryKeyFilePath(), 'utf8').trim()).toBe(newPrimary!.key);
  });

  it('吊销副密钥时主密钥不变', () => {
    const reg = newRegistry();
    const primary = reg.create('A');
    const second = reg.create('B');
    reg.revoke(second.id);
    expect(reg.primary()?.key).toBe(primary.key);
    expect(readFileSync(primaryKeyFilePath(), 'utf8').trim()).toBe(primary.key);
  });

  it('吊销不存在的 id 返回 false', () => {
    expect(newRegistry().revoke('nope')).toBe(false);
  });

  it('★ 轮换：名字保留、本体换新、旧值立即失效', () => {
    const reg = newRegistry();
    const k = reg.create('Claude Code');
    const rotated = reg.rotate(k.id);
    expect(rotated?.name).toBe('Claude Code');
    expect(rotated?.key).not.toBe(k.key);
    expect(reg.accepts(k.key)).toBe(false);
    expect(reg.accepts(rotated!.key)).toBe(true);
  });

  it('轮换主密钥 → key 文件同步更新', () => {
    const reg = newRegistry();
    const k = reg.create('A');
    const rotated = reg.rotate(k.id);
    expect(readFileSync(primaryKeyFilePath(), 'utf8').trim()).toBe(rotated!.key);
  });
});

describe('临时密钥（--key 显式指定）', () => {
  it('★ 登记后能通过鉴权（否则 --key 指定的钥匙会被全部请求拒掉）', () => {
    const reg = newRegistry();
    const custom = 'sk-mmcode-custom00000000000000000000000';
    expect(reg.accepts(custom)).toBe(false);
    reg.addTransient(custom);
    expect(reg.accepts(custom)).toBe(true);
  });

  it('临时密钥**不落盘**（沿用 core「用户显式指定即由用户自管」）', () => {
    const reg = newRegistry();
    reg.create('已持久化的钥匙'); /* 先有一把持久密钥，让注册表文件必然存在 */
    reg.addTransient('sk-mmcode-custom00000000000000000000000');
    const reloaded = newRegistry();
    expect(reloaded.accepts('sk-mmcode-custom00000000000000000000000')).toBe(false);
    /* 注册表文件里也不该出现它。 */
    expect(readFileSync(keysFilePath(), 'utf8')).not.toContain('custom0000');
  });

  it('空白/未登记的密钥不通过', () => {
    const reg = newRegistry();
    reg.addTransient('   ');
    expect(reg.accepts('')).toBe(false);
    expect(reg.accepts('sk-mmcode-nope0000000000000000000000000')).toBe(false);
  });
});

describe('持久化', () => {  it('★ 新实例读回同样的密钥（重启不丢）', () => {
    const reg = newRegistry();
    const k = reg.create('A');
    const reloaded = newRegistry();
    expect(reloaded.list().map((x) => x.key)).toEqual([k.key]);
    expect(reloaded.primary()?.id).toBe(k.id);
    expect(reloaded.accepts(k.key)).toBe(true);
  });

  it('改名/备注也持久化', () => {
    const reg = newRegistry();
    const k = reg.create('A');
    reg.update(k.id, { name: '改过的名字', purpose: '家里台式机' });
    const reloaded = newRegistry();
    expect(reloaded.get(k.id)?.name).toBe('改过的名字');
    expect(reloaded.get(k.id)?.purpose).toBe('家里台式机');
  });

  it('使用记录被记下', () => {
    const reg = newRegistry();
    const k = reg.create('A');
    reg.markUsed(k.key);
    expect(reg.get(k.id)?.lastUsedAt).toBeGreaterThan(0);
  });
});

describe('打码', () => {
  it('不泄露完整密钥', () => {
    const masked = maskInboundKey('sk-mmcode-0123456789abcdef0123456789abcdef');
    expect(masked).toContain('…');
    expect(masked).not.toContain('0123456789abcdef0123456789abcdef');
  });
});
