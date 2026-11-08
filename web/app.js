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
  keys: [],
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

/**
 * 复制到剪贴板。
 *
 * `navigator.clipboard` 只在**安全上下文**可用（https 或 localhost）。
 * 用局域网 IP 以 http 访问时没有它 —— 所以留了 execCommand 兜底，
 * 否则「点击复制」在这种部署下会静默失效。
 */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到兜底 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 带「已复制」反馈的复制按钮。 */
function makeCopyBtn(getText, label = '复制') {
  const btn = document.createElement('button');
  btn.className = 'copy-btn ghost';
  btn.textContent = label;
  btn.addEventListener('click', async () => {
    const text = getText();
    if (!text) {
      toast('没有可复制的内容', 'err');
      return;
    }
    const ok = await copyText(text);
    if (ok) {
      btn.classList.add('copied');
      btn.textContent = '✓ 已复制';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = label;
      }, 1400);
    } else {
      toast('复制失败 —— 请手动选中复制（浏览器可能不允许自动复制）', 'err');
    }
  });
  return btn;
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
  await Promise.all([loadAccounts(), loadConfig(), loadKeys()]);
}

async function loadAccounts() {
  const data = await api('/admin/api/accounts');
  state.accounts = data.accounts || [];
  state.strategy = data.strategy || 'sticky';
  state.active = data.active;
  renderAccounts();
}

async function loadKeys() {
  try {
    const data = await api('/admin/api/keys');
    state.keys = data.keys || [];
    renderKeys();
  } catch (err) {
    toast('读取密钥列表失败：' + err.message, 'err');
  }
}

async function loadConfig() {
  try {
    state.config = await api('/admin/api/config');
    renderService();
    renderClientSetup();
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

  actions.appendChild(mkBtn(a.loggedIn ? '重新授权' : '登录', 'primary sm', () => startLogin(a.name, a.region)));
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

/* ───────────────────────── 渲染：客户端密钥 ───────────────────────── */

function renderKeys() {
  const list = $('#key-list');
  list.innerHTML = '';
  $('#keys-empty').classList.toggle('hidden', state.keys.length > 0);

  for (const k of state.keys) {
    const row = document.createElement('div');
    row.className = 'key-row' + (k.enabled ? '' : ' disabled');

    const main = document.createElement('div');
    main.className = 'key-main';

    const nameEl = document.createElement('div');
    nameEl.className = 'key-name';
    nameEl.innerHTML =
      `<span>${escapeHtml(k.name)}</span>` +
      (k.primary ? '<span class="star" title="主密钥">★</span>' : '') +
      (k.enabled ? '' : '<span class="tag warn">已停用</span>');
    main.appendChild(nameEl);

    const secret = document.createElement('div');
    secret.className = 'key-secret';
    secret.textContent = k.masked || k.key;
    main.appendChild(secret);

    const meta = document.createElement('div');
    meta.className = 'key-meta';
    const used = k.lastUsedAt ? `上次使用 ${fmtTime(k.lastUsedAt)}` : '从未使用';
    meta.textContent = `${used} · 创建于 ${fmtTime(k.createdAt)} · id ${k.id}${k.purpose ? ' · ' + k.purpose : ''}`;
    main.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'key-actions';

    /* 复制完整密钥 */
    actions.appendChild(makeCopyBtn(() => k.key, '复制密钥'));

    /* 显示 / 隐藏 */
    const reveal = document.createElement('button');
    reveal.className = 'ghost sm';
    reveal.textContent = '显示';
    let shown = false;
    reveal.addEventListener('click', () => {
      shown = !shown;
      secret.textContent = shown ? k.key : k.masked || k.key;
      secret.classList.toggle('revealed', shown);
      reveal.textContent = shown ? '隐藏' : '显示';
    });
    actions.appendChild(reveal);

    /* 启用 / 停用 */
    actions.appendChild(mkBtn(k.enabled ? '停用' : '启用', 'ghost sm', async () => {
      await api(`/admin/api/keys/${encodeURIComponent(k.id)}`, {
        method: 'PATCH',
        body: { enabled: !k.enabled },
      });
      toast(`密钥「${k.name}」已${k.enabled ? '停用' : '启用'}`, 'ok');
      await loadKeys();
    }));

    /* 轮换 */
    actions.appendChild(mkBtn('轮换', 'ghost sm', async () => {
      if (!confirm(`轮换密钥「${k.name}」？\n旧密钥立即失效，记得同步更新客户端配置。`)) return;
      try {
        const r = await api(`/admin/api/keys/${encodeURIComponent(k.id)}/rotate`, { method: 'POST' });
        toast(`已轮换「${k.name}」，新密钥：${r.key.key}`, 'ok');
        await loadKeys();
      } catch (err) {
        toast('轮换失败：' + err.message, 'err');
      }
    }));

    /* 吊销 */
    actions.appendChild(mkBtn('吊销', 'danger sm', async () => {
      if (!confirm(`吊销密钥「${k.name}」？\n用它的客户端会立刻开始 401。`)) return;
      try {
        await api(`/admin/api/keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
        toast(`密钥「${k.name}」已吊销`, 'ok');
        await loadKeys();
        await loadConfig();
      } catch (err) {
        toast('吊销失败：' + err.message, 'err');
      }
    }));

    row.appendChild(main);
    row.appendChild(actions);
    list.appendChild(row);
  }

  renderClientSetup();
}

/** 顶部「客户端怎么填」——地址与主密钥，一键复制。 */
function renderClientSetup() {
  const el = $('#client-setup');
  const c = state.config && state.config.client ? state.config.client : {};
  const baseUrl = c.baseUrl || '';
  const primary = state.keys.find((k) => k.primary);
  const primaryKey = primary ? primary.key : c.primaryKey || '';

  el.innerHTML = `
    <div class="setup-item">
      <div class="setup-label">Base URL（Claude Code 用这个，不要带 /v1）</div>
      <div class="setup-value">
        <code>${escapeHtml(baseUrl)}</code>
        <span class="copy-slot"></span>
      </div>
    </div>
    <div class="setup-item">
      <div class="setup-label">API Key（主密钥）</div>
      <div class="setup-value">
        <code>${escapeHtml(primaryKey ? primaryKey.slice(0, 14) + '…' : '—')}</code>
        <span class="copy-slot"></span>
      </div>
    </div>`;

  const slots = el.querySelectorAll('.copy-slot');
  if (slots[0]) slots[0].appendChild(makeCopyBtn(() => baseUrl, '复制地址'));
  if (slots[1]) slots[1].appendChild(makeCopyBtn(() => primaryKey, '复制密钥'));
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

async function startLogin(name, region) {
  let res;
  try {
    const payload = region ? { region } : {};
    res = await api(`/admin/api/accounts/${encodeURIComponent(name)}/login`, {
      method: 'POST',
      body: payload,
    });
  } catch (err) {
    toast('发起授权失败：' + err.message, 'err');
    return;
  }
  const isGlobal = region === 'global' || (res.verificationUriComplete && res.verificationUriComplete.includes('.minimax.io'));
  const regionLabel = isGlobal ? '海外 Global' : '国内 China';
  openModal(
    `授权登录 · ${name} (${regionLabel})`,
    `<p class="muted">请在浏览器打开下面的链接，登录你的 MiniMax <b>${regionLabel}</b> 账号完成授权。授权后本页会自动继续。<br>
     <span class="small" style="opacity:0.85;">说明：链接已内嵌授权码，在打开的网页上直接登录海外账号即可自动完成授权，无需手动输码。</span></p>
     <div class="usercode">${escapeHtml(res.userCode)}</div>
     <p style="text-align:center"><a href="${escapeHtml(res.verificationUriComplete)}" target="_blank" rel="noopener">打开 ${regionLabel} 授权页面 ↗</a></p>
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

/* ───────────────────────── 生成新密钥 ───────────────────────── */

$('#btn-new-key').addEventListener('click', () => {
  openModal(
    '生成客户端密钥',
    `<label class="field">用途名称
       <input id="key-name" type="text" placeholder="例如 Claude Code（笔记本）" autocomplete="off">
     </label>
     <label class="field">备注（可选）
       <input id="key-purpose" type="text" placeholder="例如 公司项目 / 家里台式机" autocomplete="off">
     </label>
     <p class="muted small">每把密钥可**单独吊销** —— 某一台设备泄露了，只换它，不影响其它客户端。<br>
     密钥只在生成时完整显示一次（也可以随时点「显示」查看）。</p>`,
    `<button class="ghost" data-close>取消</button><button class="primary" id="do-new-key">生成</button>`,
  );
  $('#do-new-key').addEventListener('click', async () => {
    const name = $('#key-name').value.trim();
    const purpose = $('#key-purpose').value.trim();
    try {
      const r = await api('/admin/api/keys', { method: 'POST', body: { name, purpose } });
      closeModal();
      await loadKeys();
      await loadConfig();
      /* 生成后直接把密钥摆出来，方便当场复制。 */
      openModal(
        '密钥已生成',
        `<div class="usercode" style="font-size:14px;word-break:break-all;letter-spacing:0">${escapeHtml(r.key.key)}</div>
         <p class="muted small">名称：${escapeHtml(r.key.name)}　id：${escapeHtml(r.key.id)}</p>
         <p class="muted small">填进客户端的 API Key 即可。这把密钥以后可在列表里随时吊销。</p>`,
        `<button class="ghost" data-close>关闭</button><span class="copy-slot2"></span>`,
      );
      const slot = document.querySelector('.copy-slot2');
      if (slot) slot.appendChild(makeCopyBtn(() => r.key.key, '复制密钥'));
    } catch (err) {
      toast('生成失败：' + err.message, 'err');
    }
  });
  $('#key-name').focus();
});

$('#btn-refresh-keys').addEventListener('click', async () => {
  await loadKeys();
  toast('密钥列表已刷新', 'ok');
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
