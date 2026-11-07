/**
 * MiniMax Code 账号管理 —— 静态管理页。
 *
 * 纯静态（无构建步骤）：原生 HTML/CSS/JS，浏览器直接跑。
 * 后端是本仓的 `/admin/api/*`（见 src/admin-api.ts）。
 *
 * 鉴权：登录时把**管理密钥**交给服务端换 HttpOnly 会话 Cookie ——
 * 密钥本身**不存进浏览器**（localStorage / sessionStorage 都不写）。
 */
'use strict';

const state = {
  accounts: [],
  strategy: 'sticky',
  active: null,
  config: null,
  pollTimer: null,
};

/* ───────────────────────── 工具 ───────────────────────── */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast ' + kind;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function regionTag(region) {
  return region === 'global' ? '海外 Global' : '国内 China';
}

/* ───────────────────────── 弹窗 ───────────────────────── */

function openModal(title, bodyHtml, footHtml) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-foot').innerHTML = footHtml || '<button class="ghost" data-close>关闭</button>';
  $('#modal').classList.remove('hidden');
  $$('#modal [data-close]').forEach((b) => b.addEventListener('click', closeModal));
}

function closeModal() {
  $('#modal').classList.add('hidden');
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

/* ───────────────────────── 登录 ───────────────────────── */

async function boot() {
  try {
    const session = await api('/admin/api/session');
    if (session.authenticated) {
      showApp();
      return;
    }
    showLogin();
    if (session.adminKeyPath) {
      $('#key-path-hint').innerHTML =
        `首次启动服务时会自动生成，保存在 <code>${escapeHtml(session.adminKeyPath)}</code>（权限 0600）。`;
    }
  } catch (err) {
    showLogin();
    $('#login-error').textContent = '无法连接服务：' + err.message;
    $('#login-error').classList.remove('hidden');
  }
}

function showLogin() {
  $('#login-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
  $('#login-key').focus();
}

function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  refreshAll();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('#login-key').value;
  const errEl = $('#login-error');
  errEl.classList.add('hidden');
  try {
    await api('/admin/api/session', { method: 'POST', body: { adminKey: key } });
    $('#login-key').value = '';
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('/admin/api/session', { method: 'DELETE' }).catch(() => {});
  showLogin();
});

/* ───────────────────────── 数据加载 ───────────────────────── */

async function refreshAll() {
  await Promise.all([loadAccounts(), loadConfig()]);
}

async function loadAccounts() {
  const data = await api('/admin/api/accounts');
  state.accounts = data.accounts || [];
  state.strategy = data.strategy || 'sticky';
  state.active = data.active;
  renderAccounts();
}

async function loadConfig() {
  try {
    state.config = await api('/admin/api/config');
    renderService();
  } catch {
    /* 配置拿不到不影响账号列表 */
  }
}

/* ───────────────────────── 渲染：账号卡片 ───────────────────────── */

function renderAccounts() {
  const list = $('#account-list');
  list.innerHTML = '';
  $('#accounts-empty').classList.toggle('hidden', state.accounts.length > 0);
  $('#strategy-select').value = state.strategy;

  for (const a of state.accounts) {
    list.appendChild(renderCard(a));
  }
}

function renderCard(a) {
  const card = document.createElement('div');
  card.className = 'card' + (a.enabled ? '' : ' disabled');

  /* 顶部：名字 + 区域 + 状态标签 */
  const top = document.createElement('div');
  top.className = 'card-top';
  const left = document.createElement('div');
  left.innerHTML = `
    <div class="card-name">${escapeHtml(a.name)}${a.isDefault ? ' <span class="muted small">（默认）</span>' : ''}</div>
    <div class="card-sub">${escapeHtml(regionTag(a.region))}${a.account ? ' · 账号 ' + escapeHtml(a.account) + '…' : ''}</div>
    <div class="tags" id="tags-${escapeHtml(a.name)}"></div>`;
  top.appendChild(left);

  const toggle = document.createElement('button');
  toggle.className = 'ghost sm';
  toggle.textContent = a.enabled ? '停用' : '启用';
  toggle.title = a.enabled ? '停用后不参与自动切换' : '启用后参与自动切换';
  toggle.addEventListener('click', async () => {
    await api(`/admin/api/accounts/${encodeURIComponent(a.name)}`, {
      method: 'PATCH',
      body: { enabled: !a.enabled },
    });
    toast(`账号 ${a.name} 已${a.enabled ? '停用' : '启用'}`, 'ok');
    await loadAccounts();
  });
  top.appendChild(toggle);
  card.appendChild(top);

  /* 指标 */
  const metrics = document.createElement('div');
  metrics.className = 'card-metrics';
  metrics.innerHTML = `
    <div>登录态 <b>${a.loggedIn ? '已登录' : '未登录'}</b></div>
    <div>令牌剩余 <b>${tokenLeft(a.tokenExpiresAt)}</b></div>
    <div>上次签到 <b>${a.lastCheckin ? escapeHtml(a.lastCheckin.outcome) : '—'}</b></div>
    <div>余额 <b>${a.lastCredits ? a.lastCredits.remaining : '—'}</b></div>`;
  card.appendChild(metrics);

  /* 操作 */
  const actions = document.createElement('div');
  actions.className = 'card-actions';

  actions.appendChild(mkBtn(a.loggedIn ? '重新授权' : '登录', 'primary sm', () => startLogin(a.name)));
  actions.appendChild(mkBtn('签到', 'ghost sm', async (btn) => {
    btn.disabled = true;
    btn.textContent = '签到中…';
    try {
      const r = await api(`/admin/api/accounts/${encodeURIComponent(a.name)}/checkin`, { method: 'POST' });
      toast(r.message || '签到完成', r.outcome === 'error' ? 'err' : 'ok');
      await loadAccounts();
    } catch (err) {
      toast('签到失败：' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '签到';
    }
  }));
  actions.appendChild(mkBtn('积分', 'ghost sm', async (btn) => {
    btn.disabled = true;
    try {
      const r = await api(`/admin/api/accounts/${encodeURIComponent(a.name)}/credits`);
      openModal(
        `积分账本 · ${a.name}`,
        `<div class="kv" style="padding:0">
          <dt>剩余</dt><dd>${r.remaining}</dd>
          <dt>已消耗</dt><dd>${r.consumed}</dd>
          <dt>累计发放</dt><dd>${r.granted}</dd>
          <dt>最近到期</dt><dd>${r.nextExpireAt ? fmtTime(r.nextExpireAt) : '—'}</dd>
        </div>`,
      );
      await loadAccounts();
    } catch (err) {
      toast('查询失败：' + err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }));
  if (state.active !== a.name) {
    actions.appendChild(mkBtn('设为当前', 'ghost sm', async () => {
      await api('/admin/api/config', { method: 'POST', body: { active: a.name } });
      toast(`已把 ${a.name} 设为粘性账号`, 'ok');
      await loadAccounts();
    }));
  }
  actions.appendChild(mkBtn('删除', 'danger sm', async () => {
    if (!confirm(`确定删除账号「${a.name}」？\n其令牌文件也会一并删除，无法恢复。`)) return;
    try {
      await api(`/admin/api/accounts/${encodeURIComponent(a.name)}`, { method: 'DELETE' });
      toast(`账号 ${a.name} 已删除`, 'ok');
      await loadAccounts();
    } catch (err) {
      toast('删除失败：' + err.message, 'err');
    }
  }));
  card.appendChild(actions);

  /* 状态标签（渲染完再补，因为要按 id 找节点） */
  const tags = card.querySelector(`#tags-${CSS.escape(a.name)}`);
  if (tags) {
    const t = (text, cls) => {
      const s = document.createElement('span');
      s.className = 'tag ' + (cls || '');
      s.textContent = text;
      tags.appendChild(s);
    };
    if (!a.loggedIn) t('未登录', 'warn');
    else if (a.cooling) t('冷却中', 'warn');
    else if (a.health === 'healthy') t('正常', 'ok');
    else if (a.health === 'unauthorized') t('凭证失效', 'err');
    else if (a.health === 'rate_limited') t('被限流', 'warn');
    else if (a.health === 'error') t('异常', 'err');
    if (state.active === a.name) t('当前', 'info');
    if (a.pendingLogin) t('授权中', 'info');
    if (!a.enabled) t('已停用', '');
  }
  return card;
}

function tokenLeft(expiresAt) {
  if (!expiresAt) return '—';
  const min = Math.round((expiresAt - Date.now()) / 60000);
  if (min <= 0) return '已过期';
  if (min < 60) return `${min} 分钟`;
  return `${Math.round(min / 60)} 小时`;
}

function mkBtn(text, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  b.addEventListener('click', () => onClick(b));
  return b;
}

/* ───────────────────────── 渲染：服务信息 ───────────────────────── */

function renderService() {
  const c = state.config;
  if (!c) return;
  $('#upstream-label').textContent = c.proxy ? c.proxy.upstream : '';
  const badge = $('#proxy-badge');
  badge.textContent = `反代 :${c.proxy ? c.proxy.port : '—'} · 账号 ${c.available}/${c.accounts} 可用`;
  badge.className = 'badge ' + (c.available > 0 ? 'ok' : 'warn');

  $('#service-info').innerHTML = `
    <dt>反代端口</dt><dd>${c.proxy ? c.proxy.port : '—'}</dd>
    <dt>上游</dt><dd>${escapeHtml(c.proxy ? c.proxy.upstream : '—')}</dd>
    <dt>切换策略</dt><dd>${c.strategy === 'round-robin' ? '严格轮询（均摊额度）' : '粘性优先 + 故障转移'}</dd>
    <dt>粘性账号</dt><dd>${escapeHtml(c.active || '（自动）')}</dd>
    <dt>入站密钥</dt><dd><code>${escapeHtml(c.apiKeyMasked || '')}</code> <span class="muted small">（给客户端用，非管理密钥）</span></dd>
    <dt>管理密钥文件</dt><dd><code>${escapeHtml(c.adminKeyPath || '')}</code></dd>
    <dt>版本</dt><dd>v${escapeHtml(c.version || '')}</dd>`;
}

/* ───────────────────────── 账号新增 ───────────────────────── */

$('#btn-add').addEventListener('click', () => {
  openModal(
    '新增账号',
    `<label class="field">账号名
       <input id="new-name" type="text" placeholder="例如 haiwai1" autocomplete="off">
     </label>
     <label class="field">区域
       <select id="new-region">
         <option value="cn">国内 China（account.minimax.cn）</option>
         <option value="global">海外 Global（account.minimax.io）</option>
       </select>
     </label>
     <p class="muted small">账号名会作为目录名，只能用字母、数字、下划线、连字符（1–32 位）。<br>
     新增后点卡片上的「登录」，在浏览器完成 MiniMax 官方授权即可。</p>`,
    `<button class="ghost" data-close>取消</button><button class="primary" id="do-add">创建</button>`,
  );
  $('#do-add').addEventListener('click', async () => {
    const name = $('#new-name').value.trim();
    const region = $('#new-region').value;
    if (!name) {
      toast('请填写账号名', 'err');
      return;
    }
    try {
      await api('/admin/api/accounts', { method: 'POST', body: { name, region } });
      closeModal();
      toast(`账号 ${name} 已创建`, 'ok');
      await loadAccounts();
    } catch (err) {
      toast('创建失败：' + err.message, 'err');
    }
  });
  $('#new-name').focus();
});

/* ───────────────────────── OAuth 设备授权 ───────────────────────── */

async function startLogin(name) {
  let res;
  try {
    res = await api(`/admin/api/accounts/${encodeURIComponent(name)}/login`, { method: 'POST' });
  } catch (err) {
    toast('发起授权失败：' + err.message, 'err');
    return;
  }
  openModal(
    `授权登录 · ${name}`,
    `<p class="muted">请在浏览器打开下面的链接，用你的 MiniMax 账号完成授权。授权后本页会自动继续。</p>
     <div class="usercode">${escapeHtml(res.userCode)}</div>
     <p style="text-align:center"><a href="${escapeHtml(res.verificationUriComplete)}" target="_blank" rel="noopener">打开授权页面 ↗</a></p>
     <div class="progress"><i></i></div>
     <p id="login-status" class="muted small" style="text-align:center">等待授权中…</p>`,
    '<button class="ghost" data-close>关闭</button>',
  );

  /* 轮询授权进度（服务端每次只打一次上游，不阻塞连接）。 */
  const poll = async () => {
    let status;
    try {
      status = await api(`/admin/api/accounts/${encodeURIComponent(name)}/login`);
    } catch (err) {
      toast('查询授权状态失败：' + err.message, 'err');
      return;
    }
    const el = $('#login-status');
    if (status.status === 'ok') {
      if (el) el.textContent = '✓ 授权成功，正在刷新…';
      closeModal();
      toast(`账号 ${name} 授权成功`, 'ok');
      await loadAccounts();
      await loadConfig();
      return;
    }
    if (status.status === 'pending' || status.status === 'slow_down') {
      if (el) el.textContent = status.status === 'slow_down' ? '上游要求放慢，稍候…' : '等待授权中…';
      state.pollTimer = setTimeout(poll, 3000);
      return;
    }
    if (status.status === 'expired' || status.status === 'error' || status.status === 'none') {
      if (el) el.textContent = status.message || '授权失败';
      toast(status.message || '授权失败', 'err');
      await loadAccounts();
      return;
    }
    state.pollTimer = setTimeout(poll, 3000);
  };
  state.pollTimer = setTimeout(poll, 1500);
}

/* ───────────────────────── 设置 ───────────────────────── */

$('#btn-settings').addEventListener('click', () => {
  const c = state.config || {};
  openModal(
    '设置',
    `<label class="field">切换策略
       <select id="set-strategy">
         <option value="sticky"${c.strategy === 'sticky' ? ' selected' : ''}>粘性优先 + 故障转移</option>
         <option value="round-robin"${c.strategy === 'round-robin' ? ' selected' : ''}>严格轮询（均摊额度）</option>
       </select>
     </label>
     <label class="field">粘性账号（优先使用）
       <select id="set-active">
         <option value="">（自动）</option>
         ${state.accounts.map((a) => `<option value="${escapeHtml(a.name)}"${state.active === a.name ? ' selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
       </select>
     </label>
     <hr style="border:none;border-top:1px solid var(--line);margin:4px 0">
     <label class="field">当前管理密钥（验证用）
       <input id="set-curkey" type="password" placeholder="当前管理密钥" autocomplete="off">
     </label>
     <label class="field">新管理密钥（至少 16 位）
       <input id="set-newkey" type="password" placeholder="新管理密钥" autocomplete="new-password">
     </label>
     <p class="muted small">修改密钥后，所有已登录会话会立刻失效，需要用新密钥重新登录。</p>`,
    `<button class="ghost" data-close>取消</button>
     <button class="ghost" id="do-change-key">修改密钥</button>
     <button class="primary" id="do-save">保存配置</button>`,
  );

  $('#do-save').addEventListener('click', async () => {
    try {
      await api('/admin/api/config', {
        method: 'POST',
        body: { strategy: $('#set-strategy').value, active: $('#set-active').value || undefined },
      });
      closeModal();
      toast('配置已保存', 'ok');
      await refreshAll();
    } catch (err) {
      toast('保存失败：' + err.message, 'err');
    }
  });

  $('#do-change-key').addEventListener('click', async () => {
    const currentKey = $('#set-curkey').value;
    const newKey = $('#set-newkey').value;
    try {
      await api('/admin/api/admin-key', { method: 'POST', body: { currentKey, newKey } });
      closeModal();
      toast('管理密钥已更新，请用新密钥重新登录', 'ok');
      setTimeout(showLogin, 800);
    } catch (err) {
      toast('修改失败：' + err.message, 'err');
    }
  });
});

/* ───────────────────────── 策略切换 ───────────────────────── */

$('#strategy-select').addEventListener('change', async (e) => {
  const strategy = e.target.value;
  try {
    await api('/admin/api/config', { method: 'POST', body: { strategy } });
    toast('策略已更新', 'ok');
    await loadAccounts();
  } catch (err) {
    toast('切换失败：' + err.message, 'err');
    await loadAccounts();
  }
});

$('#btn-refresh').addEventListener('click', async () => {
  await refreshAll();
  toast('已刷新', 'ok');
});

$('#modal-close').addEventListener('click', closeModal);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

/* ───────────────────────── 工具函数 ───────────────────────── */

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

/* 启动。 */
boot();
