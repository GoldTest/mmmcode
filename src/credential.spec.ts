/**
 * 设备授权凭证测试（假 fetch，不触真实上游、**不发出任何真实授权**）。
 *
 * 重点守三件容易静默出错的事：
 *   ① 未授权时上游返回的是 **HTTP 400 + `authorization_pending`**（实测），
 *      **不是** 200 —— 「400 一律当失败」会把正常等待态报成错误；
 *   ② PKCE 必须真的带上（缺 `code_challenge` 上游直接 400，实测）；
 *   ③ refresh token 轮换必须写回（丢了下次刷新用已作废的值）。
 *
 * ⚠️ 这里**绝不回调真实端点**：全部 fetch 被 stub；`commandDir` 指向临时目录。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 把 `~/.waygate` 重定向到临时目录 —— 凭证/状态文件都落在那里。 */
const tmpHome = mkdtempSync(join(tmpdir(), 'mmcode-cred-'));
process.env.WAYGATE_HOME = tmpHome;

const {
  LOGIN_WAIT_MS,
  MinimaxTokenManager,
  PendingLoginError,
  credentialPath,
  loginStatePath,
  pollDeviceLogin,
  readLoginState,
  readSavedCredential,
  saveCredential,
  startDeviceLogin,
  resolveRegion,
  getAccountBase,
  getAgentBase,
} = await import('./credential.js');

afterEach(() => {
  vi.unstubAllGlobals();
  /* 每例之间清掉落盘产物，避免串味。 */
  for (const p of [credentialPath(), loginStatePath()]) {
    try {
      if (existsSync(p)) rmSync(p);
    } catch {
      /* ignore */
    }
  }
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const DEVICE_OK = {
  device_code: 'dev-code-1',
  user_code: 'Z2MD-MW5P',
  verification_uri: 'https://account.minimax.cn/oauth-authorize',
  verification_uri_complete: 'https://account.minimax.cn/oauth-authorize?user_code=Z2MD-MW5P',
  expires_in: 300,
  interval: 3,
};

describe('startDeviceLogin', () => {
  it('带上 PKCE S256 与三个 OAuth 参数，并落盘 state（0600 意图）', async () => {
    let seenForm: URLSearchParams | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      seenForm = new URLSearchParams(String(init?.body));
      return jsonResponse(DEVICE_OK);
    }));

    const st = await startDeviceLogin();
    expect(st.deviceCode).toBe('dev-code-1');
    expect(st.userCode).toBe('Z2MD-MW5P');
    expect(st.verificationUriComplete).toContain('user_code=Z2MD-MW5P');
    expect(st.intervalMs).toBe(3000);

    /* ★ PKCE 不能省：缺 code_challenge 上游报「valid S256 PKCE is required」（实测 400）。 */
    expect(seenForm!.get('code_challenge_method')).toBe('S256');
    expect(seenForm!.get('code_challenge')).toBeTruthy();
    expect(seenForm!.get('client_id')).toBe('mcode-public');
    expect(seenForm!.get('scope')).toBe('agent.default');
    expect(seenForm!.get('audience')).toBe('agent-backend');

    /* verifier 落盘（取票要用），且与 challenge 对应。 */
    const saved = readLoginState();
    expect(saved?.codeVerifier).toBeTruthy();
    const digest = await import('node:crypto').then((m) =>
      m.createHash('sha256').update(saved!.codeVerifier, 'ascii').digest('base64url'),
    );
    expect(digest).toBe(seenForm!.get('code_challenge'));
  });

  it('缺 verification_uri 时明确报错（不静默返回半成品）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ device_code: 'x', user_code: 'y' })));
    await expect(startDeviceLogin()).rejects.toThrow(/device_code|verification_uri/);
  });
});

describe('pollDeviceLogin', () => {
  it('★ pending（HTTP 400 + authorization_pending）不是错误 —— 超时后抛 PendingLoginError 且保留 state', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('/device/code')) return jsonResponse(DEVICE_OK);
      /* 实测形态：未授权 = 400 + error:authorization_pending */
      return jsonResponse({ error: 'authorization_pending', error_description: 'the user has not finished authorizing yet' }, 400);
    }));

    await startDeviceLogin();
    /* 给一个极短的等待窗，让它很快走到「等够了」。 */
    await expect(pollDeviceLogin(120)).rejects.toBeInstanceOf(PendingLoginError);
    /* ★ state 必须保留 —— 否则用户授权完 `login-poll` 也救不回来。 */
    expect(readLoginState()).not.toBeNull();
  });

  it('授权完成 → 落盘凭证（含 refresh token 与过期时刻）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('/device/code')) return jsonResponse(DEVICE_OK);
      return jsonResponse({ access_token: 'mmoat_abc', refresh_token: 'mmort_xyz', expires_in: 3600 });
    }));

    await startDeviceLogin();
    const cred = await pollDeviceLogin(2000);
    expect(cred.accessToken).toBe('mmoat_abc');
    expect(cred.refreshToken).toBe('mmort_xyz');
    expect(cred.expiresAt).toBeGreaterThan(Date.now());
    /* 成功后 state 应被清掉（避免下次误用旧 device_code）。 */
    expect(readLoginState()).toBeNull();
    expect(readSavedCredential()?.refreshToken).toBe('mmort_xyz');
  });

  it('access_denied → 明确报「你拒绝了授权」（不是含糊失败）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('/device/code')) return jsonResponse(DEVICE_OK);
      return jsonResponse({ error: 'access_denied' }, 400);
    }));
    await startDeviceLogin();
    await expect(pollDeviceLogin(2000)).rejects.toThrow(/拒绝/);
  });

  it('没有待完成登录 → 提示先跑 login', async () => {
    await expect(pollDeviceLogin(10)).rejects.toThrow(/mmcode login/);
  });

  it('设备码过期 → 提示重新 login（而非干等到天荒地老）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('/device/code')) return jsonResponse({ ...DEVICE_OK, expires_in: 1 });
      return jsonResponse({ error: 'authorization_pending' }, 400);
    }));
    await startDeviceLogin();
    await new Promise((r) => setTimeout(r, 1100));
    await expect(pollDeviceLogin(50)).rejects.toThrow(/过期/);
  });
});

describe('MinimaxTokenManager', () => {
  it('未登录 → 明确提示跑 login', async () => {
    const mgr = new MinimaxTokenManager();
    await expect(mgr.accessToken()).rejects.toThrow(/mmcode login/);
  });

  it('★ 刷新轮换 refresh token 必须写回（一次性 token，丢了下次必失败）', async () => {
    saveCredential({ accessToken: 'mmoat_old', refreshToken: 'mmort_old', expiresAt: 0 });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      access_token: 'mmoat_new',
      refresh_token: 'mmort_new',
      expires_in: 3600,
    })));

    const tok = await new MinimaxTokenManager().accessToken();
    expect(tok).toBe('mmoat_new');
    const persisted = JSON.parse(readFileSync(credentialPath(), 'utf8')) as { refreshToken: string };
    expect(persisted.refreshToken).toBe('mmort_new');
  });

  it('凭证未过期 → 直接用，不打上游', async () => {
    saveCredential({ accessToken: 'mmoat_fresh', refreshToken: 'mmort_x', expiresAt: Date.now() + 3600_000 });
    const spy = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', spy);
    expect(await new MinimaxTokenManager().accessToken()).toBe('mmoat_fresh');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('常量', () => {
  it('login 原地等待 2 分钟（用户口径）', () => {
    expect(LOGIN_WAIT_MS).toBe(120_000);
  });
});

describe('多区域支持 (Region & BaseUrls)', () => {
  const origEnv = process.env.MINIMAX_REGION;

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.MINIMAX_REGION = origEnv;
    } else {
      delete process.env.MINIMAX_REGION;
    }
  });

  it('resolveRegion 正常解析别名与环境变量', () => {
    delete process.env.MINIMAX_REGION;
    expect(resolveRegion('global')).toBe('global');
    expect(resolveRegion('intl')).toBe('global');
    expect(resolveRegion('en')).toBe('global');
    expect(resolveRegion('io')).toBe('global');
    expect(resolveRegion('cn')).toBe('cn');
    expect(resolveRegion('china')).toBe('cn');
    expect(resolveRegion('zh')).toBe('cn');
    expect(resolveRegion()).toBe('cn');

    process.env.MINIMAX_REGION = 'global';
    expect(resolveRegion()).toBe('global');
    expect(resolveRegion('cn')).toBe('cn'); // 显式入参优先于环境变量
  });

  it('getAccountBase 与 getAgentBase 正确映射国内与海外域名', () => {
    expect(getAccountBase('cn')).toBe('https://account.minimax.cn');
    expect(getAgentBase('cn')).toBe('https://agent.minimax.cn');
    expect(getAccountBase('global')).toBe('https://account.minimax.io');
    expect(getAgentBase('global')).toBe('https://agent.minimax.io');
  });

  it('海外端点登录：startDeviceLogin 打到 .minimax.io 且 state 记录 region: global', async () => {
    let requestedUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      requestedUrl = String(u);
      return jsonResponse({
        ...DEVICE_OK,
        verification_uri: 'https://account.minimax.io/oauth-authorize',
        verification_uri_complete: 'https://account.minimax.io/oauth-authorize?user_code=Z2MD-MW5P',
      });
    }));

    const st = await startDeviceLogin('global');
    expect(requestedUrl).toBe('https://account.minimax.io/oauth2/device/code');
    expect(st.region).toBe('global');

    const state = readLoginState();
    expect(state?.region).toBe('global');
  });

  it('海外端点轮询取票：根据 state.region 打到 .minimax.io 且落盘凭证含 region: global', async () => {
    let tokenUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).includes('/device/code')) {
        return jsonResponse(DEVICE_OK);
      }
      tokenUrl = String(u);
      return jsonResponse({ access_token: 'mmoat_global', refresh_token: 'mmort_global', expires_in: 3600 });
    }));

    await startDeviceLogin('global');
    const cred = await pollDeviceLogin(2000);
    expect(tokenUrl).toBe('https://account.minimax.io/oauth2/token');
    expect(cred.region).toBe('global');
    expect(readSavedCredential()?.region).toBe('global');
  });

  it('海外凭证刷新：TokenManager 根据凭证 region 打到 .minimax.io 且保留 region', async () => {
    saveCredential({ accessToken: 'mmoat_old', refreshToken: 'mmort_old', expiresAt: 0, region: 'global' });
    let refreshUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      refreshUrl = String(u);
      return jsonResponse({
        access_token: 'mmoat_global_new',
        refresh_token: 'mmort_global_new',
        expires_in: 3600,
      });
    }));

    const mgr = new MinimaxTokenManager();
    const tok = await mgr.accessToken();
    expect(tok).toBe('mmoat_global_new');
    expect(refreshUrl).toBe('https://account.minimax.io/oauth2/token');
    const persisted = readSavedCredential();
    expect(persisted?.region).toBe('global');
    expect(persisted?.refreshToken).toBe('mmort_global_new');
  });
});
