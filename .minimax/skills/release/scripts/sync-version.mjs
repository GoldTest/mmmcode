#!/usr/bin/env node
/**
 * sync-version.mjs —— 发版时的版本号同步器（确定性本地操作，不需要 LLM 判断）。
 *
 * 解决的问题：版本号在 `package.json` 之外还有好几处**硬编码**引用
 * （README 的启动横幅、README 的固定镜像示例、AGENTS.md 的发布流程示例、
 * web/app.js 的版本兜底值）。每发一版就漏一处，文档里的版本号就开始撒谎。
 *
 * 用法（在仓库任意位置运行均可，脚本自己定位仓库根）：
 *   node .minimax/skills/release/scripts/sync-version.mjs --check
 *   node .minimax/skills/release/scripts/sync-version.mjs --bump patch
 *   node .minimax/skills/release/scripts/sync-version.mjs --set 0.7.6
 *
 * 退出码：0 = 正常（--check 模式下表示无漂移）；1 = 有问题（--check 发现漂移 / 参数非法）。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ── 定位仓库根：从脚本所在目录往上找带 package.json 的目录 ── */
function findRepoRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, 'utf-8'));
        if (json.name === 'waygate-mmcode') return dir;
      } catch {
        /* 不是合法 JSON，继续往上找 */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到仓库根（package.json 里没有 name: "waygate-mmcode"）');
}

const ROOT = findRepoRoot();
const PKG = join(ROOT, 'package.json');
const LOCK = join(ROOT, 'package-lock.json');

/* 会被替换的「当前版本」引用点。anchors 用来验证必须的锚点确实被同步到了。 */
const DOC_TARGETS = [
  {
    file: join(ROOT, 'README.md'),
    anchors: [
      { label: 'README 启动横幅', re: /途关 · MiniMax Code 反代 v(\d+\.\d+\.\d+)/ },
      { label: 'README 固定镜像示例', re: /image: ghcr\.io\/goldtest\/mmmcode:(\d+\.\d+\.\d+)/ },
    ],
  },
  {
    file: join(ROOT, 'AGENTS.md'),
    anchors: [
      { label: 'AGENTS 版本对齐示例', re: /v(\d+\.\d+\.\d+) ↔ "version": "(\d+\.\d+\.\d+)"/ },
      { label: 'AGENTS git tag 示例', re: /git tag -a v(\d+\.\d+\.\d+)/ },
      { label: 'AGENTS 镜像标签示例', re: /ghcr\.io\/goldtest\/mmmcode:(\d+\.\d+\.\d+)/ },
    ],
  },
  {
    file: join(ROOT, 'web', 'app.js'),
    anchors: [
      { label: '管理页版本兜底值', re: /c\.version \|\| '(\d+\.\d+\.\d+)'/ },
    ],
  },
  {
    /* 静态资源缓存击穿参数 —— 与「当前版本」无关（可能停更了好几版），
       所以用自定义 rewrite：把所有 ?v=<版本> 统一提到当前版本。 */
    file: join(ROOT, 'web', 'index.html'),
    anchors: [
      { label: 'index.html style.css 缓存参数', re: /style\.css\?v=(\d+\.\d+\.\d+)/ },
      { label: 'index.html keys.css 缓存参数', re: /keys\.css\?v=(\d+\.\d+\.\d+)/ },
      { label: 'index.html app.js 缓存参数', re: /app\.js\?v=(\d+\.\d+\.\d+)/ },
    ],
    rewrite: (text, _oldV, newV) => text.replace(/(\?v=)\d+\.\d+\.\d+/g, `$1${newV}`),
  },
];

const readJson = (p) => JSON.parse(readFileSync(p, 'utf-8'));

/**
 * 写 JSON 时保持文件原有的换行符。
 *
 * 仓库在 Windows 上是 CRLF，JSON.stringify 默认产出 LF —— 直接写会把整个文件
 * 的换行符改掉，制造出与版本号无关的巨大 diff。
 */
function writeJsonPreservingEol(file, obj) {
  const raw = readFileSync(file, 'utf-8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const text = JSON.stringify(obj, null, 2).replace(/\n/g, eol) + eol;
  writeFileSync(file, text, 'utf-8');
}

function bumpPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`版本号格式不合法（期望 x.y.z）：${version}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/**
 * 把文本里的「旧版本号」整体换成「新版本号」。
 *
 * 用数字边界（前后不能再跟数字/点），避免把 0.7.5 误伤到 0.7.55 或 10.7.5。
 */
function replaceVersionToken(text, oldV, newV) {
  const escaped = oldV.replace(/\./g, '\\.');
  const re = new RegExp(`(?<![\\d.])${escaped}(?![\\d])`, 'g');
  return text.replace(re, newV);
}

function currentVersion() {
  return readJson(PKG).version;
}

/* ── --check：报告所有锚点里出现的版本号是否等于 package.json 的版本 ── */
function check() {
  const current = currentVersion();
  let drift = 0;
  console.log(`package.json version = ${current}\n`);

  /* package-lock.json 的根版本必须跟 package.json 一致 */
  if (existsSync(LOCK)) {
    const lock = readJson(LOCK);
    const lockRoot = lock.version;
    const lockPkg = lock.packages?.['']?.version;
    if (lockRoot === current && lockPkg === current) {
      console.log(`  [一致] package-lock.json 版本 = ${current}`);
    } else {
      console.log(`  [漂移] package-lock.json 版本 = ${lockRoot} / ${lockPkg}，应为 ${current}`);
      drift += 1;
    }
  }

  for (const target of DOC_TARGETS) {
    if (!existsSync(target.file)) {
      console.log(`  [跳过] ${target.file} 不存在`);
      continue;
    }
    const text = readFileSync(target.file, 'utf-8');
    for (const anchor of target.anchors) {
      const m = anchor.re.exec(text);
      if (!m) {
        console.log(`  [缺失] ${anchor.label} —— 锚点没找到（${target.file}）`);
        drift += 1;
        continue;
      }
      /* 取锚点里出现的第一个版本号 */
      const found = m.slice(1).find((g) => /^\d+\.\d+\.\d+$/.test(g ?? '')) ?? '';
      if (found === current) {
        console.log(`  [一致] ${anchor.label} = ${found}`);
      } else {
        console.log(`  [漂移] ${anchor.label} = ${found}，应为 ${current}`);
        drift += 1;
      }
    }
  }
  console.log('');
  if (drift > 0) {
    console.log(`发现 ${drift} 处版本漂移 —— 跑 --bump patch 或 --set <版本> 修正。`);
    process.exit(1);
  }
  console.log('无漂移：文档里的版本号与 package.json 一致。');
}

/* ── --bump / --set：更新 package.json、package-lock.json 与所有文档引用 ── */
function apply(targetVersion) {
  const oldV = currentVersion();
  if (targetVersion === oldV) {
    /* 版本号没变也继续跑 —— package-lock.json 可能单独漂移着（手改 package.json
       时就会这样），提前返回会让漂移永远修不掉。 */
    console.log(`package.json 已是 ${oldV}，继续检查其余引用点。\n`);
  }

  /* 1. package.json */
  const pkg = readJson(PKG);
  pkg.version = targetVersion;
  writeJsonPreservingEol(PKG, pkg);
  console.log(`package.json      ${oldV} → ${targetVersion}`);

  /* 2. package-lock.json —— 根 package 与 packages[""] 两处版本号。
        这两处必须与 package.json 一致（否则 `npm ci` 与 npm 包元数据会漂移），
        所以无条件改写，不做「旧版本匹配」判断。 */
  if (existsSync(LOCK)) {
    const lock = readJson(LOCK);
    const before = [lock.version, lock.packages?.['']?.version];
    lock.version = targetVersion;
    if (lock.packages?.['']) lock.packages[''].version = targetVersion;
    writeJsonPreservingEol(LOCK, lock);
    const after = [lock.version, lock.packages?.['']?.version];
    if (before.join('/') !== after.join('/')) {
      console.log(`package-lock.json ${before.join(' / ')} → ${after.join(' / ')}`);
    }
  }

  /* 3. 文档引用：默认把旧版本号整体替换成新版本号；
        带自定义 rewrite 的目标（如 index.html 的 ?v= 缓存参数）用自己的规则。 */
  for (const target of DOC_TARGETS) {
    if (!existsSync(target.file)) continue;
    const before = readFileSync(target.file, 'utf-8');
    const after = target.rewrite
      ? target.rewrite(before, oldV, targetVersion)
      : replaceVersionToken(before, oldV, targetVersion);
    if (after !== before) {
      writeFileSync(target.file, after, 'utf-8');
      const changedLines = before.split('\n').filter((line, i) => line !== after.split('\n')[i]).length;
      const rel = target.file.replace(ROOT + '\\', '');
      console.log(`${rel}  更新 ${changedLines} 行（→ ${targetVersion}）`);
    }
  }

  console.log(`\n版本已同步到 ${targetVersion}。`);
  /* 跑一次自检，确保锚点全中 */
  console.log('');
  check();
}

/* ── 参数解析 ── */
const args = process.argv.slice(2);
if (args.includes('--check')) {
  check();
} else if (args.includes('--bump')) {
  const level = args[args.indexOf('--bump') + 1];
  if (level && level !== 'patch') {
    console.error(`--bump 目前只支持 patch（当前版本 ${currentVersion()}）`);
    process.exit(1);
  }
  apply(bumpPatch(currentVersion()));
} else if (args.includes('--set')) {
  const v = args[args.indexOf('--set') + 1];
  if (!v || !/^\d+\.\d+\.\d+$/.test(v)) {
    console.error('--set 需要一个 x.y.z 形式的版本号');
    process.exit(1);
  }
  apply(v);
} else {
  console.log('用法：');
  console.log('  node .minimax/skills/release/scripts/sync-version.mjs --check');
  console.log('  node .minimax/skills/release/scripts/sync-version.mjs --bump patch');
  console.log('  node .minimax/skills/release/scripts/sync-version.mjs --set 0.7.6');
  process.exit(1);
}
