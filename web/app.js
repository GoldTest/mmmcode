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
  /** 签到列表是否只显示「有问题的账号」（昨天没签上 / 最近一次报错）。 */
  checkinOnlyIssues: false,
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

/**
 * 底部提示条。
 *
 * undo 传入（{ label, run }）时会在提示条里挂一个「撤销」按钮 ——
 * 破坏性操作（清空请求缓存 / 清空统计）之后必须给一条退路，
 * 而不是只弹一句「已清空」就完了。
 */
function toast(message, kind = '', undo = null) {
  const el = $('#toast');
  el.textContent = '';
  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);
  el.className = 'toast ' + kind;
  if (undo) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = undo.label;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await undo.run();
      } catch (err) {
        toast('撤销失败：' + err.message, 'err');
      } finally {
        el.classList.add('hidden');
      }
    });
    el.appendChild(btn);
  }
  clearTimeout(el._t);
  /* 带撤销的提示多留一会儿 —— 用户得有时间读完再决定。 */
  el._t = setTimeout(() => el.classList.add('hidden'), undo ? 12000 : 3200);
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
      btn.textContent = '已复制';
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

/**
 * 破坏性操作的二次确认框。
 *
 * 为什么不用浏览器的原生 confirm()：原生弹窗不在页面的视觉体系里，
 * 文字没法强调「会发生什么」，用户只能盲点「确定」。
 * 这里把「要做什么 / 会影响多少数据」讲清楚，再把危险按钮放在右边。
 */
function confirmAction({ title, message, confirmText = '确认', danger = true, onConfirm }) {
  openModal(
    title,
    `<p class="confirm-title">${escapeHtml(title)}</p>
     <p class="confirm-text">${escapeHtml(message)}</p>`,
    `<button class="ghost" data-close>取消</button>
     <button class="${danger ? 'danger' : 'primary'}" id="btn-confirm-action">${escapeHtml(confirmText)}</button>`,
  );
  const btn = $('#btn-confirm-action');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    closeModal();
    try {
      await onConfirm();
    } catch (err) {
      toast('操作失败：' + err.message, 'err');
    }
  });
}

function openRequestModal(record) {
  state.currentRequestDetail = record;
  $('#req-modal-title').textContent = `请求详情 · ${record.id}`;

  const isSuccess = record.status >= 200 && record.status < 300;
  const statusBadge = `<span class="badge ${isSuccess ? 'ok' : 'err'}">${record.status}</span>`;

  // 格式化输入信息
  let inputHtml = '';
  if (record.input && record.input.messages && Array.isArray(record.input.messages)) {
    inputHtml = '<div class="block-title">对话上下文（Messages）：</div>';
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
      <div class="block-title spaced">工具调用（Tool Calls）：</div>
      <pre class="code-block">${escapeHtml(JSON.stringify(record.output.toolCalls, null, 2))}</pre>`;
  }
  if (record.error) {
    outputHtml += `
      <div class="msg-bubble system is-error">
        <div class="msg-role is-error">错误信息</div>
        <div class="msg-text is-error">${escapeHtml(record.error)}</div>
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
     入站与出站均为原生 Anthropic 协议，把实际发给上游的请求展示出来便于排查。 */
  const transit = record.transit;
  const transitHtml = transit
    ? `
      <dl class="req-kv">
        <dt>上游地址</dt><dd>${escapeHtml(transit.upstream)}</dd>
        <dt>服务账号</dt><dd>${escapeHtml(transit.account || '—')}</dd>
        <dt>出站协议</dt><dd>${escapeHtml(transit.protocol || '—')}</dd>
      </dl>
      <details open>
        <summary class="details-summary">实际发给上游的请求</summary>
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
    <div class="card-metrics req-metrics">
      <div>请求状态 <b>${statusBadge}</b></div>
      <div>请求来源 <b>${requestSourceTag(record.source)}</b></div>
      <div>首字符时间 <b>${firstByteStr}</b></div>
      <div>响应耗时 <b>${record.durationMs} ms</b></div>
      <div>请求端点 <b>${escapeHtml(record.method)} ${escapeHtml(record.path)}</b></div>
      <div>请求模型 <b>${escapeHtml(record.model || '默认')}</b></div>
      <div>调用账号 <b>${escapeHtml(record.account || '自动')}</b></div>
      <div>客户端密钥 <b>${escapeHtml(record.keyName || '默认')} (${escapeHtml(record.keyMasked || '—')})</b></div>
      <div>来源 IP <b>${escapeHtml(record.clientIp || '—')}</b></div>
      <div>流式模式 <b>${record.stream ? 'SSE 流式' : '单次返回'}</b></div>
      <div class="span-2">Token 用量 ${usageStr}</div>
      <div>缓存命中率 <b>${(hitRate * 100).toFixed(1)}%</b></div>
      <div class="span-2">请求时间 <b>${fmtTime(record.timestamp)}</b></div>
    </div>

    <!-- 横向三栏：请求 / 中转 / 输出 -->
    <div class="req-cols">
      <section class="req-col">
        <h4>请求</h4>
        <div class="req-col-body">
          ${inputHtml}
          <details>
            <summary class="details-summary">查看完整入站 JSON</summary>
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
            <summary class="details-summary">查看完整输出 JSON</summary>
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

/**
 * 页面级的服务状态（原来在顶栏，顶栏删了以后不再单独显示）。
 *
 * 为什么不再显示：账号是否可调度，在「账号」页的卡片（分配概率 / 健康状态）
 * 与「反代」Tab 的拓扑里都有完整的一份；顶栏那条 56px 的横条只为重复一遍。
 */

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

/* 退出登录 —— 入口在「设置 → 系统运行环境信息」底部（顶栏已删）。 */
$('#btn-bottom-logout').addEventListener('click', async () => {
  await api('/admin/api/session', { method: 'DELETE' }).catch(() => {});
  showLogin();
});

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

/* ───────────────────────── 代码片段复制 ─────────────────────────
   代码块是横向可滚的，窄屏里根本看不全 —— 必须给一个「一键复制」，
   否则用户只能横向拖着一行行地看。 */
$$('[data-copy-target]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = document.getElementById(btn.dataset.copyTarget);
    const text = target ? target.textContent : '';
    if (!text.trim()) {
      toast('没有可复制的内容', 'err');
      return;
    }
    const ok = await copyText(text);
    if (ok) {
      btn.textContent = '已复制';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = '复制';
      }, 1400);
    } else {
      toast('复制失败 —— 请手动选中复制', 'err');
    }
  });
});

/* 空状态里的「刷新」—— 让用户知道「刷新一下也许就有了」。 */
$('#btn-empty-insights-refresh').addEventListener('click', async () => {
  await loadInsights();
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
    renderCheckinOverview();
    renderCheckinTable();
    renderTokensTable();
    renderCooldownTable();
    checkExpiringCreditsPrompt();
  } catch (err) {
    toast('加载账号列表失败：' + err.message, 'err');
  }
}

/**
 * 检查是否有 3 天内临近到期的积分，并在用户进入时弹窗提醒开启「蹬额度模式」。
 */
function checkExpiringCreditsPrompt() {
  // 如果当前已经是蹬额度模式，无需再次提示
  if (state.mode === 'burn') return;
  // 会话内只提醒一次，避免频繁刷新时重复打扰
  if (sessionStorage.getItem('dismiss_burn_prompt')) return;

  const now = Date.now();
  const threeDaysMs = 3 * 24 * 3600 * 1000;
  const expiringAccounts = [];

  for (const a of state.accounts || []) {
    const exp = a.lastCredits?.nextExpireAt;
    const rem = a.lastCredits?.remaining;
    if (typeof exp === 'number' && exp > now && exp - now <= threeDaysMs && typeof rem === 'number' && rem > 0) {
      expiringAccounts.push({
        name: a.name,
        remaining: rem,
        nextExpireAt: exp,
      });
    }
  }

  if (expiringAccounts.length === 0) return;

  // 记录提示已弹出
  sessionStorage.setItem('dismiss_burn_prompt', '1');

  const rows = expiringAccounts.map((a) => `
    <tr>
      <td><b>${escapeHtml(a.name)}</b></td>
      <td><b>${a.remaining}</b></td>
      <td class="warn"><b>${fmtTime(a.nextExpireAt)}</b></td>
    </tr>
  `).join('');

  const bodyHtml = `
    <div>
      <p class="block-title">检测到以下账号存在 <b>3 天内即将到期</b> 的积分额度：</p>
      <div class="table-wrap scroll-box short">
        <table>
          <thead>
            <tr>
              <th>账号名</th>
              <th>剩余积分</th>
              <th>失效时间</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="small muted no-margin">
        开启<b>「蹬额度模式」</b>后，新会话将 100% 优先分配给这些临期账号加快消耗；即使额度耗尽也会保持在该模式下，持续按到期先后优先调度。
      </p>
    </div>`;

  const footHtml = `
    <button class="ghost" data-close>暂不开启</button>
    <button id="btn-confirm-enable-burn" class="primary">立即开启蹬额度模式</button>`;

  openModal('临期积分提醒', bodyHtml, footHtml);

  $('#btn-confirm-enable-burn')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api('/admin/api/config', { method: 'POST', body: { mode: 'burn' } });
      toast('已开启蹬额度模式！新会话将优先消耗临期账号', 'ok');
      closeModal();
      await loadAccounts();
    } catch (err) {
      toast('开启失败：' + err.message, 'err');
    } finally {
      e.target.disabled = false;
    }
  });
}

/**
 * 账号当前是否参与调度。
 * 判定口径与后端 `unavailableReason` 一致：已停用 / 限流 / 未登录 / 冷却中 / 额度冻结。
 */
function isSchedulable(a) {
  return !!(a.enabled && a.loggedIn && !a.cooling && !a.frozen && !a.rateLimited);
}

/**
 * 账号卡片上的「上次签到」文案 —— 直接显示 outcome 英文（claimed/error）
 * 对用户没有意义，这里统一翻成中文并带上色彩语义。
 */
function checkinMetricText(last) {
  if (!last) return '—';
  if (last.outcome === 'claimed') return '新签得积分';
  if (last.outcome === 'already') return '已签到';
  if (last.outcome === 'unavailable') return '暂不可签';
  if (last.outcome === 'error') return '签到异常';
  return '—';
}

/** 卡片上「上次签到」的颜色语义：正常灰、签成绿、异常红。 */
function checkinMetricCls(last) {
  if (!last) return '';
  if (last.outcome === 'claimed' || last.outcome === 'already') return 'ok';
  if (last.outcome === 'error' || last.outcome === 'unavailable') return 'err';
  return '';
}

function renderAccounts() {
  const list = $('#account-list');
  list.innerHTML = '';
  /* 容器与空态**二选一**渲染：容器留着但里面是空的，页面上就会出现
     一条来历不明的空白带（看着像加载失败）。 */
  const hasAccounts = state.accounts.length > 0;
  list.classList.toggle('hidden', !hasAccounts);
  $('#accounts-empty').classList.toggle('hidden', hasAccounts);
  $('#mode-select').value = state.mode;
  $('#credits-threshold-input').value = String(state.creditsThreshold);

  // 蹬额度模式顶部横幅
  const burnBanner = $('#burn-mode-banner');
  if (burnBanner) {
    burnBanner.classList.toggle('hidden', state.mode !== 'burn');
  }

  for (const a of state.accounts) {
    /* 每张卡片套一层容器 —— 容器查询的锚点：
       卡片内部横排还是竖排，按**卡片自己的宽度**决定，而不是按视口宽度
       （三列排布下，视口很宽但每张卡片其实很窄）。 */
    const cell = document.createElement('div');
    cell.className = 'card-cell';
    cell.appendChild(renderAccountCard(a));
    list.appendChild(cell);
  }
}

function formatProbeMetric(p) {
  if (!p) return { text: '未测活', cls: '' };
  const ms = typeof p.ttftMs === 'number' ? p.ttftMs : 0;
  const sec = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  if (p.status === 'ok') return { text: `${sec} (正常)`, cls: 'ok' };
  if (p.status === 'suspected') return { text: `${sec} (疑似限流)`, cls: 'warn' };
  if (p.status === 'paused') return { text: `${sec} (超时暂停)`, cls: 'err' };
  return { text: '测活异常', cls: 'err' };
}

function formatWarmupMetric(w) {
  if (!w) return { text: '未预热', cls: '' };
  if (w.ok) return { text: `${w.durationMs}ms (0 token)`, cls: 'ok' };
  return { text: '预热失败', cls: 'err' };
}

function renderAccountCard(a) {
  const card = document.createElement('div');
  card.className =
    'card card-account' +
    (a.enabled ? '' : ' disabled') +
    (a.rateLimited ? ' rate-limited' : '');
  card.dataset.name = a.name;

  /* 令牌失效判定：健康态为 unauthorized，或令牌已过期 —— 这两种情况才需要重新授权。 */
  const tokenDead = a.health === 'unauthorized' || (a.tokenExpiresAt != null && a.tokenExpiresAt <= Date.now());

  const top = document.createElement('div');
  top.className = 'card-top';

  const titleRow = document.createElement('div');
  titleRow.className = 'card-title-row';

  const left = document.createElement('div');
  left.className = 'card-head';
  left.innerHTML = `
    <div class="card-name">${escapeHtml(a.name)}${a.isDefault ? ' <span class="muted small">（默认）</span>' : ''}</div>
    <div class="card-sub">${escapeHtml(regionTag(a.region))}${a.account ? ' · ' + escapeHtml(a.account) + '…' : ''}</div>`;
  titleRow.appendChild(left);

  // 优先级编辑（数字越小越优先，0 为最高层）
  const prioRow = document.createElement('div');
  prioRow.className = 'card-priority';
  const prioLabel = document.createElement('span');
  prioLabel.className = 'small muted';
  prioLabel.textContent = 'P';
  const prioInput = document.createElement('input');
  prioInput.type = 'number';
  prioInput.min = '0';
  prioInput.max = '99';
  prioInput.step = '1';
  prioInput.className = 'prio-input';
  prioInput.value = String(a.priority ?? 0);
  prioInput.title = '调度优先级（数字越小越优先，0 为最高层）';
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
  titleRow.appendChild(prioRow);

  top.appendChild(titleRow);

  const tagsEl = document.createElement('div');
  tagsEl.className = 'tags';
  tagsEl.id = `tags-${a.name}`;
  top.appendChild(tagsEl);
  card.appendChild(top);

  const probeM = formatProbeMetric(a.lastProbe);
  const warmupM = formatWarmupMetric(a.lastWarmup);

  /* 分配概率：此刻开新会话落在这个账号上的概率。
     口径与调度器完全一致 —— 同层内按剩余积分加权随机，备选层恒为 0。
     数值由后端算好下发（`probability`），前端不做任何二次计算。 */
  const schedulable = isSchedulable(a);
  const prob = typeof a.probability === 'number' && Number.isFinite(a.probability) ? a.probability : 0;
  const probPct = Math.max(0, Math.min(1, prob)) * 100;
  const probText = !schedulable ? '—' : probPct > 0 ? probPct.toFixed(1) + '%' : '0%';
  const probCls = schedulable && probPct > 0 ? '' : 'dim';
  const probWidth = schedulable ? probPct.toFixed(2) : '0';
  const probTitle = !schedulable
    ? '当前不可调度（未登录 / 已停用 / 冷却中 / 额度冻结 / 限流），不参与分配。'
    : probPct > 0
      ? '此刻开新会话落在这个账号的概率 = 该账号剩余积分 ÷ 同层剩余积分之和（同层按剩余积分加权随机）。已绑定的会话不受影响。'
      : `备选层 P${a.priority ?? 0}：更高优先级的层还有可用账号，暂时不会被分配（高层耗尽后才顶上）。`;

  const metrics = document.createElement('div');
  metrics.className = 'card-metrics';
  metrics.innerHTML = `
    <div class="card-metric-item">
      <span class="card-metric-label">登录态</span>
      <span class="card-metric-val ${a.loggedIn ? 'ok' : 'warn'}">${a.loggedIn ? '已登录' : '未登录'}</span>
    </div>
    <div class="card-metric-item">
      <span class="card-metric-label">令牌有效</span>
      <span class="card-metric-val">${tokenLeft(a.tokenExpiresAt)}</span>
    </div>
    <div class="card-metric-item">
      <span class="card-metric-label">剩余积分</span>
      <span class="card-metric-val">${a.lastCredits ? a.lastCredits.remaining : '—'}</span>
    </div>
    <div class="card-metric-item" title="${a.lastCheckin ? escapeHtml(a.lastCheckin.message || '') : '还没签过'}">
      <span class="card-metric-label">上次签到</span>
      <span class="card-metric-val ${checkinMetricCls(a.lastCheckin)}">${escapeHtml(checkinMetricText(a.lastCheckin))}</span>
    </div>
    <div class="card-metric-item" title="${a.lastProbe ? escapeHtml(a.lastProbe.message) : '点击测活测试生文首字延迟'}">
      <span class="card-metric-label">测活首字</span>
      <span class="card-metric-val ${probeM.cls}">${escapeHtml(probeM.text)}</span>
    </div>
    <div class="card-metric-item" title="${a.lastWarmup ? escapeHtml(a.lastWarmup.message) : '点击预热（不消耗 token）'}">
      <span class="card-metric-label">预热耗时</span>
      <span class="card-metric-val ${warmupM.cls}">${escapeHtml(warmupM.text)}</span>
    </div>
    <div class="card-metric-item prob" title="${escapeHtml(probTitle)}">
      <span class="card-metric-label">分配概率</span>
      <span class="card-metric-val ${probCls}">${probText}</span>
      <span class="prob-bar"><i style="width:${probWidth}%"></i></span>
    </div>`;
  card.appendChild(metrics);

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  /* 未登录 → 首次登录授权；令牌失效 → 重新授权。令牌正常时不显示授权按钮。 */
  if (!a.loggedIn) {
    actions.appendChild(mkBtn('登录授权', 'primary sm', () => startLogin(a.name, a.region)));
  } else if (tokenDead) {
    actions.appendChild(mkBtn('重新授权', 'primary sm', () => startLogin(a.name, a.region)));
  }

  actions.appendChild(mkBtn('测活', 'ghost sm', async (btn) => {
    btn.disabled = true;
    btn.textContent = '测活中…';
    try {
      const r = await api(`/admin/api/accounts/${encodeURIComponent(a.name)}/probe`, { method: 'POST' });
      const res = r.result || {};
      toast(res.message || '测活完成', res.ok ? 'ok' : 'err');
      await loadAccounts();
    } catch (err) {
      toast('测活失败：' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '测活';
    }
  }));

  actions.appendChild(mkBtn('预热', 'ghost sm', async (btn) => {
    btn.disabled = true;
    btn.textContent = '预热中…';
    try {
      const r = await api(`/admin/api/accounts/${encodeURIComponent(a.name)}/warmup`, { method: 'POST' });
      const res = r.result || {};
      toast(res.message || '预热完成', res.ok ? 'ok' : 'err');
      await loadAccounts();
    } catch (err) {
      toast('预热失败：' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '预热';
    }
  }));

  if (a.rateLimited) {
    actions.appendChild(mkBtn('解除限流', 'primary sm', async (btn) => {
      btn.disabled = true;
      try {
        await api(`/admin/api/accounts/${encodeURIComponent(a.name)}`, {
          method: 'PATCH',
          body: { rateLimited: false },
        });
        toast(`账号 ${a.name} 已解除限流标记`, 'ok');
        await loadAccounts();
      } catch (err) {
        toast('解除限流失败：' + err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    }));
  }

  const toggle = document.createElement('button');
  toggle.className = 'ghost sm';
  toggle.textContent = a.enabled ? '暂停' : '启用';
  toggle.title = a.enabled ? '暂停后不参与自动切换' : '启用后参与自动切换';
  toggle.addEventListener('click', async () => {
    await api(`/admin/api/accounts/${encodeURIComponent(a.name)}`, {
      method: 'PATCH',
      body: { enabled: !a.enabled },
    });
    toast(`账号 ${a.name} 已${a.enabled ? '暂停' : '启用'}`, 'ok');
    await loadAccounts();
  });
  actions.appendChild(toggle);

  actions.appendChild(mkBtn('体检', 'ghost sm', async (btn) => {
    btn.disabled = true;
    try {
      const r = await api(`/admin/api/accounts/${encodeURIComponent(a.name)}/doctor`);
      const rows = r.checks
        .map(
          (c) =>
            `<div><span class="${c.ok ? 'text-ok' : 'text-err'}">${c.ok ? '通过' : '未通过'}</span> · ${escapeHtml(c.name)}：${escapeHtml(c.detail)}</div>`,
        )
        .join('');
      openModal(`体检结果 · ${a.name}`, `<div class="check-list">${rows}</div>`);
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
      const now = Date.now();
      const grants = Array.isArray(r.grants) ? r.grants : [];
      let grantsHtml = '';
      if (grants.length > 0) {
        const rows = grants.map((g, idx) => {
          const isExpired = g.expireAt && g.expireAt <= now;
          const statusTag = isExpired
            ? '<span class="tag muted">已过期</span>'
            : g.remaining > 0
              ? '<span class="tag ok">生效中</span>'
              : '<span class="tag">已用完</span>';
          const expireStr = g.expireAt ? fmtTime(g.expireAt) : '永不过期';
          const grantedStr = g.grantedAt ? fmtTime(g.grantedAt) : '—';
          return `
            <tr>
              <td>#${idx + 1}</td>
              <td><b>+${g.granted}</b></td>
              <td><b>${g.remaining}</b></td>
              <td>${g.consumed}</td>
              <td class="small muted">${grantedStr}</td>
              <td class="small ${isExpired ? 'muted' : 'warn'}"><b>${expireStr}</b></td>
              <td>${statusTag}</td>
            </tr>`;
        }).join('');

        grantsHtml = `
          <div class="block-title spaced">
            <div class="block-title">积分批次明细与有效期（共 ${grants.length} 笔）：</div>
            <div class="table-wrap scroll-box">
              <table>
                <thead>
                  <tr>
                    <th>序号</th>
                    <th>发放额度</th>
                    <th>剩余积分</th>
                    <th>已消耗</th>
                    <th>发放时间</th>
                    <th>失效时间</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>`;
      }

      openModal(
        `积分账本 · ${a.name}`,
        `<div class="kv kv-flush">
          <dt>剩余可用积分</dt><dd><b>${r.remaining}</b></dd>
          <dt>已消耗积分</dt><dd>${r.consumed}</dd>
          <dt>累计发放积分</dt><dd>${r.granted}</dd>
          <dt>最近到期时间</dt><dd>${r.nextExpireAt ? fmtTime(r.nextExpireAt) : '—'}</dd>
        </div>
        ${grantsHtml}`,
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
  orderBtns.appendChild(mkBtn('上移', 'ghost sm', (btn) => moveAccount(a.name, -1, btn)));
  orderBtns.appendChild(mkBtn('下移', 'ghost sm', (btn) => moveAccount(a.name, 1, btn)));
  actions.appendChild(orderBtns);

  actions.appendChild(
    mkBtn('删除', 'danger sm', () => {
      /* 删除账号会连带删掉令牌文件 —— 没有服务端快照可回退，
         所以这里必须走二次确认，把后果说清楚。 */
      confirmAction({
        title: `删除账号 ${a.name}`,
        message:
          `将删除账号「${a.name}」及其本地令牌文件，账号池中的会话绑定也会一并失效。` +
          '此操作不可撤销。',
        confirmText: '删除账号',
        onConfirm: async () => {
          await api(`/admin/api/accounts/${encodeURIComponent(a.name)}`, { method: 'DELETE' });
          toast(`账号 ${a.name} 已删除`, 'ok');
          await loadAccounts();
          await loadInsights();
        },
      });
    }),
  );

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
    else if (a.rateLimited) t(a.lastProbe && a.lastProbe.status === 'paused' ? '限流暂停' : '疑似限流（停调度）', 'err');
    else if (a.health === 'healthy') t('正常', 'ok');
    else if (a.health === 'unauthorized') t('凭证失效', 'err');
    else if (a.health === 'rate_limited') t('限流中', 'warn');
    else if (a.health === 'error') t('异常', 'err');
    t(`P${a.priority ?? 0}`, 'info');
    if (a.frozen) t(`额度冻结${a.frozenReason ? '：' + a.frozenReason : ''}`, 'warn');
    if (a.pendingLogin) t('授权中', 'info');
    if (!a.enabled) t('已暂停', '');
    if (a.checkinEnabled === false) t('签到已停用', 'warn');
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

// 蹬额度模式横幅中的“恢复平衡模式”按钮
$('#btn-exit-burn-banner')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await api('/admin/api/config', { method: 'POST', body: { mode: 'balanced' } });
    toast('已恢复为平衡调度模式', 'ok');
    await loadAccounts();
  } catch (err) {
    toast('切换模式失败：' + err.message, 'err');
  } finally {
    btn.disabled = false;
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

// 批量测活（ping 生文接口看首字耗时）
$('#btn-probe-all').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = '测活中…';
  try {
    const res = await api('/admin/api/accounts/probe', { method: 'POST', body: {} });
    const results = res.results || [];
    if (results.length === 0) {
      toast('没有可测活的已登录且启用账号', 'warn');
    } else {
      const okCount = results.filter((r) => r.status === 'ok').length;
      const suspectedCount = results.filter((r) => r.status === 'suspected').length;
      const pausedCount = results.filter((r) => r.status === 'paused').length;
      const errCount = results.filter((r) => r.status === 'error').length;
      const summary = `批量测活完成：正常 ${okCount} 个` +
        (suspectedCount ? `，疑似限流 ${suspectedCount} 个` : '') +
        (pausedCount ? `，超时暂停 ${pausedCount} 个` : '') +
        (errCount ? `，异常 ${errCount} 个` : '');
      toast(summary, suspectedCount + pausedCount + errCount > 0 ? 'err' : 'ok');

      /* 状态用文字标签而不是 emoji 图标 —— emoji 在各平台字形不一，
         而且一行里混着彩色图标会盖住真正要读的信息。 */
      const STATUS_LABEL = { ok: '正常', suspected: '疑似限流', paused: '超时暂停', error: '异常' };
      const STATUS_CLS = { ok: 'text-ok', suspected: 'text-warn', paused: 'text-err', error: 'text-err' };
      const detailRows = results.map((r) => {
        const status = r.status || 'error';
        return `<div class="check-list-item"><span class="${STATUS_CLS[status] || 'text-err'}">${STATUS_LABEL[status] || '异常'}</span><b>${escapeHtml(r.account)}</b>：${escapeHtml(r.message)}</div>`;
      }).join('');
      openModal('批量测活结果', `<div class="check-list">${detailRows}</div>`);
    }
    await loadAccounts();
  } catch (err) {
    toast('批量测活失败：' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '批量测活';
  }
});

// 批量无 token 预热
$('#btn-warmup-all').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = '预热中…';
  try {
    const res = await api('/admin/api/accounts/warmup', { method: 'POST', body: {} });
    const results = res.results || [];
    if (results.length === 0) {
      toast('没有可预热的已登录且启用账号', 'warn');
    } else {
      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.filter((r) => !r.ok).length;
      toast(`批量预热完成：成功 ${okCount} 个${failCount ? `，失败 ${failCount} 个` : ''}`, failCount > 0 ? 'err' : 'ok');
    }
    await loadAccounts();
  } catch (err) {
    toast('批量预热失败：' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '批量预热';
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

/**
 * 新增账号弹窗。
 *
 * 抽成函数是有原因的：**空状态里的「新增账号」按钮要复用同一个弹窗** ——
 * 空状态是用户的第一入口，不能自己另写一套交互。
 */
function openAddAccountModal() {
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
}

$('#btn-add').addEventListener('click', openAddAccountModal);
$('#btn-empty-add-account').addEventListener('click', openAddAccountModal);

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
     <p class="auth-link-row"><a href="${escapeHtml(res.verificationUriComplete)}" target="_blank" rel="noopener" class="primary">打开 ${regionLabel} 授权页面</a></p>
     <div class="progress"><i></i></div>
     <p id="login-status" class="muted small center">正在监听授权完成中…</p>`,
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
      if (el) el.textContent = '授权成功，正在刷新…';
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

/* ───────────────────────── 自动签到：紧凑列表与调度 ───────────────────────── */

/** 相对时间描述（"还有 3 小时 12 分" / "12 分钟前"）。 */
function fmtRelative(ts) {
  if (!ts) return '';
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  let text;
  if (days >= 1) text = `${days} 天 ${hours % 24} 小时`;
  else if (hours >= 1) text = `${hours} 小时 ${mins % 60} 分`;
  else text = `${mins} 分`;
  return diff >= 0 ? `还有 ${text}` : `${text}前`;
}

/** 紧凑时间格式 "MM-DD HH:mm" —— 列表窄，省掉年份与秒。 */
function fmtDayTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 签到计划的一句话描述（国内 / 海外各一句）。 */
function formatCheckinSchedule(st) {
  const regions = st.regions || {};
  const describe = (label, r) => {
    if (!r) return '';
    const jitter = r.jitterMinutes || 0;
    return `${label} ${r.time}${jitter > 0 ? ` ±${jitter} 分钟随机` : ''}`;
  };
  const cn = describe('国内', regions.cn);
  const global = describe('海外', regions.global);
  if (cn && global) return `${cn} · ${global}`;
  return cn || global || `每日定时 ${st.time || ''}`;
}

/**
 * 账号的签到摘要 —— 兼容老后端（没有 checkinSummary 时用旧字段兜底）。
 *
 * 为什么要兜底：前端可能被更新得比后端早（静态资源与镜像版本不同步），
 * 这时至少还能显示「上次签到时间 / 下次计划签到」，不至于整块空白。
 */
function summaryOf(a) {
  if (a.checkinSummary) return a.checkinSummary;
  const last = a.lastCheckin || null;
  return {
    todayKey: '',
    yesterdayKey: '',
    yesterday: null,
    today: null,
    last: last
      ? {
          at: last.at,
          outcome: last.outcome,
          signed: last.outcome === 'claimed' || last.outcome === 'already',
          signedAt: last.at,
          points: last.points,
          streak: last.streak,
          message: last.message,
        }
      : null,
    lastError:
      last && (last.outcome === 'error' || last.outcome === 'unavailable')
        ? { at: last.at, outcome: last.outcome, message: last.message }
        : null,
    nextAt: a.nextCheckinAt ?? null,
    signedToday: false,
  };
}

/**
 * 概览 chip 条 —— 一行放下四个答案：昨天签没签、今天到哪了、下次什么时候签、有没有异常。
 *
 * 数据来自每个账号的 `checkinSummary`（后端按**该账号所属时区**算好），
 * 所以「昨天」对国内号与海外号各自成立。
 */
function renderCheckinOverview() {
  const accounts = (state.accounts || []).filter((a) => a.checkinEnabled !== false);
  const summaries = accounts.map((a) => ({ a, s: summaryOf(a) }));

  /** 写一枚 chip（主文案 + 颜色 + 注解）。 */
  const chip = (id, subId, value, cls, sub) => {
    const b = $(id);
    b.textContent = value;
    b.className = cls || '';
    $(subId).textContent = sub || '';
  };

  /* ── 昨天签到 ──
     ⚠️ 「没有记录」也算**没签上** —— 服务当时没跑起来的账号，
     对「自动化有没有在跑」这个问题的答案就是「没签」。
     但要把两种情况分开说：有记录但没签上（有异常信息）vs 压根没记录（服务没跑）。 */
  const signedYesterday = summaries.filter((x) => x.s.yesterday && x.s.yesterday.signed);
  const failedYesterday = summaries.filter((x) => x.s.yesterday && !x.s.yesterday.signed);
  const noRecordYesterday = summaries.filter((x) => !x.s.yesterday);
  const missedYesterday = failedYesterday.length + noRecordYesterday.length;
  if (!summaries.length) {
    chip('#ov-yesterday', '#ov-yesterday-sub', '—', 'muted', '没有参与自动签到的账号');
  } else {
    const notes = [];
    if (failedYesterday.length) notes.push(`${failedYesterday.length} 个没签上`);
    if (noRecordYesterday.length) notes.push(`${noRecordYesterday.length} 个无记录`);
    chip(
      '#ov-yesterday',
      '#ov-yesterday-sub',
      `${signedYesterday.length}/${summaries.length} 已签`,
      signedYesterday.length === summaries.length ? 'ok' : 'warn',
      missedYesterday ? notes.join(' · ') : '昨天全部按时签到',
    );
  }

  /* ── 今日进度 ── */
  const signedToday = summaries.filter((x) => x.s.signedToday).length;
  const pending = summaries.length - signedToday;
  chip(
    '#ov-today',
    '#ov-today-sub',
    summaries.length ? `${signedToday}/${summaries.length}` : '—',
    summaries.length && signedToday === summaries.length ? 'ok' : '',
    pending ? `${pending} 个待签` : '今天的签到已全部完成',
  );

  /* ── 下次计划签到 ──
     时刻落在过去 = 今天的窗口已过但还没签上 → 这不是「下次」，是「待补签」。 */
  const nexts = summaries
    .map((x) => x.s.nextAt)
    .filter((t) => typeof t === 'number' && t > 0)
    .sort((a, b) => a - b);
  if (!nexts.length) {
    chip('#ov-next', '#ov-next-sub', '—', 'muted', '没有排定的签到计划');
  } else if (nexts[0] <= Date.now()) {
    chip('#ov-next', '#ov-next-sub', '待补签', 'warn', `原定 ${fmtDayTime(nexts[0])}`);
  } else {
    chip('#ov-next', '#ov-next-sub', fmtDayTime(nexts[0]), '', fmtRelative(nexts[0]));
  }

  /* ── 异常账号 ── */
  const errored = summaries.filter((x) => x.s.lastError);
  chip(
    '#ov-errors',
    '#ov-errors-sub',
    errored.length ? `${errored.length} 个` : '0 个',
    errored.length ? 'err' : 'ok',
    errored.length
      ? errored.map((x) => x.a.name).slice(0, 2).join('、') + (errored.length > 2 ? ' 等' : '')
      : '没有账号签到异常',
  );
}

/**
 * 签到明细 —— **每账号一行**，不用表格。
 *
 * 横向四段：账号（状态点 + 名称 + 近 7 天小格子）｜昨天（签到时刻 + 积分）
 * ｜下次（计划签到时刻）｜异常（最近一次错误），末尾是操作按钮。
 */
function renderCheckinTable() {
  const list = $('#checkin-list');
  if (!state.accounts || state.accounts.length === 0) {
    list.innerHTML = '<div class="ckin-empty">还没有账号</div>';
    return;
  }

  /* 「仅看异常」筛选：只留昨天没签上或最近一次出错的账号 —— 账号多的时候省事。 */
  const onlyIssues = state.checkinOnlyIssues === true;
  const rows = state.accounts.filter((a) => {
    if (!onlyIssues) return true;
    const s = summaryOf(a);
    return Boolean(s.lastError) || Boolean(s.yesterday && !s.yesterday.signed);
  });
  if (!rows.length) {
    list.innerHTML = `<div class="ckin-empty">${onlyIssues ? '没有异常账号 —— 一切正常' : '还没有账号'}</div>`;
    return;
  }

  list.innerHTML = '';
  for (const a of rows) {
    const s = summaryOf(a);
    const on = a.checkinEnabled !== false;
    const y = s.yesterday;
    const err = s.lastError;

    /* 状态点：一枚点说明「昨天签没签」 —— 比一个字省地方。 */
    let dotCls = 'off';
    let dotTip = '自动签到已停用';
    if (on) {
      if (y && y.signed) {
        dotCls = 'ok';
        dotTip = '昨天已签到';
      } else if (y) {
        dotCls = 'err';
        dotTip = '昨天没签上';
      } else {
        dotCls = 'warn';
        dotTip = '昨天无记录（服务当时未运行）';
      }
    }

    /* 昨天：签到时刻 + 拿到的积分。 */
    let whenHtml;
    if (!on) {
      whenHtml = '<span class="ckin-pts none">已停用</span>';
    } else if (y && y.signed) {
      const pts =
        y.points != null
          ? `<span class="ckin-pts">${y.points > 0 ? '+' : ''}${y.points}</span>`
          : '<span class="ckin-pts none">无积分</span>';
      whenHtml = `<span class="ckin-time">${fmtDayTime(y.signedAt)}</span>${pts}`;
    } else if (y) {
      whenHtml = `<span class="ckin-pts err">昨天${y.outcome === 'error' ? '异常' : '未签上'}</span>`;
    } else {
      whenHtml = '<span class="ckin-pts none">昨天无记录</span>';
    }

    /* 下次计划签到 —— 时刻已过 = 今天还没签上，等后台补签。 */
    let nextHtml;
    let nextCls = 'ckin-next';
    if (!on) {
      nextHtml = '<span class="muted">已停用</span>';
    } else if (!s.nextAt) {
      nextHtml = '<span class="muted">—</span>';
    } else if (s.nextAt <= Date.now()) {
      nextCls += ' overdue';
      nextHtml = `待补签 <em>原定 ${fmtDayTime(s.nextAt)}</em>`;
    } else {
      nextHtml = `下次 ${fmtDayTime(s.nextAt)} <em>${fmtRelative(s.nextAt)}</em>`;
    }

    /* 最近一次异常 —— 原文截断，悬停看全文。 */
    const errHtml = err
      ? `<span class="ckin-err has" title="${escapeHtml(err.message || '')}">${escapeHtml((err.message || '异常').slice(0, 18))}</span>`
      : '<span class="ckin-err">—</span>';

    const row = document.createElement('div');
    row.className = 'ckin-row' + (err ? ' is-err' : '');
    row.innerHTML = `
      <span class="ckin-name" title="${escapeHtml(a.name)}">
        <span class="ckin-dot ${dotCls}" title="${escapeHtml(dotTip)}"></span>
        <b>${escapeHtml(a.name)}</b>
        <span class="ckin-region">${escapeHtml(a.region === 'global' ? '海外' : '国内')}</span>
        ${renderCheckinDays(a.checkinDays || {})}
      </span>
      <span class="ckin-when">${whenHtml}</span>
      <span class="${nextCls}">${nextHtml}</span>
      ${errHtml}
      <span class="ckin-ops"></span>`;

    const ops = row.querySelector('.ckin-ops');

    /* 停用 / 启用自动签到 */
    ops.appendChild(mkBtn(on ? '停用' : '启用', 'ghost sm', async (btn) => {
      btn.disabled = true;
      try {
        await api(`/admin/api/accounts/${encodeURIComponent(a.name)}`, {
          method: 'PATCH',
          body: { checkinEnabled: !on },
        });
        toast(`账号 [${a.name}] 自动签到已${on ? '停用' : '启用'}`, 'ok');
        await loadAccounts();
        await loadScheduler();
      } catch (err) {
        toast('操作失败：' + err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    }));

    /* 立即签到 */
    ops.appendChild(mkBtn('签到', 'ghost sm', async (btn) => {
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const r = await api(`/admin/api/accounts/${encodeURIComponent(a.name)}/checkin`, { method: 'POST' });
        toast(r.message || '签到成功', r.outcome === 'error' ? 'err' : 'ok');
        await loadAccounts();
        await loadScheduler();
      } catch (err) {
        toast('签到失败：' + err.message, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = '签到';
      }
    }));
    list.appendChild(row);
  }
}

/** 近 7 天的签到小格子（绿=签到、灰=没签、红=异常）。 */
function renderCheckinDays(days) {
  const keys = Object.keys(days).sort();
  if (!keys.length) return '';
  const items = keys.slice(-7);
  const dots = items
    .map((k) => {
      const d = days[k];
      const cls = d.signed ? 'ok' : d.outcome === 'error' || d.outcome === 'unavailable' ? 'err' : 'warn';
      const tip = `${k} ${d.signed ? '已签到' : '未签上'}${d.points != null ? `（${d.points} 积分）` : ''}`;
      return `<span class="day-dot ${cls}" title="${escapeHtml(tip)}"></span>`;
    })
    .join('');
  return `<span class="day-dots" title="近 ${items.length} 天签到情况">${dots}</span>`;
}

async function loadScheduler() {
  try {
    const s = await api('/admin/api/scheduler');
    state.schedulerStatus = s;
    if (s.autoCheckin) {
      $('#checkin-status-badge').textContent = s.autoCheckin.enabled ? '后台自动运行中' : '已暂停';
      $('#checkin-status-badge').className = 'badge ' + (s.autoCheckin.enabled ? 'ok' : 'warn');
      /* 头部显示「下一次什么时候签」—— 这是用户最常看的一个数。
         具体计划（国内/海外各几点、随机窗口）放在设置页，这里不重复占位。 */
      const nexts = (state.accounts || [])
        .map((a) => a.nextCheckinAt)
        .filter((t) => typeof t === 'number' && t > 0)
        .sort((a, b) => a - b);
      $('#checkin-next-time').textContent = !nexts.length
        ? formatCheckinSchedule(s.autoCheckin)
        : nexts[0] <= Date.now()
          /* 时刻已过 = 今天的窗口错过还没签上 —— 这是「待补签」，不是「下次」。 */
          ? `待补签（原定 ${fmtDayTime(nexts[0])}）`
          : `下次签到 ${fmtDayTime(nexts[0])}（${fmtRelative(nexts[0])}）`;
      $('#setting-checkin-enabled').checked = s.autoCheckin.enabled;
      const regions = s.autoCheckin.regions || {};
      for (const [region, fallbackTz, fallbackTime] of [
        ['cn', 'Asia/Shanghai', '08:00'],
        ['global', 'America/New_York', '08:00'],
      ]) {
        const r = regions[region] || {};
        $(`#setting-checkin-time-${region}`).value = r.time || fallbackTime;
        $(`#setting-checkin-jitter-${region}`).value = r.jitterMinutes || 0;
        $(`#setting-checkin-tz-${region}`).value = r.timezone || fallbackTz;
      }
    }
    if (s.autoRefresh) {
      $('#refresh-status-badge').textContent = s.autoRefresh.enabled ? '后台自动巡检中' : '已暂停';
      $('#refresh-status-badge').className = 'badge ' + (s.autoRefresh.enabled ? 'ok' : 'warn');
      $('#refresh-interval-label').textContent = `每 ${s.autoRefresh.intervalMinutes} 分钟巡检 (余量 < ${s.autoRefresh.marginMinutes}m 自动续期)`;
      $('#setting-refresh-enabled').checked = s.autoRefresh.enabled;
      $('#setting-refresh-interval').value = s.autoRefresh.intervalMinutes;
      $('#setting-refresh-margin').value = s.autoRefresh.marginMinutes;
    }
    renderCheckinOverview();
    renderCheckinTable();
    renderTokensTable();
  } catch {
    // 忽略调度器获取失败
  }
}

/* 「仅看异常」—— 账号多的时候，一键过滤出没签上/报错的那些。 */
$('#btn-checkin-only-issues').addEventListener('click', () => {
  state.checkinOnlyIssues = !state.checkinOnlyIssues;
  const btn = $('#btn-checkin-only-issues');
  btn.className = 'ghost sm' + (state.checkinOnlyIssues ? ' on' : '');
  renderCheckinTable();
});

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
        toast(`体检完成：${r.checks.map((c) => c.name + (c.ok ? ' 通过' : ' 未通过')).join('，')}`, 'ok');
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
  /* 与账号列表同一套规则：容器与空态二选一，别留空白带。 */
  const hasKeys = state.keys.length > 0;
  list.classList.toggle('hidden', !hasKeys);
  $('#keys-empty').classList.toggle('hidden', hasKeys);

  for (const k of state.keys) {
    const row = document.createElement('div');
    row.className = 'key-row' + (k.enabled ? '' : ' disabled');

    const main = document.createElement('div');
    main.className = 'key-main';

    const nameEl = document.createElement('div');
    nameEl.className = 'key-name';
    nameEl.innerHTML =
      `<span>${escapeHtml(k.name)}</span>` +
      (k.primary ? '<span class="tag warn" title="主密钥">主密钥</span>' : '') +
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
      <div class="setup-label">反代 Base URL（填进 Claude Code 等 Anthropic 客户端，不要带 /v1）</div>
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
  const claudeEl = $('#snippet-claude');
  if (claudeEl) claudeEl.textContent = claudeSnippet;

  const anthropicSnippet =
`# 对话请求
curl ${baseUrl}/v1/messages \\
  -H "x-api-key: ${apiKey}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" \\
  -d '{"model":"MiniMax-M3","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'

# Token 计数（与同会话后续对话一对一绑定同一账号）
curl ${baseUrl}/v1/messages/count_tokens \\
  -H "x-api-key: ${apiKey}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" \\
  -d '{"model":"MiniMax-M3","messages":[{"role":"user","content":"你好"}]}'`;
  const anthropicEl = $('#snippet-anthropic');
  if (anthropicEl) anthropicEl.textContent = anthropicSnippet;
}

/**
 * 生成新客户端密钥的弹窗。
 *
 * 同「新增账号」：抽成函数是为了让空状态里的「生成新密钥」按钮复用它。
 */
function openNewKeyModal() {
  openModal(
    '生成新客户端密钥',
    `<label class="field">密钥名称
       <input id="key-name" type="text" placeholder="例如 我的 Claude Code / 办公笔记本" autocomplete="off">
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
         <div class="usercode key">${escapeHtml(r.key.key)}</div>
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
}

$('#btn-new-key').addEventListener('click', openNewKeyModal);
$('#btn-empty-new-key').addEventListener('click', openNewKeyModal);

$('#btn-refresh-keys').addEventListener('click', async () => {
  await loadKeys();
  toast('密钥列表已刷新', 'ok');
});

/* ───────────────────────── Tab 2: 反代服务详细管理 ───────────────────────── */

async function loadConfig() {
  try {
    state.config = await api('/admin/api/config');
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
  const modeText =
    c.mode === 'burn'
      ? '蹬额度模式（优先消耗临近到期积分）'
      : c.mode === 'balanced'
        ? '平衡模式（额度耗尽可无缝滑动）'
        : '最大缓存模式（会话不迁移）';
  $('#proxy-detail-kv').innerHTML = `
    <dt>公开监听 Base URL</dt><dd><code>${escapeHtml(p.baseUrl || '—')}</code></dd>
    <dt>外部服务端口</dt><dd><b>${escapeHtml(p.port || '—')}</b></dd>
    <dt>上游端点与描述</dt><dd>${escapeHtml(p.upstream || '—')}</dd>
    <dt>调度模式</dt><dd><b>${escapeHtml(modeText)}</b></dd>
    <dt>最小可用积分</dt><dd><b>${escapeHtml(String(c.creditsThreshold ?? '—'))}</b>（低于此值冻结账号）</dd>
    <dt>优先级分层</dt><dd>${renderTiers(c.tiers)}</dd>
    <dt>入站鉴权模式</dt><dd>多密钥注册表隔离，支持单独吊销</dd>
    <dt>协议与透传方式</dt><dd>纯 Anthropic 原生协议直通（含 /v1/messages 与 /v1/messages/count_tokens）</dd>`;
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
      <td><b class="text-warn">${countdownStr}</b></td>
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
        `<span class="text-ok">请求成功</span> · 耗时 <b>${r.durationMs} ms</b> · 账号: <b>${escapeHtml(r.account || '默认')}</b>`;
      $('#test-result-output').textContent = r.response || '（无响应正文）';
    } else {
      $('#test-result-status').innerHTML =
        `<span class="text-err">请求失败</span> · 耗时 <b>${r.durationMs} ms</b>`;
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
    const source = $('#req-filter-source').value;
    const search = $('#req-search-input').value.trim();
    const params = new URLSearchParams();
    if (status && status !== 'all') params.set('status', status);
    if (source && source !== 'all') params.set('source', source);
    if (search) params.set('search', search);
    params.set('limit', '100');

    const res = await api(`/admin/api/requests?${params.toString()}`);
    state.requests = res.items || [];
    renderRequestsTable();
  } catch {
    // 忽略
  }
}

/* 请求来源 → 展示标签。
   测活/预热也会打到上游，混在反代流量里会看不出「这条是谁发的」。 */
const REQUEST_SOURCE_LABEL = { proxy: '反代', probe: '测活', warmup: '预热' };
const REQUEST_SOURCE_CLS = { proxy: 'tag', probe: 'tag info', warmup: 'tag warn' };

function requestSourceTag(source) {
  const key = source || 'proxy';
  const label = REQUEST_SOURCE_LABEL[key] || key;
  const cls = REQUEST_SOURCE_CLS[key] || 'tag';
  return `<span class="${cls}">${escapeHtml(label)}</span>`;
}

function renderRequestsTable() {
  const tbody = $('#requests-table-body');
  /* 空的时候整张表藏掉，换成一段说明 —— 只留一行「暂无请求记录」的表，
     看着像接口挂了。 */
  const hasRequests = !!(state.requests && state.requests.length > 0);
  $('#requests-table-wrap').classList.toggle('hidden', !hasRequests);
  $('#requests-empty').classList.toggle('hidden', hasRequests);
  if (!hasRequests) {
    tbody.innerHTML = '';
    return;
  }
  tbody.innerHTML = '';
  for (const item of state.requests) {
    const tr = document.createElement('tr');
    tr.className = 'row-clickable';

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
      <td>${requestSourceTag(item.source)}</td>
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
$('#req-filter-source').addEventListener('change', () => loadRequests());
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

$('#btn-clear-requests').addEventListener('click', () => {
  /* 破坏性操作：二次确认 + 事后可撤销。
     服务端在清空前留了一份快照，所以这里能给出「撤销」——
     没有退路的清空按钮不该出现在工具条里。 */
  const count = state.requests.length;
  confirmAction({
    title: '清空请求缓存',
    message:
      `将删除当前缓存中的全部 ${count} 条请求记录（含入站内容、中转过程与 token 用量）。` +
      '清空后可在提示条里点「撤销」恢复，撤销窗口为 10 分钟。',
    confirmText: '清空',
    onConfirm: async () => {
      const res = await api('/admin/api/requests', { method: 'DELETE' });
      await loadRequests();
      await loadRequestStats();
      toast('已清空所有请求记录缓存', 'ok', res.undoable ? {
        label: '撤销',
        run: async () => {
          const r = await api('/admin/api/requests/undo', { method: 'POST' });
          await loadRequests();
          await loadRequestStats();
          toast(r.ok ? '已恢复清空前的请求记录' : r.note || '没有可撤销的清空操作', r.ok ? 'ok' : 'err');
        },
      } : null);
    },
  });
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
  /* 国内 / 海外两套独立计划（各带自己的时区与随机窗口）。 */
  const readSchedule = (region) => ({
    time: $(`#setting-checkin-time-${region}`).value.trim() || '08:00',
    jitterMinutes: Math.max(0, Math.min(240, Number($(`#setting-checkin-jitter-${region}`).value) || 0)),
    timezone: $(`#setting-checkin-tz-${region}`).value.trim() || (region === 'cn' ? 'Asia/Shanghai' : 'America/New_York'),
  });
  const refreshEnabled = $('#setting-refresh-enabled').checked;
  const refreshInterval = Number($('#setting-refresh-interval').value) || 15;
  const refreshMargin = Number($('#setting-refresh-margin').value) || 30;

  try {
    await api('/admin/api/scheduler/config', {
      method: 'POST',
      body: {
        autoCheckin: {
          enabled: checkinEnabled,
          cn: readSchedule('cn'),
          global: readSchedule('global'),
        },
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
    <dt>项目版本</dt><dd><b>v${escapeHtml(c.version || '0.9.0')}</b></dd>
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
  modeBadge.textContent =
    state.insightsMode === 'burn'
      ? '蹬额度模式'
      : state.insightsMode === 'balanced'
        ? '平衡模式'
        : '最大缓存模式';
  modeBadge.className =
    'badge ' +
    (state.insightsMode === 'burn'
      ? 'warn'
      : state.insightsMode === 'balanced'
        ? 'info'
        : 'ok');

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
  /* 空的时候连表头一起藏掉 —— 一张只有表头的空表 + 一句提示，看起来像加载失败。 */
  const hasInsights = list.length > 0;
  $('#insights-table-wrap').classList.toggle('hidden', !hasInsights);
  $('#insights-empty').classList.toggle('hidden', hasInsights);
  if (!hasInsights) return;

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
    tdAction.appendChild(
      mkBtn('清除该账号', 'ghost sm', () => {
        /* 单账号清除同样是破坏性操作 —— 确认 + 撤销。 */
        confirmAction({
          title: `清除账号 ${acc.name} 的用量统计`,
          message: `将清空该账号的累计用量（请求 ${fmtInt(acc.requests)} 次、token ${fmtInt(acc.totalTokens)}）。清除后可在提示条里点「撤销」恢复。`,
          confirmText: '清除',
          onConfirm: async () => {
            const res = await api('/admin/api/insights/reset', { method: 'POST', body: { name: acc.name } });
            await loadInsights();
            toast(`已清除账号 ${acc.name} 的用量统计`, 'ok', res.undoable ? {
              label: '撤销',
              run: async () => {
                const r = await api('/admin/api/insights/undo', { method: 'POST' });
                await loadInsights();
                toast(r.ok ? '已恢复该账号的用量统计' : r.note || '没有可撤销的清空操作', r.ok ? 'ok' : 'err');
              },
            } : null);
          },
        });
      }),
    );
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
    ? '<p class="muted small no-margin">暂无模型维度数据</p>'
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
    ? '<p class="muted small no-margin">暂无按天数据</p>'
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

$('#btn-insights-reset-all').addEventListener('click', () => {
  /* 同「清空请求缓存」：确认 + 撤销。 */
  const count = (state.insights || []).length;
  confirmAction({
    title: '清空用量统计',
    message:
      `将清空 ${count} 个账号的累计用量统计（请求数、token 消耗、缓存命中率）。` +
      '清空后可在提示条里点「撤销」恢复，撤销窗口为 10 分钟。',
    confirmText: '清空',
    onConfirm: async () => {
      const res = await api('/admin/api/insights/reset', { method: 'POST', body: {} });
      await loadInsights();
      toast('已清空全部用量统计', 'ok', res.undoable ? {
        label: '撤销',
        run: async () => {
          const r = await api('/admin/api/insights/undo', { method: 'POST' });
          await loadInsights();
          toast(r.ok ? '已恢复清空前的用量统计' : r.note || '没有可撤销的清空操作', r.ok ? 'ok' : 'err');
        },
      } : null);
    },
  });
});

/* 启动系统 */
boot();
