/**
 * 把静态管理页复制到 `dist/web/`。
 *
 * 为什么要有这一步：npm 包只发 `files` 里列的目录，而 `dist` 已被列入 ——
 * 所以网页资源必须在**构建时**进 `dist`，发布出去的包才带得管理页。
 * 开发态（直接跑 `dist/index.js`，没跑过 build）会回落到仓库根的 `web/`。
 *
 * 不引第三方依赖：一个几行的复制脚本不值得为它拉一个包。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = join(root, 'web');
const dest = join(root, 'dist', 'web');

if (!existsSync(src)) {
  console.error(`[copy-web] 找不到源目录：${src}`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-web] ${src} → ${dest}`);
