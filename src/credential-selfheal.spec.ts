/**
 * 令牌刷新的**自愈**测试（假 fetch，不触真实上游）。
 *
 * ## 场景（Docker 与宿主机共用状态目录时必然发生）
 * refresh token 是**一次性**的。若**别的进程**（宿主机上的 CLI、另一个容器实例）
 * 先刷新了令牌并把新的 refresh token 写回同一个 `credential.json`，
 * 本进程内存里那份就作废了 —— 下次刷新必然拿到 `invalid_grant`。
 *
 * 此时**不该**把账号判成失效，而应该：**重读文件比对**，发现 refresh token 变了
 * 就用新的那份重试一次。这就是本文件守的东西。
 *
 * ★ 时序很重要：另一个进程的写回必须发生在**我们发出刷新请求的那一刻**——
 *   否则本进程会直接从磁盘读到新凭证、根本走不到刷新路径，测不到自愈逻辑。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'mmcode-selfheal-'));
process.env.MMCODE_HOME = tmpHome;

const { MinimaxTokenManager, saveCredential, readSavedCredential } = await import('./credential.js');

/** 账号的令牌目录（隔离在临时目录里）。 */
const acctDir = join(tmpHome, 'accounts', 'a1', 'mmcode');

/** 另一进程轮换后的新 refresh token。 */
const ROTATED = 'mmort_rotated_by_other_process';

beforeEach(() => {
  mkdirSync(acctDir, { recursive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(acctDir, { recursive: true, force: true });
});

/** 造一份已过期的凭证（access 过期 → 必然触发刷新）。 */
function expiredCred(refreshToken: string): void {
  saveCredential(
    {
      accessToken: 'mmoat_stale',
      refreshToken,
      expiresAt: Date.now() - 1000,
      region: 'cn',
    },
    acctDir,
  );
}

/**
 * 桩上游 token 端点。
 *
 * 第一次调用（用旧的 refresh token）：**在响应前**模拟另一个进程完成轮换并写回磁盘，
 * 然后返回 invalid_grant —— 这正是真实的竞态现场。
 * 第二次调用（用新的 refresh token）：返回成功。
 */
function stubTokenEndpointRace() {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      const rt = body.get('refresh_token') ?? '';
      seen.push(rt);
      if (seen.length === 1) {
        /* ★ 另一进程此刻刷新成功，把新凭证写回同一个文件。 */
        saveCredential(
          {
            accessToken: 'mmoat_other',
            refreshToken: ROTATED,
            expiresAt: Date.now() + 3_600_000,
            region: 'cn',
          },
          acctDir,
        );
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ access_token: 'mmoat_fresh', refresh_token: 'mmort_rotated', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  return seen;
}

/** 桩上游：任何 refresh token 都失败（没人动过凭证）。 */
function stubTokenEndpointAlwaysFails() {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      seen.push(body.get('refresh_token') ?? '');
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return seen;
}

describe('令牌刷新自愈', () => {
  it('★ 别的进程刷新过 → 重读文件用新 refresh token 重试并成功', async () => {
    expiredCred('mmort_old');
    const seen = stubTokenEndpointRace();
    const mgr = new MinimaxTokenManager(() => {}, acctDir);

    const token = await mgr.accessToken();
    expect(token).toBe('mmoat_fresh');
    /* 第一次用旧值失败 → 重读文件 → 用新值成功。 */
    expect(seen).toEqual(['mmort_old', ROTATED]);
  });

  it('★ 没人动过 → 失败就失败（不无限重试）', async () => {
    expiredCred('mmort_old');
    const seen = stubTokenEndpointAlwaysFails();
    const mgr = new MinimaxTokenManager(() => {}, acctDir);

    await expect(mgr.accessToken()).rejects.toThrow(/刷新令牌被拒|invalid_grant/);
    /* 文件里的值没变 → 不重试，只试一次。 */
    expect(seen).toEqual(['mmort_old']);
  });

  it('自愈成功后新的 refresh token 写回磁盘（轮换不丢）', async () => {
    expiredCred('mmort_old');
    stubTokenEndpointRace();
    const mgr = new MinimaxTokenManager(() => {}, acctDir);

    await mgr.accessToken();

    const onDisk = readSavedCredential(acctDir);
    expect(onDisk?.refreshToken).toBe('mmort_rotated');
  });
});
