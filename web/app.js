/**
 * MiniMax Code 本地反代 —— 管理端交互逻辑。
 *
 * 纯原生 JS 实现无构建步骤。
 * 支持 5 个 Tab 页布局：
 *   Tab 1: 账号与凭证（账号池、自动签到、自动令牌刷新、客户端密钥管理）
 *   Tab 2: 反代服务管理（拓扑、调度模式、冷却池、端点与模型速查、在线测试）
 *   Tab 3: 请求详情与监控（实时监控、缓存管理、请求列表、输入输出对话详情）
 *   Tab 4: 用量洞察（各账号 token 用量台账）
 *   Tab 5: 设置选项（管理密钥、自动任务计划、客户端接入配置、系统信息）
 */
'use strict';

const state = {
  accounts: [],
  mode: 'max-cache',
  creditsThreshold: 100,
  insights: null,
  insightsTotals: null,
  insightsMode: 'max-cache',
  config: null,
  keys: [],
  models: [],
  schedulerStatus: null,
  requestStats: null,
  requests: [],
  currentRequestDetail: null,
  pollTimer: null,
  requestsPollTimer: null,
  autoRefreshRequests: true,
  refreshIntervalMs: 2000,
  activeTab: 'tab-accounts',
};

/* ───────────────────────── 工具函数 ───────────────────────── */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast ' + kind;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 降级到 fallback */
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

function makeCopyBtn(getText, label = '复制') {
  const btn = document.createElement('button');
  btn.className = 'copy-btn ghost sm';
  btn.textContent = label;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
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
      toast('复制失败 —— 请手动选中复制', 'err');
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
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtTimeShort(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function regionTag(region) {
  return region === 'global' ? '海外 Global' : '国内 China';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function tokenLeft(expiresAt) {
  if (!expiresAt) return '未登录';
  const min = Math.round((expiresAt - Date.now()) / 60000);
  if (min <= 0) return '已过期';
  if (min < 60) return `${min} 分钟`;
  return `${Math.round(min / 60)} 小时`;
}

/* ───────────────────────── 弹窗控制 ───────────────────────── */

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

function openRequestModal(record) {
  state.currentRequestDetail = record;
  $('#req-modal-title').textContent = `请求详情 · ${record.id}`;

  const isSuccess = record.status >= 200 && record.status < 300;
  const statusBadge = `<span class="badge ${isSuccess ? 'ok' : 'err'}">${record.status}</span>`;

  // 格式化输入信息
  let inputHtml = '';
  if (record.input && record.input.messages && Array.isArray(record.input.messages)) {
    inputHtml = '<div style="margin-bottom:8px;"><b>对话上下文（Messages）：</b></div>';
    for (const msg of record.input.messages) {
      const role = String(msg.role || 'user').toLowerCase();
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
      inputHtml += `
        <div class="msg-bubble ${role}">
          <div class="msg-role">${escapeHtml(role)}</div>
          <div class="msg-text">${escapeHtml(content)}</div>
        </div>`;
    }
  } else if (record.input && record.input.prompt) {
    inputHtml = `
      <div class="msg-bubble user">
        <div class="msg-role">Prompt</div>
        <div class="msg-text">${escapeHtml(record.input.prompt)}</div>
      </div>`;
  } else {
    inputHtml = '<p class="muted small">无结构化输入内容</p>';
  }

  // 格式化输出信息
  let outputHtml = '';
  if (record.output && record.output.text) {
    outputHtml = `
      <div class="msg-bubble assistant">
        <div class="msg-role">Assistant 回复内容</div>
        <div class="msg-text">${escapeHtml(record.output.text)}</div>
      </div>`;
  }
  if (record.output && record.output.toolCalls && record.output.toolCalls.length > 0) {
    outputHtml += `
      <div style="margin-top:8px;"><b>工具调用（Tool Calls）：</b></div>
      <pre class="code-block">${escapeHtml(JSON.stringify(record.output.toolCalls, null, 2))}</pre>`;
  }
  if (record.error) {
    outputHtml += `
      <div class="msg-bubble system" style="border-color:rgba(248,81,73,0.4);background:rgba(248,81,73,0.06);">
        <div class="msg-role" style="color:var(--err)">错误信息</div>
        <div class="msg-text" style="color:var(--err)">${escapeHtml(record.error)}</div>
      </div>`;
  }
  if (!outputHtml) {
    outputHtml = '<p class="muted small">无输出回复内容</p>';
  }

  const usage = record.output && record.output.usage;
  /* 缓存命中与命中率：权威值由适配器记录（上游原始 usage），这里只做展示。 */
  const cachedTokens = usage ? usage.cached_tokens ?? 0 : 0;
  const hitRate = usage
    ? typeof usage.cache_hit_rate === 'number'
      ? usage.cache_hit_rate
      : usage.prompt_tokens
        ? cachedTokens / usage.prompt_tokens
        : 0
    : 0;
  const usageStr = usage
    ? `输入: <b>${fmtInt(usage.prompt_tokens ?? 0)}</b> | 输出: <b>${fmtInt(usage.completion_tokens ?? 0)}</b> | 总计: <b>${fmtInt(usage.total_tokens ?? 0)}</b> | 缓存命中: <b>${fmtInt(cachedTokens)}</b>`
    : '—';

  /* 首字符时间：收到请求 → 第一个响应字节（流式体感速度，与总耗时不是一回事）。 */
  const firstByteStr = typeof record.firstByteMs === 'number' ? `${record.firstByteMs} ms` : '—';

  /* ── 中转栏 ──
     入站是 OpenAI / Anthropic 形状，出站统一是 Anthropic 兼容形状 ——
     这一层翻译最容易出「我发的和上游收到的不一样」，所以把上游实际收到的请求摆出来。 */
  const transit = record.transit;
  const transitHtml = transit
    ? `
      <dl class="req-kv">
        <dt>上游地址</dt><dd>${escapeHtml(transit.upstream)}</dd>
        <dt>服务账号</dt><dd>${escapeHtml(transit.account || '—')}</dd>
        <dt>出站协议</dt><dd>${escapeHtml(transit.protocol || '—')}</dd>
      </dl>
      <details open>
        <summary class="small muted" style="cursor:pointer;">转译后实际发给上游的请求</summary>
        <pre class="code-block">${escapeHtml(JSON.stringify(transit.payload ?? null, null, 2))}</pre>
      </details>`
    : '<p class="muted small">本次请求没有中转记录 —— 可能未到达上游。</p>';

  /* ── 输出详情 ── */
  const outDetailRows = [
    ['结束原因', record.output && record.output.finish_reason ? record.output.finish_reason : '—'],
    ['输入 token', usage ? fmtInt(usage.prompt_tokens ?? 0) : '—'],
    ['输出 token', usage ? fmtInt(usage.completion_tokens ?? 0) : '—'],
    ['缓存命中', usage ? `${fmtInt(cachedTokens)}（命中率 ${(hitRate * 100).toFixed(1)}%）` : '—'],
    ['首字符时间', firstByteStr],
    ['总耗时', `${record.durationMs} ms`],
  ];
  const outDetailHtml = `<dl class="req-kv">${outDetailRows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`)
    .join('')}</dl>`;

  const bodyHtml = `
    <!-- 基本指标 -->
    <div class="card-metrics" style="background:var(--bg-soft);padding:12px;border-radius:8px;border:1px solid var(--line);">
      <div>请求状态 <b>${statusBadge}</b></div>
      <div>首字符时间 <b>${firstByteStr}</b></div>
      <div>响应耗时 <b>${record.durationMs} ms</b></div>
      <div>请求端点 <b>${escapeHtml(record.method)} ${escapeHtml(record.path)}</b></div>
      <div>请求模型 <b>${escapeHtml(record.model || '默认')}</b></div>
      <div>调用账号 <b>${escapeHtml(record.account || '自动')}</b></div>
      <div>客户端密钥 <b>${escapeHtml(record.keyName || '默认')} (${escapeHtml(record.keyMasked || '—')})</b></div>
      <div>来源 IP <b>${escapeHtml(record.clientIp || '—')}</b></div>
      <div>流式模式 <b>${record.stream ? 'SSE 流式' : '单次返回'}</b></div>
      <div style="grid-column: span 2;">Token 用量 ${usageStr}</div>
      <div>缓存命中率 <b>${(hitRate * 100).toFixed(1)}%</b></div>
      <div style="grid-column: span 2;">请求时间 <b>${fmtTime(record.timestamp)}</b></div>
    </div>

    <!-- 横向三栏：请求 / 中转 / 输出 -->
    <div class="req-cols">
      <section class="req-col">
        <h4>请求</h4>
        <div class="req-col-body">
          ${inputHtml}
          <details>
            <summary class="small muted" style="cursor:pointer;">查看完整入站 JSON</summary>
            <pre class="code-block">${escapeHtml(JSON.stringify(record.input, null, 2))}</pre>
          </details>
        </div>
      </section>

      <section class="req-col">
        <h4>中转</h4>
        <div class="req-col-body">
          ${transitHtml}
        </div>
      </section>

      <section class="req-col">
        <h4>输出</h4>
        <div class="req-col-body">
          ${outputHtml}
          ${outDetailHtml}
          <details>
            <summary class="small muted" style="cursor:pointer;">查看完整输出 JSON</summary>
            <pre class="code-block">${escapeHtml(JSON.stringify(record.output, null, 2))}</pre>
          </details>
        </div>
      </section>
    </div>`;

  $('#req-modal-body').innerHTML = bodyHtml;
  $('#request-detail-modal').classList.remove('hidden');
}

function closeRequestModal() {
  $('#request-detail-modal').classList.add('hidden');
  state.currentRequestDetail = null;
}

$('#btn-copy-req-json').addEventListener('click', async () => {
  if (!state.currentRequestDetail) return;
  const ok = await copyText(JSON.stringify(state.currentRequestDetail, null, 2));
  if (ok) toast('已复制完整请求记录 JSON', 'ok');
  else toast('复制失败', 'err');
});

$('#req-modal-close').addEventListener('click', closeRequestModal);
$('#req-modal-btn-close').addEventListener('click', closeRequestModal);

/* ───────────────────────── 认证与启动 ───────────────────────── */

async function boot() {
  try {
    const session = await api('/admin/api/session');
    if (session.authenticated) {
      showApp();
      return;
    }
    showLogin();
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
  stopRequestsAutoRefresh();
}

function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  refreshAll();
  startRequestsAutoRefresh();
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

const btnLogout = $('#btn-logout');
if (btnLogout) {
  btnLogout.addEventListener('click', async () => {
    await api('/admin/api/session', { method: 'DELETE' }).catch(() => {});
    showLogin();
  });
}

$('#btn-bottom-logout').addEventListener('click', async () => {
  await api('/admin/api/session', { method: 'DELETE' }).catch(() => {});
  showLogin();
});

const btnTopRefresh = $('#btn-top-refresh');
if (btnTopRefresh) {
  btnTopRefresh.addEventListener('click', async () => {
    await refreshAll();
    toast('所有数据已刷新', 'ok');
  });
}

/* ───────────────────────── Tab 页切换 ───────────────────────── */

$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    if (!target) return;
    state.activeTab = target;

    $$('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    $$('.tab-pane').forEach((p) => p.classList.remove('active'));
    const pane = $(`#${target}`);
    if (pane) pane.classList.add('active');

    // 切换到特定 tab 时触发局部刷新
    if (target === 'tab-requests') {
      loadRequests();
      loadRequestStats();
      startRequestsAutoRefresh();
    } else if (target === 'tab-proxy') {
      loadProxyDetails();
      loadModels();
    } else if (target === 'tab-insights') {
      loadInsights();
    }
  });
});

/* ───────────────────────── 全量刷新 ───────────────────────── */

async function refreshAll() {
  await Promise.allSettled([
    loadAccounts(),
    loadConfig(),
    loadKeys(),
    loadScheduler(),
    loadProxyDetails(),
    loadModels(),
    loadRequestStats(),
    loadRequests(),
    loadInsights(),
  ]);
}

/* ───────────────────────── Tab 1: 账号与凭证 ───────────────────────── */

async function loadAccounts() {
  try {
    const data = await api('/admin/api/accounts');
    state.accounts = data.accounts || [];
    state.mode = data.mode || 'max-cache';
    state.creditsThreshold = typeof data.creditsThreshold === 'number' ? data.creditsThreshold : 100;
    renderAccounts();
    renderCheckinTable();
    renderTokensTable();
    renderCooldownTable();
  } catch (err) {
    toast('加载账号列表失败：' + err.message, 'err');
  }
}

function renderAccounts() {
  const list = $('#account-list');
  list.innerHTML = '';
  $('#accounts-empty').classList.toggle('hidden', state.accounts.length > 0);
  $('#mode-select').value = state.mode;
  $('#credits-threshold-input').value = String(state.creditsThreshold);

  // 顶栏 Badge（冻结的账号不参与调度，算作不可用）
  const availableCount = state.accounts.filter((a) => a.enabled && a.loggedIn && !a.cooling && !a.frozen).length;
  const accBadge = $('#account-badge');
  if (accBadge) {
    accBadge.textContent = `账号 ${availableCount}/${state.accounts.length} 就绪`;
    accBadge.className = 'badge ' + (availableCount > 0 ? 'ok' : 'warn');
  }

  for (const a of state.accounts) {
    list.appendChild(renderAccountCard(a));
  }
}

function renderAccountCard(a) {
  const card = document.createElement('div');
  card.className = 'card card-account' + (a.enabled ? '' : ' disabled');
  card.dataset.name = a.name;

  /* 令牌失效判定：健康态为 unauthorized，或令牌已过期 —— 这两种情况才需要重新授权。 */
  const tokenDead = a.health === 'unauthorized' || (a.tokenExpiresAt != null && a.tokenExpiresAt <= Date.now());

  const top = document.createElement('div');
  top.className = 'card-top';
  const left = document.createElement('div');
  left.className = 'card-head';
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

  const metrics = document.createElement('div');
  metrics.className = 'card-metrics';
  metrics.innerHTML = `
    <div>登录态 <b>${a.loggedIn ? '已登录' : '未登录'}</b></div>
    <div>令牌有效 <b>${tokenLeft(a.tokenExpiresAt)}</b></div>
    <div>上次签到 <b>${a.lastCheckin ? escapeHtml(a.lastCheckin.outcome) : '—'}</b></div>
    <div>剩余积分 <b>${a.lastCredits ? a.lastCredits.remaining : '—'}</b></div>`;
  card.appendChild(metrics);

  // 优先级编辑（数字越小越优先，0 为最高层）
  const prioRow = document.createElement('div');
  prioRow.className = 'card-priority';
  const prioLabel = document.createElement('span');
  prioLabel.className = 'small muted';
  prioLabel.textContent = '优先级';
  const prioInput = document.createElement('input');
  prioInput.type = 'number';
  prioInput.min = '0';
  prioInput.max = '99';
  prioInput.step = '1';
  prioInput.className = 'prio-input';
  prioInput.value = String(a.priority ?? 0);
  prioInput.title = '数字越小越优先（0 为最高层）';
  prioInput.addEventListener('change', async () => {
    const next = Math.max(0, Math.min(99, Math.trunc(Number(prioInput.value) || 0)));
    if (next === (a.priority ?? 0)) {
      prioInput.value = String(a.priority ?? 0);
      return;
    }
    prioInput.disabled = true;
    try {
      await api(`/admin/api/accounts/${encodeURIComponent(a.name)}`, {
        method: 'PATCH',
        body: { priority: next },
      });
      toast(`账号 ${a.name} 优先级已设为 P${next}`, 'ok');
      await loadAccounts();
    } catch (err) {
      toast('设置优先级失败：' + err.message, 'err');
      prioInput.value = String(a.priority ?? 0);
    } finally {
      prioInput.disabled = false;
    }
  });
  prioRow.appendChild(prioLabel);
  prioRow.appendChild(prioInput);
  card.appendChild(prioRow);

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  /* 未登录 → 首次登录授权；令牌失效 → 重新授权。令牌正常时不显示授权按钮。 */
  if (!a.loggedIn) {
    actions.appendChild(mkBtn('登录授权', 'primary sm', () => startLogin(a.name, a.region)));
  } else if (tokenDead) {
    actions.appendChild(mkBtn('重新授权', 'primary sm', () => startLogin(a.name, a.region)));
  }

  actions.appendChild(mkBtn('体检', 'ghost sm', async (btn) => {
    btn.disabled = true;
    try {
      const r = await api(`/admin/api/accounts/${encodeURIComponent(a.name)}/doctor`);
      const rows = r.checks.map((c) => `<div>${c.ok ? '✓' : '✕'} ${escapeHtml(c.name)}: ${escapeHtml(c.detail)}</div>`).join('');
      openModal(`体检结果 · ${a.name}`, `<div style="font-size:13px;line-height:1.8;">${rows}</div>`);
      await loadAccounts();
    } catch (err) {
      toast('体检失败：' + err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }));

  actions.appendChild(mkBtn('签到', 'ghost sm', async (btn) => {
    btn.disabled = true;
    btn.textContent = '签到中…';
    try {
      const r = await api(`/admin/api/accounts/${encodeURIComponent(a.name)}/checkin`, { method: 'POST' });
      toast(r.message || '签到完成', r.outcome === 'error' ? 'err' : 'ok');
      await loadAccounts();
      await loadScheduler();
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
          <dt>剩余积分</dt><dd><b>${r.remaining}</b></dd>
          <dt>已消耗积分</dt><dd>${r.consumed}</dd>
          <dt>累计发放积分</dt><dd>${r.granted}</dd>
          <dt>最近到期时间</dt><dd>${r.nextExpireAt ? fmtTime(r.nextExpireAt) : '—'}</dd>
        </div>`,
      );
      await loadAccounts();
    } catch (err) {
      toast('查询失败：' + err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }));

  // 冻结 / 解冻（额度冻结后不参与调度）
  actions.appendChild(mkBtn(a.frozen ? '解冻' : '冻结', a.frozen ? 'ghost sm' : 'ghost sm danger', async (btn) => {
    btn.disabled = true;
    try {
      await api(`/admin/api/accounts/${encodeURIComponent(a.name)}`, {
        method: 'PATCH',
        body: a.frozen ? { frozen: false } : { frozen: true, frozenReason: '手动冻结' },
      });
      toast(`账号 ${a.name} 已${a.frozen ? '解冻' : '冻结'}`, 'ok');
      await loadAccounts();
    } catch (err) {
      toast((a.frozen ? '解冻' : '冻结') + '失败：' + err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }));

  /* 调整展示顺序 —— 只改卡片排列，不影响调度优先级。 */
  const orderBtns = document.createElement('div');
  orderBtns.className = 'card-order';
  orderBtns.appendChild(mkBtn('↑', 'ghost sm icon-only', (btn) => moveAccount(a.name, -1, btn)));
  orderBtns.appendChild(mkBtn('↓', 'ghost sm icon-only', (btn) => moveAccount(a.name, 1, btn)));
  actions.appendChild(orderBtns);

  actions.appendChild(mkBtn('删除', 'danger sm', async () => {
    if (!confirm(`确定删除账号「${a.name}」？\n其令牌文件将一并删除。`)) return;
    try {
      await api(`/admin/api/accounts/${encodeURIComponent(a.name)}`, { method: 'DELETE' });
      toast(`账号 ${a.name} 已删除`, 'ok');
      await loadAccounts();
    } catch (err) {
      toast('删除失败：' + err.message, 'err');
    }
  }));

  card.appendChild(actions);

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
    else if (a.health === 'rate_limited') t('限流中', 'warn');
    else if (a.health === 'error') t('异常', 'err');
    t(`优先级 P${a.priority ?? 0}`, 'info');
    if (a.frozen) t(`额度冻结${a.frozenReason ? '：' + a.frozenReason : ''}`, 'warn');
    if (a.pendingLogin) t('授权中', 'info');
    if (!a.enabled) t('已停用', '');
  }
  return card;
}

/**
 * 把某个账号往上/往下挪一位（仅调整展示顺序，不改调度优先级）。
 *
 * 顺序以服务端返回的账号列表为准，整体重排后一次性提交。
 */
async function moveAccount(name, delta, btn) {
  const names = state.accounts.map((a) => a.name);
  const idx = names.indexOf(name);
  const target = idx + delta;
  if (idx < 0 || target < 0 || target >= names.length) return;
  names.splice(target, 0, names.splice(idx, 1)[0]);
  if (btn) btn.disabled = true;
  try {
    await api('/admin/api/accounts/reorder', { method: 'POST', body: { order: names } });
    await loadAccounts();
  } catch (err) {
    toast('调整顺序失败：' + err.message, 'err');
    await loadAccounts();
  }
}

function mkBtn(text, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  b.addEventListener('click', () => onClick(b));
  return b;
}

// 调度模式与最小可用积分
$('#mode-select').addEventListener('change', async (e) => {
  const mode = e.target.value;
  try {
    await api('/admin/api/config', { method: 'POST', body: { mode } });
    toast('调度模式已切换', 'ok');
    await loadAccounts();
  } catch (err) {
    toast('切换失败：' + err.message, 'err');
    await loadAccounts();
  }
});

$('#credits-threshold-input').addEventListener('change', async (e) => {
  const threshold = Math.max(0, Math.trunc(Number(e.target.value) || 0));
  try {
    await api('/admin/api/config', { method: 'POST', body: { creditsThreshold: threshold } });
    toast(`最小可用积分已设为 ${threshold}`, 'ok');
    await loadAccounts();
  } catch (err) {
    toast('设置最小可用积分失败：' + err.message, 'err');
    await loadAccounts();
  }
});

// 立即刷新所有账号额度（按阈值冻结/解冻）
$('#btn-refresh-credits').addEventListener('click', async (btn) => {
  btn.disabled = true;
  btn.textContent = '刷新中…';
  try {
    const res = await api('/admin/api/credits/refresh', { method: 'POST' });
    if (res.busy) {
      toast(res.note || '已有额度巡检在进行中', 'err');
      await loadAccounts();
      return;
    }
    const results = res.results || [];
    const okCount = results.filter((r) => r.ok).length;
    /* 退避跳过的账号**不算失败** —— 它没被请求上游，只是在等退避窗口过去。 */
    const skipCount = results.filter((r) => r.skipped).length;
    const failCount = results.filter((r) => !r.ok && !r.skipped).length;
    const skipTag = skipCount > 0 ? `，退避跳过 ${skipCount} 个` : '';
    toast(
      `额度刷新完成：成功 ${okCount} 个，失败 ${failCount} 个${skipTag}`,
      failCount > 0 ? 'err' : 'ok',
    );
    await loadAccounts();
    await loadInsights();
  } catch (err) {
    toast('额度刷新失败：' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '立即刷新额度';
  }
});

$('#btn-refresh-accounts').addEventListener('click', async () => {
  await loadAccounts();
  toast('账号池已刷新', 'ok');
});

// 新增账号
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
     <p class="muted small">账号名只允许 1–32 位字母、数字、下划线、连字符。<br>
     新增后在账号卡片上点击「登录授权」并在浏览器完成授权即可。</p>`,
    `<button class="ghost" data-close>取消</button><button class="primary" id="do-add">创建账号</button>`,
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

// OAuth 授权流程
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
    `<p class="muted">请在浏览器打开下面的链接完成 MiniMax <b>${regionLabel}</b> 账号授权：</p>
     <div class="usercode">${escapeHtml(res.userCode)}</div>
     <p style="text-align:center;margin:12px 0;"><a href="${escapeHtml(res.verificationUriComplete)}" target="_blank" rel="noopener" class="primary" style="padding:6px 16px;border-radius:6px;display:inline-block;text-decoration:none;color:#fff;background:var(--accent);">打开 ${regionLabel} 授权页面 ↗</a></p>
     <div class="progress"><i></i></div>
     <p id="login-status" class="muted small" style="text-align:center">正在监听授权完成中…</p>`,
    '<button class="ghost" data-close>关闭</button>',
  );

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
      if (el) el.textContent = status.status === 'slow_down' ? '上游要求放慢，请稍候…' : '正在监听授权完成中…';
      state.pollTimer = setTimeout(poll, 3000);
      return;
    }
    if (status.status === 'expired' || status.status === 'error' || status.status === 'none') {
      if (el) el.textContent = status.message || '授权失败或已过期';
      toast(status.message || '授权失败', 'err');
      await loadAccounts();
      return;
    }
    state.pollTimer = setTimeout(poll, 3000);
  };
  state.pollTimer = setTimeout(poll, 1500);
}

/* ───────────────────────── 自动签到表格与调度 ───────────────────────── */

async function loadScheduler() {
  try {
    const s = await api('/admin/api/scheduler');
    state.schedulerStatus = s;
    if (s.autoCheckin) {
      $('#checkin-status-badge').textContent = s.autoCheckin.enabled ? '后台自动运行中' : '已暂停';
      $('#checkin-status-badge').className = 'badge ' + (s.autoCheckin.enabled ? 'ok' : 'warn');
      $('#checkin-next-time').textContent = `每日定时 ${s.autoCheckin.time}`;
      $('#setting-checkin-enabled').checked = s.autoCheckin.enabled;
      $('#setting-checkin-time').value = s.autoCheckin.time || '08:00';
    }
    if (s.autoRefresh) {
      $('#refresh-status-badge').textContent = s.autoRefresh.enabled ? '后台自动巡检中' : '已暂停';
      $('#refresh-status-badge').className = 'badge ' + (s.autoRefresh.enabled ? 'ok' : 'warn');
      $('#refresh-interval-label').textContent = `每 ${s.autoRefresh.intervalMinutes} 分钟巡检 (余量 < ${s.autoRefresh.marginMinutes}m 自动续期)`;
      $('#setting-refresh-enabled').checked = s.autoRefresh.enabled;
      $('#setting-refresh-interval').value = s.autoRefresh.intervalMinutes;
      $('#setting-refresh-margin').value = s.autoRefresh.marginMinutes;
    }
    renderCheckinTable();
    renderTokensTable();
  } catch {
    // 忽略调度器获取失败
  }
}

function renderCheckinTable() {
  const tbody = $('#checkin-table-body');
  if (!state.accounts || state.accounts.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">还没有账号</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  for (const a of state.accounts) {
    const tr = document.createElement('tr');
    const last = a.lastCheckin;
    const outcome = last ? last.outcome : '未签到';
    let outcomeBadge = '<span class="tag">未签</span>';
    if (outcome === 'claimed') outcomeBadge = '<span class="tag ok">今日新签得积分</span>';
    else if (outcome === 'already') outcomeBadge = '<span class="tag ok">今日已签到</span>';
    else if (outcome === 'unavailable') outcomeBadge = '<span class="tag warn">暂不可签</span>';
    else if (outcome === 'error') outcomeBadge = '<span class="tag err">签到异常</span>';

    const credits = a.lastCredits ? `${a.lastCredits.remaining} / ${a.lastCredits.granted}` : '—';

    tr.innerHTML = `
      <td><b>${escapeHtml(a.name)}</b></td>
      <td><span class="tag">${escapeHtml(regionTag(a.region))}</span></td>
      <td>${outcomeBadge}</td>
      <td><b>${last && last.streak != null ? last.streak + ' 天' : '—'}</b></td>
      <td>${last && last.points != null ? '+' + last.points : '—'}</td>
      <td class="small muted">${last && last.at ? fmtTime(last.at) : '—'}</td>
      <td><b>${credits}</b></td>
      <td></td>`;

    const tdAction = tr.querySelector('td:last-child');
    tdAction.appendChild(mkBtn('立即签到', 'ghost sm', async (btn) => {
      btn.disabled = true;
      try {
        const r = await api(`/admin/api/accounts/${encodeURIComponent(a.name)}/checkin`, { method: 'POST' });
        toast(r.message || '签到成功', r.outcome === 'error' ? 'err' : 'ok');
        await loadAccounts();
        await loadScheduler();
      } catch (err) {
        toast('签到失败：' + err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    }));
    tbody.appendChild(tr);
  }
}

$('#btn-checkin-all').addEventListener('click', async (btn) => {
  btn.disabled = true;
  btn.textContent = '全员签到中…';
  try {
    const res = await api('/admin/api/scheduler/checkin-all', { method: 'POST' });
    const count = res.results ? res.results.length : 0;
    toast(`已完成 ${count} 个账号签到检测`, 'ok');
    await loadAccounts();
    await loadScheduler();
  } catch (err) {
    toast('全员签到失败：' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '立即全员签到';
  }
});

/* ───────────────────────── 自动令牌刷新表格 ───────────────────────── */

function renderTokensTable() {
  const tbody = $('#tokens-table-body');
  if (!state.accounts || state.accounts.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">还没有账号</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  for (const a of state.accounts) {
    const tr = document.createElement('tr');
    const expiresAt = a.tokenExpiresAt;
    const minLeft = expiresAt ? Math.round((expiresAt - Date.now()) / 60000) : null;
    let statusBadge = '<span class="tag warn">未登录</span>';
    if (a.loggedIn) {
      if (minLeft && minLeft > 30) statusBadge = '<span class="tag ok">有效就绪</span>';
      else if (minLeft && minLeft > 0) statusBadge = '<span class="tag warn">即将过期 (<30m)</span>';
      else statusBadge = '<span class="tag err">已过期</span>';
    }

    let healthBadge = '<span class="tag ok">健康</span>';
    if (a.health === 'unauthorized') healthBadge = '<span class="tag err">凭证被顶掉</span>';
    else if (a.health === 'rate_limited') healthBadge = '<span class="tag warn">被限流</span>';
    else if (a.health === 'error') healthBadge = '<span class="tag err">网络异常</span>';

    tr.innerHTML = `
      <td><b>${escapeHtml(a.name)}</b></td>
      <td>${statusBadge}</td>
      <td class="small muted">${expiresAt ? fmtTime(expiresAt) : '—'}</td>
      <td><b>${tokenLeft(expiresAt)}</b></td>
      <td>${healthBadge}</td>
      <td></td>`;

    const tdAction = tr.querySelector('td:last-child');
    tdAction.appendChild(mkBtn('体检刷新', 'ghost sm', async (btn) => {
      btn.disabled = true;
      try {
        const r = await api(`/admin/api/accounts/${encodeURIComponent(a.name)}/doctor`);
        toast(`体检完成：${r.checks.map((c) => c.name + (c.ok ? '✓' : '✕')).join(' ')}`, 'ok');
        await loadAccounts();
      } catch (err) {
        toast('体检失败：' + err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    }));

    tbody.appendChild(tr);
  }
}

$('#btn-refresh-tokens-all').addEventListener('click', async (btn) => {
  btn.disabled = true;
  btn.textContent = '巡检刷新中…';
  try {
    const res = await api('/admin/api/scheduler/refresh-all', { method: 'POST', body: { force: false } });
    toast(`已巡检 ${res.results ? res.results.length : 0} 个账号令牌`, 'ok');
    await loadAccounts();
    await loadScheduler();
  } catch (err) {
    toast('巡检刷新失败：' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '立即巡检刷新全部';
  }
});

$('#btn-force-refresh-tokens').addEventListener('click', async (btn) => {
  if (!confirm('确定强制向 MiniMax 上游刷新所有账号的令牌？')) return;
  btn.disabled = true;
  btn.textContent = '强制刷新中…';
  try {
    const res = await api('/admin/api/scheduler/refresh-all', { method: 'POST', body: { force: true } });
    toast(`已强制刷新 ${res.results ? res.results.length : 0} 个账号令牌`, 'ok');
    await loadAccounts();
    await loadScheduler();
  } catch (err) {
    toast('强制刷新失败：' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '强制重新签发';
  }
});

/* ───────────────────────── 客户端密钥管理 ───────────────────────── */

async function loadKeys() {
  try {
    const data = await api('/admin/api/keys');
    state.keys = data.keys || [];
    renderKeys();
  } catch (err) {
    toast('读取密钥列表失败：' + err.message, 'err');
  }
}

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
      (k.primary ? '<span class="star" title="主密钥">★ 主密钥</span>' : '') +
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

    actions.appendChild(makeCopyBtn(() => k.key, '复制密钥'));

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

    actions.appendChild(mkBtn(k.enabled ? '停用' : '启用', 'ghost sm', async () => {
      await api(`/admin/api/keys/${encodeURIComponent(k.id)}`, {
        method: 'PATCH',
        body: { enabled: !k.enabled },
      });
      toast(`密钥「${k.name}」已${k.enabled ? '停用' : '启用'}`, 'ok');
      await loadKeys();
    }));

    actions.appendChild(mkBtn('轮换', 'ghost sm', async () => {
      if (!confirm(`轮换密钥「${k.name}」？\n旧密钥立即失效，需同步更新客户端配置。`)) return;
      try {
        const r = await api(`/admin/api/keys/${encodeURIComponent(k.id)}/rotate`, { method: 'POST' });
        toast(`已轮换「${k.name}」`, 'ok');
        await loadKeys();
      } catch (err) {
        toast('轮换失败：' + err.message, 'err');
      }
    }));

    actions.appendChild(mkBtn('删除', 'danger sm', async () => {
      if (!confirm(`确定删除密钥「${k.name}」？\n使用它的客户端将立刻收到 401。`)) return;
      try {
        await api(`/admin/api/keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
        toast(`密钥「${k.name}」已删除`, 'ok');
        await loadKeys();
        await loadConfig();
      } catch (err) {
        toast('删除失败：' + err.message, 'err');
      }
    }));

    row.appendChild(main);
    row.appendChild(actions);
    list.appendChild(row);
  }

  renderClientSetup();
}

function renderClientSetup() {
  const el = $('#client-setup');
  const c = state.config && state.config.client ? state.config.client : {};
  const baseUrl = c.baseUrl || `http://${window.location.host}`;
  const primary = state.keys.find((k) => k.primary);
  const primaryKey = primary ? primary.key : c.primaryKey || '';

  el.innerHTML = `
    <div class="setup-item">
      <div class="setup-label">反代 Base URL（填进 Claude Code / Cursor，不要带 /v1）</div>
      <div class="setup-value">
        <code>${escapeHtml(baseUrl)}</code>
        <span class="copy-slot"></span>
      </div>
    </div>
    <div class="setup-item">
      <div class="setup-label">API Key（客户端使用的入站主密钥）</div>
      <div class="setup-value">
        <code>${escapeHtml(primaryKey ? primaryKey.slice(0, 16) + '…' : '—')}</code>
        <span class="copy-slot"></span>
      </div>
    </div>`;

  const slots = el.querySelectorAll('.copy-slot');
  if (slots[0]) slots[0].appendChild(makeCopyBtn(() => baseUrl, '复制地址'));
  if (slots[1]) slots[1].appendChild(makeCopyBtn(() => primaryKey, '复制密钥'));

  // 同时更新 Tab 4 的代码片段
  renderSnippets(baseUrl, primaryKey);
}

function renderSnippets(baseUrl, apiKey) {
  const claudeSnippet =
`export ANTHROPIC_BASE_URL="${baseUrl}"
export ANTHROPIC_API_KEY="${apiKey}"
export CLAUDE_CODE_USE_BEDROCK="false"`;
  $('#snippet-claude').textContent = claudeSnippet;

  const cursorSnippet =
`Base URL: ${baseUrl}/v1
API Key:  ${apiKey}
Model:    MiniMax-M3 (或 MiniMax-M3.1-Flash-Preview)`;
  $('#snippet-cursor').textContent = cursorSnippet;
}

$('#btn-new-key').addEventListener('click', () => {
  openModal(
    '生成新客户端密钥',
    `<label class="field">密钥名称
       <input id="key-name" type="text" placeholder="例如 我的 Cursor / 办公笔记本" autocomplete="off">
     </label>
     <label class="field">用途备注（可选）
       <input id="key-purpose" type="text" placeholder="例如 专用模型请求 / 测试用途" autocomplete="off">
     </label>
     <p class="muted small">每把密钥具备独立 ID，可随时单独轮换或吊销，互不影响。</p>`,
    `<button class="ghost" data-close>取消</button><button class="primary" id="do-new-key">立即生成</button>`,
  );
  $('#do-new-key').addEventListener('click', async () => {
    const name = $('#key-name').value.trim();
    const purpose = $('#key-purpose').value.trim();
    if (!name) {
      toast('请填写密钥名称', 'err');
      return;
    }
    try {
      const r = await api('/admin/api/keys', { method: 'POST', body: { name, purpose } });
      closeModal();
      await loadKeys();
      await loadConfig();
      openModal(
        '新密钥已就绪',
        `<p class="muted">请复制生成的密钥并填入客户端：</p>
         <div class="usercode" style="font-size:14px;word-break:break-all;letter-spacing:0">${escapeHtml(r.key.key)}</div>
         <p class="small muted">名称：${escapeHtml(r.key.name)} · ID：${escapeHtml(r.key.id)}</p>`,
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

/* ───────────────────────── Tab 2: 反代服务详细管理 ───────────────────────── */

async function loadConfig() {
  try {
    state.config = await api('/admin/api/config');
    const upstreamLabel = $('#upstream-label');
    if (upstreamLabel) upstreamLabel.textContent = state.config.proxy ? state.config.proxy.upstream : '';
    const badge = $('#proxy-badge');
    if (badge) {
      badge.textContent = `反代 :${state.config.proxy ? state.config.proxy.port : '—'}`;
      badge.className = 'badge ok';
    }
    renderProxyDetails();
    renderClientSetup();
    renderSystemInfo();
  } catch {
    // 忽略
  }
}

async function loadProxyDetails() {
  await loadConfig();
}

function renderProxyDetails() {
  const c = state.config;
  if (!c) return;
  const p = c.proxy || {};
  const modeText = c.mode === 'balanced' ? '平衡模式（额度耗尽可无缝滑动）' : '最大缓存模式（会话不迁移）';
  $('#proxy-detail-kv').innerHTML = `
    <dt>公开监听 Base URL</dt><dd><code>${escapeHtml(p.baseUrl || '—')}</code></dd>
    <dt>外部服务端口</dt><dd><b>${escapeHtml(p.port || '—')}</b></dd>
    <dt>上游端点与描述</dt><dd>${escapeHtml(p.upstream || '—')}</dd>
    <dt>调度模式</dt><dd><b>${escapeHtml(modeText)}</b></dd>
    <dt>最小可用积分</dt><dd><b>${escapeHtml(String(c.creditsThreshold ?? '—'))}</b>（低于此值冻结账号）</dd>
    <dt>优先级分层</dt><dd>${renderTiers(c.tiers)}</dd>
    <dt>入站鉴权模式</dt><dd>多密钥注册表隔离，支持单独吊销</dd>
    <dt>内部安全环回</dt><dd>127.0.0.1 随机密钥桥接，零协议损耗</dd>`;
}

/** 把优先级分层数组拼成「P0: a1、a2 ｜ P1: b1」这样的一行。 */
function renderTiers(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) return '<span class="muted">暂无可用账号分层</span>';
  const prioOf = new Map(state.accounts.map((a) => [a.name, a.priority ?? 0]));
  const parts = tiers.map((tier, i) => {
    const list = Array.isArray(tier) ? tier : [];
    const names = list.map((n) => escapeHtml(n)).join('、');
    /* 优先用账号真实优先级，回退到分层序号。 */
    const first = list.find((n) => prioOf.has(n));
    const level = first != null ? prioOf.get(first) : i;
    return `<span class="tag info">P${escapeHtml(String(level))}</span> ${names || '<span class="muted">—</span>'}`;
  });
  return parts.join(' <span class="muted">｜</span> ');
}

function renderCooldownTable() {
  const tbody = $('#cooldown-table-body');
  const summaryEl = $('#cooldown-summary');
  const now = Date.now();
  const coolingAccounts = state.accounts.filter((a) => a.cooling || (a.disabledUntil && a.disabledUntil > now));

  if (coolingAccounts.length === 0) {
    summaryEl.textContent = '当前账号池健康，无账号处于冷却限制状态。';
    tbody.innerHTML = '<tr><td colspan="6" class="muted">当前无任何冷却账号</td></tr>';
    return;
  }

  summaryEl.textContent = `共有 ${coolingAccounts.length} 个账号处于故障冷却保护中：`;
  tbody.innerHTML = '';
  for (const a of coolingAccounts) {
    const tr = document.createElement('tr');
    const leftMs = Math.max(0, (a.disabledUntil || 0) - now);
    const leftSec = Math.round(leftMs / 1000);
    const countdownStr = leftSec > 60 ? `${Math.round(leftSec / 60)} 分钟` : `${leftSec} 秒`;

    tr.innerHTML = `
      <td><b>${escapeHtml(a.name)}</b></td>
      <td><span class="tag warn">${escapeHtml(a.health)}</span></td>
      <td class="small muted">${fmtTime(a.disabledUntil)}</td>
      <td><b style="color:var(--warn)">${countdownStr}</b></td>
      <td class="small">${escapeHtml(a.healthDetail || '请求异常导致冷却')}</td>
      <td></td>`;

    const tdAction = tr.querySelector('td:last-child');
    tdAction.appendChild(mkBtn('立即解除冷却', 'ghost sm', async (btn) => {
      btn.disabled = true;
      try {
        await api('/admin/api/proxy/reset-cooldown', { method: 'POST', body: { name: a.name } });
        toast(`已解除账号 ${a.name} 冷却`, 'ok');
        await loadAccounts();
      } catch (err) {
        toast('解除冷却失败：' + err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    }));
    tbody.appendChild(tr);
  }
}

$('#btn-clear-cooldowns').addEventListener('click', async () => {
  try {
    await api('/admin/api/proxy/reset-cooldown', { method: 'POST', body: {} });
    toast('已解除所有账号的冷却限制', 'ok');
    await loadAccounts();
  } catch (err) {
    toast('操作失败：' + err.message, 'err');
  }
});

$('#btn-ping-upstream').addEventListener('click', async (btn) => {
  btn.disabled = true;
  btn.textContent = 'Ping 测试中…';
  const start = Date.now();
  try {
    const res = await api('/admin/api/proxy/models');
    const latency = Date.now() - start;
    toast(`上游连通正常！端到端延迟: ${latency} ms（获取到 ${res.models?.length ?? 0} 个模型）`, 'ok');
  } catch (err) {
    toast('上游连接测试失败：' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Ping 测试上游';
  }
});

async function loadModels() {
  try {
    const res = await api('/admin/api/proxy/models');
    state.models = res.models || [];
    renderModels();
  } catch {
    // 忽略
  }
}

function renderModels() {
  const container = $('#proxy-models-list');
  const select = $('#test-model-select');
  container.innerHTML = '';
  select.innerHTML = '';

  for (const m of state.models) {
    const tag = document.createElement('span');
    tag.className = 'tag ok';
    tag.textContent = m.displayName || m.id;
    container.appendChild(tag);

    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.displayName || m.id;
    select.appendChild(opt);
  }
}

$('#btn-reload-models').addEventListener('click', async () => {
  await loadModels();
  toast('模型清单已从上游同步刷新', 'ok');
});

// 在线快速测试
$('#btn-send-test').addEventListener('click', async (btn) => {
  const model = $('#test-model-select').value;
  const prompt = $('#test-prompt-input').value.trim() || '你好，请做个自我介绍';
  btn.disabled = true;
  btn.textContent = '请求发送中…';
  $('#test-result-box').classList.add('hidden');

  try {
    const r = await api('/admin/api/proxy/test', {
      method: 'POST',
      body: { model, prompt },
    });
    $('#test-result-box').classList.remove('hidden');
    if (r.ok) {
      $('#test-result-status').innerHTML =
        `<span style="color:var(--ok)">✓ 请求成功</span> · 耗时 <b>${r.durationMs} ms</b> · 账号: <b>${escapeHtml(r.account || '默认')}</b>`;
      $('#test-result-output').textContent = r.response || '（无响应正文）';
    } else {
      $('#test-result-status').innerHTML =
        `<span style="color:var(--err)">✕ 请求失败</span> · 耗时 <b>${r.durationMs} ms</b>`;
      $('#test-result-output').textContent = r.error || '未知错误';
    }
  } catch (err) {
    toast('测试出错：' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '发送测试请求';
  }
});

/* ───────────────────────── Tab 3: 请求详情显示与监控 ───────────────────────── */

async function loadRequestStats() {
  try {
    const stats = await api('/admin/api/requests-stats');
    state.requestStats = stats;
    $('#stat-total-logged').textContent = stats.totalLogged || 0;
    $('#stat-cached-count').textContent = stats.cachedCount || 0;

    const total = stats.cachedCount || 0;
    const rate = total > 0 ? Math.round((stats.successCount / total) * 100) : 100;
    $('#stat-success-rate').textContent = `${rate}%`;
    $('#stat-success-count').textContent = stats.successCount || 0;
    $('#stat-error-count').textContent = stats.errorCount || 0;

    $('#stat-avg-duration').textContent = `${stats.avgDurationMs || 0} ms`;

    const tokens = stats.totalTokens || { prompt: 0, completion: 0, total: 0 };
    $('#stat-total-tokens').textContent = tokens.total || 0;
    $('#stat-prompt-tokens').textContent = tokens.prompt || 0;
    $('#stat-completion-tokens').textContent = tokens.completion || 0;

    $('#cache-memory-estimate').textContent = formatBytes(stats.estimatedMemoryBytes || 0);
    $('#cache-oldest-time').textContent = stats.oldestTimestamp ? fmtTime(stats.oldestTimestamp) : '—';

    // 缓存配置选择框同步
    if (stats.config) {
      $('#cache-max-items').value = String(stats.config.maxItems || 200);
      $('#cache-retention-time').value = String(stats.config.retentionMs ?? 86400000);
    }
  } catch {
    // 忽略
  }
}

async function loadRequests() {
  try {
    const status = $('#req-filter-status').value;
    const search = $('#req-search-input').value.trim();
    const params = new URLSearchParams();
    if (status && status !== 'all') params.set('status', status);
    if (search) params.set('search', search);
    params.set('limit', '100');

    const res = await api(`/admin/api/requests?${params.toString()}`);
    state.requests = res.items || [];
    renderRequestsTable();
  } catch {
    // 忽略
  }
}

function renderRequestsTable() {
  const tbody = $('#requests-table-body');
  if (!state.requests || state.requests.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="muted">暂无请求记录</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  for (const item of state.requests) {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';

    const isOk = item.status >= 200 && item.status < 300;
    const badgeCls = isOk ? 'ok' : item.status === 401 || item.status === 429 ? 'warn' : 'err';
    const statusBadge = `<span class="badge ${badgeCls}">${item.status}</span>`;

    const usage = item.output && item.output.usage;
    const listHitRate = usage
      ? typeof usage.cache_hit_rate === 'number'
        ? usage.cache_hit_rate
        : usage.prompt_tokens
          ? (usage.cached_tokens ?? 0) / usage.prompt_tokens
          : 0
      : 0;
    /* token 统计用 k 缩写（请求列表要能一眼扫过去）；精确值放 title。 */
    const tokensStr = usage
      ? `${fmtK(usage.prompt_tokens ?? 0)} / ${fmtK(usage.completion_tokens ?? 0)}`
      : '—';
    const tokensTitle = usage
      ? `输入 ${fmtInt(usage.prompt_tokens ?? 0)} / 输出 ${fmtInt(usage.completion_tokens ?? 0)}`
      : '';
    /* 单次请求的缓存命中率（上游没报缓存字段时是 0%，不是猜的值）。 */
    const hitRateStr = usage ? `${(listHitRate * 100).toFixed(0)}%` : '—';
    const hitRateTitle = usage
      ? `缓存命中 ${fmtInt(usage.cached_tokens ?? 0)} / 输入 ${fmtInt(usage.prompt_tokens ?? 0)}`
      : '';

    tr.innerHTML = `
      <td class="small muted">${fmtTimeShort(item.timestamp)}</td>
      <td>${statusBadge}</td>
      <td><b>${item.durationMs}ms</b></td>
      <td class="small"><code>${escapeHtml(item.method)} ${escapeHtml(item.path)}</code></td>
      <td><span class="tag">${escapeHtml(item.model || '—')}</span></td>
      <td><b>${escapeHtml(item.account || '—')}</b></td>
      <td class="small">${escapeHtml(item.keyName || '默认')}</td>
      <td class="small" title="${escapeHtml(tokensTitle)}"><b>${tokensStr}</b></td>
      <td class="small" title="${escapeHtml(hitRateTitle)}"><b>${hitRateStr}</b></td>
      <td></td>`;

    const tdAction = tr.querySelector('td:last-child');
    tdAction.appendChild(mkBtn('查看详情', 'primary sm', (btn) => {
      openRequestModal(item);
    }));

    tr.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') {
        openRequestModal(item);
      }
    });

    tbody.appendChild(tr);
  }
}

// 筛选监听
$('#req-filter-status').addEventListener('change', () => loadRequests());
$('#req-search-input').addEventListener('input', () => {
  clearTimeout($('#req-search-input')._t);
  $('#req-search-input')._t = setTimeout(() => loadRequests(), 300);
});

// 自动轮询控制
function startRequestsAutoRefresh() {
  stopRequestsAutoRefresh();
  if (!state.autoRefreshRequests) return;
  $('#live-dot').classList.remove('paused');
  state.requestsPollTimer = setInterval(() => {
    if (state.activeTab === 'tab-requests') {
      loadRequests();
      loadRequestStats();
    }
  }, state.refreshIntervalMs);
}

function stopRequestsAutoRefresh() {
  if (state.requestsPollTimer) {
    clearInterval(state.requestsPollTimer);
    state.requestsPollTimer = null;
  }
  $('#live-dot').classList.add('paused');
}

$('#auto-refresh-toggle').addEventListener('change', (e) => {
  state.autoRefreshRequests = e.target.checked;
  if (state.autoRefreshRequests) startRequestsAutoRefresh();
  else stopRequestsAutoRefresh();
});

$('#auto-refresh-interval').addEventListener('change', (e) => {
  state.refreshIntervalMs = Number(e.target.value) || 2000;
  if (state.autoRefreshRequests) startRequestsAutoRefresh();
});

$('#btn-refresh-requests').addEventListener('click', async () => {
  await Promise.all([loadRequests(), loadRequestStats()]);
  toast('请求日志已刷新', 'ok');
});

// 缓存管理操作
$('#btn-save-cache-config').addEventListener('click', async () => {
  const maxItems = Number($('#cache-max-items').value);
  const retentionMs = Number($('#cache-retention-time').value);
  try {
    const res = await api('/admin/api/requests-config', {
      method: 'POST',
      body: { maxItems, retentionMs },
    });
    toast('缓存存储规则已更新并生效', 'ok');
    await loadRequestStats();
    await loadRequests();
  } catch (err) {
    toast('更新缓存配置失败：' + err.message, 'err');
  }
});

$('#btn-clear-requests').addEventListener('click', async () => {
  if (!confirm('确定清空所有已缓存的请求记录？清空后无法恢复。')) return;
  try {
    await api('/admin/api/requests', { method: 'DELETE' });
    toast('已清空所有请求记录缓存', 'ok');
    await loadRequests();
    await loadRequestStats();
  } catch (err) {
    toast('清空失败：' + err.message, 'err');
  }
});

$('#btn-export-requests').addEventListener('click', async () => {
  try {
    const res = await api('/admin/api/requests?limit=2000');
    const jsonStr = JSON.stringify(res.items || [], null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mmcode_requests_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('请求记录已导出下载', 'ok');
  } catch (err) {
    toast('导出失败：' + err.message, 'err');
  }
});

/* ───────────────────────── Tab 4: 设置选项 ───────────────────────── */

$('#admin-key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const k1 = $('#new-admin-key').value.trim();
  const k2 = $('#new-admin-key-confirm').value.trim();
  if (!k1) {
    toast('请输入新管理密钥', 'err');
    return;
  }
  if (k1 !== k2) {
    toast('两次输入的管理密钥不一致', 'err');
    return;
  }
  if (k1.length < 6) {
    toast('管理密钥长度至少需 6 位', 'err');
    return;
  }
  try {
    await api('/admin/api/admin-key', { method: 'POST', body: { newKey: k1 } });
    toast('管理密钥已更新，请使用新密钥重新登录', 'ok');
    setTimeout(() => {
      showLogin();
    }, 1200);
  } catch (err) {
    toast('更新密钥失败：' + err.message, 'err');
  }
});

$('#scheduler-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const checkinEnabled = $('#setting-checkin-enabled').checked;
  const checkinTime = $('#setting-checkin-time').value.trim() || '08:00';
  const refreshEnabled = $('#setting-refresh-enabled').checked;
  const refreshInterval = Number($('#setting-refresh-interval').value) || 15;
  const refreshMargin = Number($('#setting-refresh-margin').value) || 30;

  try {
    await api('/admin/api/scheduler/config', {
      method: 'POST',
      body: {
        autoCheckin: { enabled: checkinEnabled, time: checkinTime },
        autoRefresh: { enabled: refreshEnabled, intervalMinutes: refreshInterval, marginMinutes: refreshMargin },
      },
    });
    toast('自动任务调度计划已保存', 'ok');
    await loadScheduler();
  } catch (err) {
    toast('保存调度计划失败：' + err.message, 'err');
  }
});

function renderSystemInfo() {
  const c = state.config || {};
  const kv = $('#system-info-kv');
  kv.innerHTML = `
    <dt>项目版本</dt><dd><b>v${escapeHtml(c.version || '0.5.2')}</b></dd>
    <dt>管理密钥文件</dt><dd><code>${escapeHtml(c.adminKeyPath || '—')}</code></dd>
    <dt>反代入站密钥</dt><dd><code>${escapeHtml(c.apiKeyMasked || '—')}</code></dd>
    <dt>账号池状态</dt><dd>已注册 ${c.accounts || 0} 个账号，可用 ${c.available || 0} 个</dd>`;
}

$('#modal-close').addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal();
    closeRequestModal();
  }
});

/* ───────────────────────── Tab 5: 用量洞察 ───────────────────────── */

/** 千分位整数。 */
function fmtInt(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

/**
 * token 数量的 k 缩写：1234 → 1.2k，12345 → 12k，999 → 999。
 *
 * 请求列表用它 —— 一眼能扫过去；精确值放在 title 里。
 */
function fmtK(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '0';
  if (v < 1000) return String(Math.round(v));
  const k = v / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
}

/** Token 易读格式：超过 1 万显示「万」，超过 1 亿显示「亿」，title 里放精确值。 */
function fmtTokens(n) {
  const v = Number(n || 0);
  if (v >= 100000000) return `${(v / 100000000).toFixed(2)} 亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万`;
  return fmtInt(v);
}

/** 纯 CSS 横条（渐变背景，不引第三方库）。 */
function barHtml(ratio, cls) {
  const pct = Math.max(0, Math.min(100, Number(ratio) || 0));
  return `<span class="mini-bar${cls ? ' ' + cls : ''}"><i style="width:${pct.toFixed(2)}%"></i></span>`;
}

async function loadInsights() {
  try {
    const data = await api('/admin/api/insights');
    state.insights = data.accounts || [];
    state.insightsTotals = data.totals || null;
    state.insightsMode = data.mode || 'max-cache';
    renderInsights();
  } catch (err) {
    toast('加载用量洞察失败：' + err.message, 'err');
  }
}

function renderInsights() {
  const list = state.insights || [];
  const totals = state.insightsTotals || {
    accounts: 0,
    requests: 0,
    sessions: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
  };

  // 概览数字
  const modeBadge = $('#insight-mode-badge');
  modeBadge.textContent = state.insightsMode === 'balanced' ? '平衡模式' : '最大缓存模式';
  modeBadge.className = 'badge ' + (state.insightsMode === 'balanced' ? 'info' : 'ok');

  $('#insight-stat-requests').textContent = fmtInt(totals.requests);
  $('#insight-stat-sessions').textContent = fmtInt(totals.sessions);
  $('#insight-stat-accounts').textContent = fmtInt(totals.accounts);

  const totalTokens = totals.totalTokens || 0;
  const promptTokens = totals.promptTokens || 0;
  const completionTokens = totals.completionTokens || 0;
  const cachedTokens = totals.cachedTokens || 0;
  /* 缓存命中率 = 缓存命中 token / 输入 token（后端给了就用后端的，自己兜底算）。 */
  const totalHitRate =
    typeof totals.cacheHitRate === 'number'
      ? totals.cacheHitRate
      : promptTokens
        ? cachedTokens / promptTokens
        : 0;

  $('#insight-stat-total-tokens').textContent = fmtTokens(totalTokens);
  $('#insight-stat-total-tokens').title = fmtInt(totalTokens);
  $('#insight-stat-total-tokens-exact').textContent = fmtInt(totalTokens);

  $('#insight-stat-prompt-tokens').textContent = fmtTokens(promptTokens);
  $('#insight-stat-prompt-tokens').title = fmtInt(promptTokens);
  $('#insight-stat-prompt-tokens-exact').textContent = fmtInt(promptTokens);

  $('#insight-stat-completion-tokens').textContent = fmtTokens(completionTokens);
  $('#insight-stat-completion-tokens').title = fmtInt(completionTokens);
  $('#insight-stat-completion-tokens-exact').textContent = fmtInt(completionTokens);

  $('#insight-stat-cached-tokens').textContent = fmtTokens(cachedTokens);
  $('#insight-stat-cached-tokens').title = fmtInt(cachedTokens);
  $('#insight-stat-cached-tokens-exact').textContent = fmtInt(cachedTokens);

  $('#insight-stat-cache-hit-rate').textContent = `${(totalHitRate * 100).toFixed(1)}%`;
  $('#insight-stat-cache-hit-rate').title = `缓存命中 ${fmtInt(cachedTokens)} / 输入 ${fmtInt(promptTokens)}`;
  $('#insight-stat-cache-hit-cached').textContent = fmtInt(cachedTokens);
  $('#insight-stat-cache-hit-input').textContent = fmtInt(promptTokens);

  // 表格
  const tbody = $('#insights-table-body');
  tbody.innerHTML = '';
  $('#insights-empty').classList.toggle('hidden', list.length > 0);
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="muted">暂无用量记录</td></tr>';
    return;
  }

  for (const acc of list) {
    const accTotal = acc.totalTokens || 0;
    const share = totalTokens > 0 ? (accTotal / totalTokens) * 100 : 0;
    /* 单账号的缓存命中率。 */
    const accHitRate =
      typeof acc.cacheHitRate === 'number'
        ? acc.cacheHitRate
        : acc.promptTokens
          ? (acc.cachedTokens || 0) / acc.promptTokens
          : 0;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${escapeHtml(acc.name)}</b></td>
      <td>${fmtInt(acc.requests)}</td>
      <td>${fmtInt(acc.sessions)}</td>
      <td title="${fmtInt(acc.promptTokens)}">${fmtTokens(acc.promptTokens)}</td>
      <td title="${fmtInt(acc.completionTokens)}">${fmtTokens(acc.completionTokens)}</td>
      <td title="${fmtInt(acc.cachedTokens)}">${fmtTokens(acc.cachedTokens)}</td>
      <td title="缓存命中 ${fmtInt(acc.cachedTokens)} / 输入 ${fmtInt(acc.promptTokens)}"><b>${(accHitRate * 100).toFixed(1)}%</b></td>
      <td>
        <div class="share-cell">
          <span title="${fmtInt(accTotal)}">${fmtTokens(accTotal)}</span>
          <span class="small muted">${share.toFixed(1)}%</span>
          ${barHtml(share)}
        </div>
      </td>
      <td class="small muted">${acc.lastUsedAt ? fmtTime(acc.lastUsedAt) : '—'}</td>
      <td></td>`;

    const tdAction = tr.querySelector('td:last-child');
    tdAction.appendChild(mkBtn('清除该账号', 'ghost sm', async (btn) => {
      btn.disabled = true;
      try {
        await api('/admin/api/insights/reset', { method: 'POST', body: { name: acc.name } });
        toast(`已清除账号 ${acc.name} 的用量统计`, 'ok');
        await loadInsights();
      } catch (err) {
        toast('清除失败：' + err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    }));
    tbody.appendChild(tr);

    // 每行下面展开「按模型」「按天」小节
    tbody.appendChild(renderInsightDetailRow(acc));
  }
}

/** 账号明细下方的展开行：按模型 + 按天。 */
function renderInsightDetailRow(acc) {
  const tr = document.createElement('tr');
  tr.className = 'insight-detail-row';
  const td = document.createElement('td');
  td.colSpan = 10;

  /* 按模型 */
  const models = Object.entries(acc.byModel || {}).sort((a, b) => b[1].totalTokens - a[1].totalTokens);
  const modelMax = models.length > 0 ? models[0][1].totalTokens : 0;
  const modelHtml = models.length === 0
    ? '<p class="muted small" style="margin:0;">暂无模型维度数据</p>'
    : `<table class="sub-table">
        <thead><tr><th>模型</th><th>请求数</th><th>总 Token</th><th>占比</th></tr></thead>
        <tbody>${models.map(([name, m]) => `
          <tr>
            <td><code>${escapeHtml(name)}</code></td>
            <td>${fmtInt(m.requests)}</td>
            <td title="${fmtInt(m.totalTokens)}">${fmtTokens(m.totalTokens)}</td>
            <td class="bar-cell">${barHtml(modelMax > 0 ? (m.totalTokens / modelMax) * 100 : 0)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;

  /* 按天：只显示最近 14 天 */
  const days = Object.entries(acc.byDay || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-14);
  const dayMax = days.length > 0 ? days.reduce((m, d) => Math.max(m, d[1].totalTokens || 0), 0) : 0;
  const dayHtml = days.length === 0
    ? '<p class="muted small" style="margin:0;">暂无按天数据</p>'
    : `<table class="sub-table">
        <thead><tr><th>日期</th><th>请求数</th><th>总 Token</th><th>占比</th></tr></thead>
        <tbody>${days.map(([day, d]) => `
          <tr>
            <td>${escapeHtml(day)}</td>
            <td>${fmtInt(d.requests)}</td>
            <td title="${fmtInt(d.totalTokens)}">${fmtTokens(d.totalTokens)}</td>
            <td class="bar-cell">${barHtml(dayMax > 0 ? (d.totalTokens / dayMax) * 100 : 0, 'ok')}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;

  td.innerHTML = `
    <div class="insight-detail">
      <div class="insight-detail-col">
        <h4>按模型</h4>
        ${modelHtml}
      </div>
      <div class="insight-detail-col">
        <h4>按天（最近 14 天）</h4>
        ${dayHtml}
      </div>
    </div>`;
  tr.appendChild(td);
  return tr;
}

$('#btn-insights-refresh').addEventListener('click', async () => {
  await loadInsights();
  toast('用量洞察已刷新', 'ok');
});

$('#btn-insights-reset-all').addEventListener('click', async () => {
  if (!confirm('确定清空所有账号的用量统计？该操作不可恢复。')) return;
  try {
    await api('/admin/api/insights/reset', { method: 'POST', body: {} });
    toast('已清空全部用量统计', 'ok');
    await loadInsights();
  } catch (err) {
    toast('清空失败：' + err.message, 'err');
  }
});

/* 启动系统 */
boot();
