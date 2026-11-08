/**
 * `mmcode web` —— 统一 Web 服务（反代 + 管理页 + 管理 API）一个端口。
 *
 * 与 `mmcode serve` 的分工：
 *   · `serve` = **纯反代**（core 的 startServer，老行为不变，客户端连它就行）；
 *   · `web`   = **反代 + 管理页 + 管理 API**（同一端口），给需要管理多账号的人用。
 * 两者共用同一个账号池（同一份 `accounts.json` 与同一套令牌）。
 *
 * 端口默认 8789（`serve` 的 8788 留给纯反代）。
 */

import { resolveKey, renderReady, renderReadyJson, type Adapter } from 'waygate-core';
import { AccountPool } from './pool.js';
import { startWebServer } from './web-server.js';
import { startProxyServer } from './proxy.js';
import { ensureAdminKey, maskAdminKey } from './admin.js';
import { adminKeyPath } from './admin.js';
import type { InsightsLedger } from './insights.js';
import type { KeyRegistry } from './keys.js';

/** `web` 的默认端口（`serve` 用 8788）。 */
export const DEFAULT_WEB_PORT = 8789;

export interface WebCliOptions {
  argv: string[];
  adapter: Adapter;
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
    '  /                    管理页（需管理密钥登录）',
    '  /admin/api/*         管理 API',
    '  /v1/chat/completions 反代（OpenAI 兼容）',
    '  /v1/messages         反代（Anthropic 兼容）',
    '  /v1/models           模型列表',
    '  /healthz             健康检查（不鉴权）',
    '',
    '只在你本机读写与转发；不上传任何数据。',
  ].join('\n');
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
  const base = `http://${args.host === '0.0.0.0' ? '127.0.0.1' : args.host}:${running.port}`;

  const lines: string[] = [];
  lines.push('─'.repeat(58));
  lines.push(`  MiniMax Code 统一服务已启动  v${opts.version}`);
  lines.push('─'.repeat(58));
  lines.push('');
  lines.push(`  管理页        ${base}/`);
  lines.push(`  反代地址      ${base}/v1`);
  lines.push(`  健康检查      ${base}/healthz`);
  lines.push('');
  lines.push(`  上游          ${opts.adapter.upstreamLabel}`);
  lines.push(`  凭证          ${cred.ok ? '✓' : '✗'} ${cred.detail}`);
  lines.push(`  入站密钥      ${apiKey}`);
  lines.push(`                 （客户端填这个：Claude Code 用 x-api-key，OpenAI 客户端用 Bearer）`);
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
  adapter: Adapter;
  keys: KeyRegistry;
  version: string;
}

/**
 * `mmcode serve` —— 纯反代（不含管理页）。
 *
 * 与 core 自带的 serve 行为一致，但走**本仓的代理层**，因此支持
 * **多把**入站密钥（注册表里任意一把启用且未过期的都能通过）。
 * 协议部分仍由 core 的 `startServer` 处理 —— 没有重复实现。
 */
export async function runServeCommand(opts: ServeCliOptions): Promise<number> {
  const log = (line: string) => process.stdout.write(line + '\n');

  /* 密钥优先级：显式 --key > 注册表主密钥 > 新生成一把。 */
  let key = opts.key?.trim();
  if (!key) key = opts.keys.primaryKey() ?? undefined;
  if (!key) key = opts.keys.create('默认密钥').key;
  /* ★ 显式 --key 必须**临时登记**进鉴权层 ——
     否则它只出现在启动横幅里，实际每个请求都会被 401 拒掉。
     临时登记不落盘，沿用 core「用户显式指定即由用户自管」的语义。 */
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

    const ready = {
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
    process.stdout.write((opts.json ? renderReadyJson(ready) : renderReady(ready)) + '\n');

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
