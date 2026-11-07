/**
 * 管理密钥与会话测试。
 *
 * 守三件事：
 *   ① **未设置则自动生成**，且**幂等**（重启不换密钥 —— 换了用户手里的密钥就废了）；
 *   ② **改密钥要验旧密钥**，且改完旧密钥立刻失效；
 *   ③ 会话能续期、能作废、改密钥后全清。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adminKeyPath,
  changeAdminKey,
  ensureAdminKey,
  generateAdminKey,
  maskAdminKey,
  readAdminKeyFile,
  SessionStore,
  verifyAdminKey,
} from './admin.js';

let root = '';
const origHome = process.env.MMCODE_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mmcode-admin-'));
  process.env.MMCODE_HOME = root;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.MMCODE_HOME;
  else process.env.MMCODE_HOME = origHome;
  rmSync(root, { recursive: true, force: true });
});

describe('管理密钥：自动生成', () => {
  it('未设置时生成一个并落盘', () => {
    const r = ensureAdminKey();
    expect(r.generated).toBe(true);
    expect(r.key).toMatch(/^adm-mmcode-[0-9a-f]{32}$/);
    expect(existsSync(adminKeyPath())).toBe(true);
  });

  it('★ 幂等：再调一次拿到**同一个**密钥（重启不换密钥）', () => {
    const first = ensureAdminKey();
    const second = ensureAdminKey();
    expect(second.generated).toBe(false);
    expect(second.key).toBe(first.key);
  });

  it('落盘权限是 0600（只本机可读）', () => {
    ensureAdminKey();
    const mode = statSync(adminKeyPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('密钥形态前缀正确且互不相同', () => {
    const a = generateAdminKey();
    const b = generateAdminKey();
    expect(a).not.toBe(b);
    expect(a.startsWith('adm-mmcode-')).toBe(true);
  });
});

describe('管理密钥：校验', () => {
  it('正确密钥通过，错误/空密钥不通过', () => {
    const { key } = ensureAdminKey();
    expect(verifyAdminKey(key)).toBe(true);
    expect(verifyAdminKey(key + 'x')).toBe(false);
    expect(verifyAdminKey('')).toBe(false);
    expect(verifyAdminKey(undefined)).toBe(false);
    expect(verifyAdminKey(null)).toBe(false);
  });

  it('未生成任何密钥时一律不通过', () => {
    expect(verifyAdminKey('anything')).toBe(false);
  });

  it('文件损坏时读作不存在（不回退成「无密钥即放行」）', () => {
    ensureAdminKey();
    writeFileSync(adminKeyPath(), '{ 坏文件');
    expect(readAdminKeyFile()).toBeNull();
    expect(verifyAdminKey('anything')).toBe(false);
  });
});

describe('管理密钥：修改', () => {
  it('旧密钥不对 → 拒绝且不改文件', () => {
    const { key } = ensureAdminKey();
    expect(changeAdminKey('wrong-key', '0123456789abcdefXYZ')).toBeNull();
    expect(readAdminKeyFile()?.key).toBe(key);
  });

  it('★ 旧密钥对 → 换成新密钥，旧密钥随即失效', () => {
    const { key } = ensureAdminKey();
    const next = changeAdminKey(key, '0123456789abcdefXYZ');
    expect(next).toBe('0123456789abcdefXYZ');
    expect(verifyAdminKey(key)).toBe(false);
    expect(verifyAdminKey('0123456789abcdefXYZ')).toBe(true);
  });

  it('新密钥太短（<16）拒绝', () => {
    const { key } = ensureAdminKey();
    expect(changeAdminKey(key, 'short')).toBeNull();
    expect(verifyAdminKey(key)).toBe(true);
  });
});

describe('打码', () => {
  it('长密钥只露头尾', () => {
    const masked = maskAdminKey('adm-mmcode-0123456789abcdef0123456789abcdef');
    expect(masked).toContain('…');
    expect(masked).not.toContain('0123456789abcdef0123456789abcdef');
  });
});

describe('会话', () => {
  it('创建后能校验通过', () => {
    const s = new SessionStore();
    const t = s.create();
    expect(s.verify(t)).toBe(true);
  });

  it('未知 token 不通过', () => {
    const s = new SessionStore();
    expect(s.verify('nope')).toBe(false);
    expect(s.verify(undefined)).toBe(false);
    expect(s.verify('')).toBe(false);
  });

  it('revoke 后立刻失效', () => {
    const s = new SessionStore();
    const t = s.create();
    s.revoke(t);
    expect(s.verify(t)).toBe(false);
  });

  it('★ clear 会作废全部会话（改密钥后必须立刻失效）', () => {
    const s = new SessionStore();
    const a = s.create();
    const b = s.create();
    s.clear();
    expect(s.verify(a)).toBe(false);
    expect(s.verify(b)).toBe(false);
  });

  it('过期会话不通过', () => {
    const s = new SessionStore();
    const t = s.create(-1); /* 已经过期的 TTL */
    expect(s.verify(t)).toBe(false);
  });
});

describe('落盘内容', () => {
  it('文件里就是那把密钥（运维能直接 cat 出来）', () => {
    const { key } = ensureAdminKey();
    const parsed = JSON.parse(readFileSync(adminKeyPath(), 'utf8')) as { key: string };
    expect(parsed.key).toBe(key);
    expect(chmodSync === undefined).toBe(false); /* 仅确认导入可用 */
  });
});
