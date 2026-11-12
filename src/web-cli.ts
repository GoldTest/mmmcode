/**
 * `mmcode web` 与 `mmcode serve` CLI 入口。
 *
 * 与 `mmcode serve` 的分工：
 *   · `serve` = **纯反代**（不含管理页，默认 8788）；
 *   · `web`   = **反代 + 管理页 + 管理 API**（同一端口，默认 8789），给需要管理多账号的人用。
 * 两者共用同一个账号池（同一份 `accounts.json` 与同一套令牌），且均只暴露原生 Anthropic 兼容端点。
 */

import { resolveKey } from 'waygate-core';
import type { MmcodeAdapter } from './adapter.js';
import { AccountPool } from './pool.js';
import { startWebServer } from './web-server.js';
import { startProxyServer } from './proxy.js';
import { ensureAdminKey, maskAdminKey, adminKeyPath } from './admin.js';
import type { InsightsLedger } from './insights.js';
import type { KeyRegistry } from './keys.js';

/** `web` 的默认端口（`serve` 用 8788）。 */
export const DEFAULT_WEB_PORT = 8789;

export interface WebCliOptions {
  argv: string[];
  adapter: MmcodeAdapter;
  pool: AccountPool;
  keys: KeyRegistry;
  /** 用量台账（洞察面板数据源）。 */
  insights?: InsightsLedger;
  version: string;
}

interface WebArgs {
  host: string;
  port: number;
  key?: string;
  verbose: boolean;
  help: boolean;
}

function parseWebArgs(argv: string[]): WebArgs {
  const out: WebArgs = { host: '127.0.0.1', port: DEFAULT_WEB_PORT, verbose: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) break;
    if (a === '--host') out.host = argv[++i] ?? out.host;
    else if (a === '--port') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`--port 非法：${argv[i]}`);
      out.port = v;
    } else if (a === '--key') out.key = argv[++i];
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`未知参数：${a}（用 --help 看用法）`);
  }
  return out;
}

function webHelp(version: string): string {
  return [
    `途关 · MiniMax Code 统一 Web 服务（v${version}）`,
    '',
    '用法：',
    '  mmcode web                启动反代 + 管理页 + 管理 API（同一端口）',
    '',
    '参数：',
    `  --port <n>          监听端口（默认 ${DEFAULT_WEB_PORT}）`,
    '  --host <addr>       监听地址（默认 127.0.0.1；0.0.0.0 会暴露给局域网/容器，谨慎）',
    '  --key <sk-…>        指定反代入站密钥（默认自动生成并缓存到 ~/.waygate/mmcode/key）',
    '  --verbose           打印每个请求的路由日志',
    '  --help              显示本帮助',
    '',
    '端点：',
    '  /                              管理页（需管理密钥登录）',
    '  /admin/api/*                   管理 API',
    '  /v1/messages                   反代（Anthropic 原生透传）',
    '  /v1/messages/count_tokens      Token 计数（Anthropic 原生透传，与同会话对话共绑账号）',
    '  /v1/models                     模型列表',
    '  /healthz                       健康检查（不鉴权）',
    '',
    '只在你本机读写与转发；不上传任何数据。',
  ].join('\n');
}

function originUrl(host: string, port: number): string {
  const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${h}:${port}`;
}

interface ServeReadyInfo {
  command: string;
  displayName: string;
  version: string;
  upstream: string;
  host: string;
  port: number;
  key: string;
  credential: { ok: boolean; detail: string; source?: string };
  models: Array<{ id: string; displayName?: string }>;
}

/** `mmcode serve` 人读启动横幅（纯 Anthropic 协议，不含 OpenAI 提示）。 */
function renderServeReady(r: ServeReadyInfo): string {
  const origin = originUrl(r.host, r.port);
  const lines: string[] = [];
  lines.push(`途关 · ${r.displayName} 反代 v${r.version}`);
  lines.push('');
  lines.push(`凭证    ${r.credential.ok ? '✓' : '✗'} ${r.credential.detail}`);
  lines.push(`上游    ${r.upstream}`);
  lines.push(`代理    ${origin}      （Anthropic 客户端如 Claude Code 填此地址，会自动补 /v1）`);
  lines.push(`密钥    ${r.key}`);
  if (r.host === '0.0.0.0' || r.host === '::') {
    lines.push('');
    lines.push(`⚠️  正在监听所有网络接口（${r.host}）—— 局域网内任何设备都能访问你的订阅。`);
    lines.push('    如非必要，请改用默认的 127.0.0.1。');
  }
  lines.push('');
  lines.push('模型 ID（填进你的客户端）：');
  if (r.models.length === 0) lines.push('  （暂无 —— 先跑一次 doctor 排查）');
  for (const m of r.models) {
    const hint = m.displayName && m.displayName !== m.id ? `   ${m.displayName}` : '';
    lines.push(`  ${m.id}${hint}`);
  }
  lines.push('');
  lines.push('把上面的「代理地址 + 密钥」填进 Claude Code 或 Anthropic SDK 即可。');
  lines.push('端点：POST /v1/messages · POST /v1/messages/count_tokens · GET /v1/models');
  lines.push('按 Ctrl+C 停止。');
  return lines.join('\n');
}

/** `mmcode serve --json` 机器可读输出（纯 Anthropic 协议）。 */
function renderServeReadyJson(r: ServeReadyInfo): string {
  const origin = originUrl(r.host, r.port);
  return JSON.stringify(
    {
      command: r.command,
      displayName: r.displayName,
      version: r.version,
      upstream: r.upstream,
      origin,
      proxyUrl: origin,
      anthropicBaseUrl: origin,
      key: r.key,
      credential: { ok: r.credential.ok, detail: r.credential.detail, source: r.credential.source ?? null },
      models: r.models.map((m) => ({ id: m.id, displayName: m.displayName ?? null })),
      endpoints: {
        anthropic: '/v1/messages',
        countTokens: '/v1/messages/count_tokens',
        models: '/v1/models',
      },
    },
    null,
    2,
  );
}

/**
 * 跑 `mmcode web`。返回进程退出码。
 */
export async function runWebCommand(opts: WebCliOptions): Promise<number> {
  let args: WebArgs;
  try {
    args = parseWebArgs(opts.argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(webHelp(opts.version) + '\n');
    return 0;
  }

  const log = (line: string) => process.stdout.write(line + '\n');

  /* 入站密钥（给客户端用）与管理密钥（给管理页用）—— 两把不同的钥匙。 */
  const apiKey = resolveKey(opts.adapter.command, args.key);
  const adminKey = ensureAdminKey();
  /* 同 serve：显式 --key 要临时登记进鉴权层，否则横幅上印着的钥匙实际用不了。 */
  if (args.key?.trim()) opts.keys.addTransient(args.key);

  const running = await startWebServer({
    host: args.host,
    port: args.port,
    apiKey,
    keys: opts.keys,
    adapter: opts.adapter,
    pool: opts.pool,
    insights: opts.insights,
    version: opts.version,
    verbose: args.verbose,
    log,
  });

  const models = await opts.adapter.listModels().catch(() => []);
  const cred = await opts.adapter.credentialStatus();
  const base = originUrl(args.host, running.port);

  const lines: string[] = [];
  lines.push('─'.repeat(58));
  lines.push(`  MiniMax Code 统一服务已启动  v${opts.version}`);
  lines.push('─'.repeat(58));
  lines.push('');
  lines.push(`  管理页        ${base}/`);
  lines.push(`  反代地址      ${base}    （Anthropic 客户端填此地址，勿带 /v1）`);
  lines.push(`  健康检查      ${base}/healthz`);
  lines.push('');
  lines.push(`  上游          ${opts.adapter.upstreamLabel}`);
  lines.push(`  凭证          ${cred.ok ? '✓' : '✗'} ${cred.detail}`);
  lines.push(`  入站密钥      ${apiKey}`);
  lines.push(`                 （客户端填这个：x-api-key 或 Authorization: Bearer <key>）`);
  lines.push(`                 共 ${opts.keys.list().length} 把，可在管理页生成/吊销`);
  if (adminKey.generated) {
    lines.push('');
    lines.push('  ⚠️  已生成管理密钥（首次启动自动生成，仅此一次明文显示）：');
    lines.push(`     ${adminKey.key}`);
    lines.push(`     已保存到 ${adminKeyPath()}（权限 0600）`);
  } else {
    lines.push(`  管理密钥      ${maskAdminKey(adminKey.key)}（${adminKey.path}）`);
  }
  if (models.length > 0) {
    lines.push('');
    lines.push(`  模型 ID       ${models.map((m) => m.id).join('、')}`);
  }
  if (args.host === '0.0.0.0') {
    lines.push('');
    lines.push('  ⚠️  正监听 0.0.0.0 —— 已暴露给局域网/容器外部。管理页有密钥保护，');
    lines.push('      但反代入站密钥同样有效，请确保网络边界可信。');
  }
  lines.push('');
  log(lines.join('\n'));

  const shutdown = () => {
    process.stdout.write('\n正在停止…\n');
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  /* 常驻直到信号触发。 */
  return await new Promise(() => {});
}

/* ─────────────────────── serve（纯反代） ─────────────────────── */

export interface ServeCliOptions {
  host: string;
  port: number;
  /** 显式指定的入站密钥（优先于注册表）。 */
  key?: string;
  json: boolean;
  verbose: boolean;
  adapter: MmcodeAdapter;
  keys: KeyRegistry;
  version: string;
}

/**
 * `mmcode serve` —— 纯反代（不含管理页）。
 *
 * 支持多把入站密钥（注册表里任意一把启用且未过期的都能通过）与纯 Anthropic 协议透传。
 */
export async function runServeCommand(opts: ServeCliOptions): Promise<number> {
  const log = (line: string) => process.stdout.write(line + '\n');

  /* 密钥优先级：显式 --key > 注册表主密钥 > 新生成一把。 */
  let key = opts.key?.trim();
  if (!key) key = opts.keys.primaryKey() ?? undefined;
  if (!key) key = opts.keys.create('默认密钥').key;
  if (opts.key?.trim()) opts.keys.addTransient(opts.key);

  const cred = await opts.adapter.credentialStatus();
  const models = await opts.adapter.listModels().catch(() => []);

  if (!cred.ok && !opts.json) {
    process.stderr.write(`凭证未就绪：${cred.detail}\n先运行：${opts.adapter.command} login\n`);
  }

  try {
    const running = await startProxyServer({
      host: opts.host,
      port: opts.port,
      adapter: opts.adapter,
      keys: opts.keys,
      verbose: opts.verbose,
      log,
    });

    const ready: ServeReadyInfo = {
      command: opts.adapter.command,
      displayName: opts.adapter.displayName,
      version: opts.version,
      upstream: opts.adapter.upstreamLabel,
      host: opts.host,
      port: running.port,
      key,
      credential: cred,
      models,
    };
    process.stdout.write((opts.json ? renderServeReadyJson(ready) : renderServeReady(ready)) + '\n');

    const shutdown = () => {
      process.stdout.write('\n正在停止…\n');
      void running.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return await new Promise(() => {
      /* 常驻：直到信号触发 exit */
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EADDRINUSE') {
      process.stderr.write(`端口 ${opts.port} 已被占用 —— 换一个：${opts.adapter.command} --port ${opts.port + 1}\n`);
      return 1;
    }
    process.stderr.write(`启动失败：${e.message}\n`);
    return 1;
  }
}
