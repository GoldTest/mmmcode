#!/usr/bin/env node
/**
 * waygate-mmcode —— MiniMax Code 本地反代（命令 `mmcode`）。
 *
 * 读取本机 MiniMax Code 客户端的登录态，在本机提供 Anthropic/OpenAI 兼容的聊天端点。
 *
 * ⚠️ 凭证互斥：MiniMax 同一账号只能有一个有效会话 —— 本工具与官方客户端同账号会互相踢下线。
 * 建议给本工具配专用账号。详见 README。
 */

import { createRequire } from 'node:module';
import { helpText, runCli, type Adapter } from 'waygate-core';
import { createMmcodeAdapter } from './adapter.js';
import { AccountStore } from './accounts.js';
import { AccountPool } from './pool.js';
import { DEFAULT_WEB_PORT, runWebCommand } from './web-cli.js';

/* 版本从 package.json 读 —— 硬编码会与 npm 发布版本漂移（已踩过：package 升 0.1.2 而 CLI 仍显示 0.1.0）。 */
const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const log = (line: string) => process.stdout.write(`[mmcode] ${line}\n`);

/**
 * 账号池 —— CLI 与 Web 共用同一份状态（`~/.waygate/mmcode/accounts.json`）。
 *
 * 单独建一个实例（而不是每个命令各建各的）是为了让 `mmcode accounts`
 * 在 `mmcode web` 进程里看到同样的数据。
 */
const store = new AccountStore();
const pool = new AccountPool(store, { log });
const adapter = createMmcodeAdapter({ pool, log });

const argv = process.argv.slice(2);

/* `web` 是本仓自带的**统一服务**（反代 + 管理页 + 管理 API）——
   core 的 CLI 不认识它，所以在这里分流，不走 runCli。 */
if (argv[0] === 'web') {
  const code = await runWebCommand({ argv: argv.slice(1), adapter, pool, version: VERSION });
  process.exit(code);
}

/**
 * 帮助文本：core 的 helpText 不含 `web`（它不认识本仓自带的子命令），
 * 这里在 `serve` 那一行后面补上 —— 免得用户以为没有这个命令。
 */
function fullHelp(a: Adapter): string {
  const base = helpText(a);
  const line = `  ${a.command} web${' '.repeat(14)}统一服务：反代 + 管理页 + 管理 API（同一端口，默认 ${DEFAULT_WEB_PORT}）`;
  return base.replace(new RegExp(`^(  ${a.command} serve.*)$`, 'm'), `$1\n${line}`);
}

if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
  process.stdout.write(fullHelp(adapter) + '\n');
  process.exit(0);
}

const code = await runCli(adapter, { version: VERSION });
process.exit(code);
