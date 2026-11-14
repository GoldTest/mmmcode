---
name: release
description: |
  发布 waygate-mmcode 新版本：跑 typecheck/test/build 三道关、bump 版本号并同步所有文档里的硬编码版本引用、提交推 main、打并推 vX.Y.Z tag 触发 GHCR 镜像发布。
  Use this skill whenever the user asks to "发版"、"发布"、"打 tag"、"发个版本"、"release"、"tag a version"、"publish a new image" in this repository.
  Do NOT use it for 回滚发版（删 tag 重打，见 AGENTS.md 速查表）、只推 main 的临时构建、npm 包单独发布，或其他项目的发版。
descriptions:
  zh-Hans: "发版：跑三道关、bump 版本号、同步文档版本引用、打 tag 推 tag，触发 GHCR 镜像发布。"
displayNames:
  zh-Hans: "发版"
---

# 发版（waygate-mmcode）

## 核心前提

**Git tag 是版本的唯一真相。** 推 `main` 只出 `main-<sha>` 临时镜像（不覆盖 `latest`）；
只有推送 `vX.Y.Z` 形式的 tag 才发布正式镜像。tag 一旦推上去就是公开动作，撤不干净 —— 所以
推 tag 之前必须把目标版本号报给用户确认。

## Inputs to collect

- **目标版本号**：用户给了就用用户的；没给就取 `package.json` 的版本做 patch +1，
  并把结果报给用户确认后再继续。版本语义（patch/minor/major）猜错时用户还能拦一把。
- **npm 包是否一起发**：默认**不发**。用户跑的是镜像，且本机通常未登录 npm
  （`npm whoami` 会报 ENEEDAUTH）。用户明确要求时才执行，且先确认已登录。

## Procedure

1. **预检工作区**
   确认当前分支是 `main`、`git status` 干净或剩余改动都属于本次发版。
   原因：提交会把工作区里所有内容一起带进发版，混进无关改动就等于用那个版本发了出去。
   有拿不准的改动时，先问用户是「一起发」还是「先留着」——
   典型例子是未跟踪的 `.minimax/skills/release/`（技能本体）与本地私有文件。
   顺便用 `git describe --tags --abbrev=0` 看当前最新 tag，确认它与 `package.json`
   的版本一致 —— 不一致说明上一版就没对齐，先查清楚再往下走。

2. **确定并确认目标版本号**
   把「`X.Y.Z` → `X.Y.(Z+1)`，即将推 tag `vX.Y.Z`」明确报给用户，等确认。
   原因：tag 推上去后即便删掉，GHCR 上已经出现过的镜像标签也未必能回收。

3. **同步版本号**
   ```powershell
   node .minimax/skills/release/scripts/sync-version.mjs --set <目标版本>
   ```
   脚本会一并改 `package.json`、`package-lock.json`，以及 README 启动横幅 / 固定镜像示例、
   AGENTS.md 发布流程示例、`web/app.js` 版本兜底值、`web/index.html` 的 `?v=` 静态资源
   缓存击穿参数里**硬编码**的版本号 —— 这些散落的引用点正是每版发完就开始撒谎的地方，
   漏改一处文档就与实际发布版本对不上（`?v=` 那个尤其阴：停更两版后浏览器会一直拿
   缓存里的旧 app.js，用户升级了却看不到新功能）。
   脚本结束时会自动跑一次 `--check` 自检。
   **但脚本的引用点清单不是全仓库** —— 新增的硬编码版本号不会自动进清单。所以同步完再自己
   grep 一遍旧版本号，确认没有漏网的：
   ```powershell
   git grep -n "<旧版本号>" -- . ':!package-lock.json'
   ```
   命中的每一处都要人工判断该不该跟着升（历史记录里的旧版本号该保留，锚点引用该升）。

4. **跑完三道关**
   ```powershell
   npm run typecheck
   npm test
   npm run build
   ```
   原因：CI 在 tag 上跑的是同一组命令，本地先跑一遍是为了在推 tag 之前发现问题 ——
   tag 已经推上去再发现测试挂了，就得删 tag 重打，远端会留下一个失败的发布记录。
   任何一道失败就停下修，不要带着失败的测试打 tag。

5. **提交并推送 `main`**
   用**显式文件列表** `git add <文件...>`，不要用 `git add -A` —— 后者会把工作区里所有
   未跟踪的东西一起扫进发版提交（本仓的 `.minimax/skills/release/` 就属于这类）。
   原因：发版提交是给用户装镜像的，任何夹带的内容都会跟着这个版本号出去。
   本仓需要入库的文件固定是这 6 个：`package.json`、`package-lock.json`、`README.md`、
   `AGENTS.md`、`web/app.js`、`web/index.html`；release 技能目录本身是否入库由用户定，
   要入库就显式 `git add .minimax/skills/release`（入库前确认里面没有密钥或本地配置）。
   提交信息带上版本号，沿用仓库历史风格（如 `feat(pool): 支持…（v0.7.5）`）。
   推 main 会触发一次临时镜像构建（`main-<sha>`），不覆盖 `latest`。

6. **打 tag 并推送 —— 这一步才叫发版**
   ```powershell
   git tag -a v<目标版本> -m "v<目标版本>"
   git push origin v<目标版本>
   ```
   推完后 CI 自动完成：类型检查 → 单元测试 → 构建镜像 → 推送 GHCR，产出
   `ghcr.io/goldtest/mmmcode:<版本>` 与 `ghcr.io/goldtest/mmmcode:latest`。
   用 `gh run list --limit 5` 确认「Build & Push Docker Image」跑成 success。
   注意 tag 与 main 指向同一个提交，所以 CI 会跑两遍（tag 触发 + main 触发），两遍都该绿。

7. **收尾**
   汇报：目标版本号、已推的 tag、CI 状态、可用镜像标签。
   npm 包按用户要求处理：用户明确要求时先 `npm whoami` 确认已登录，再 `npm publish`；
   未登录或用户没要求就跳过，并说明跳过原因。

## Output contract

一段可核对的发布小结，包含：

- 目标版本号与对应的 tag 名
- 三道关的结果（typecheck / test / build）
- 已推送的 commit 与 tag
- CI 运行结果与产出的镜像标签（`<版本>` 与 `latest`）
- npm 包发或未发，以及原因

## Failure handling

- **三道关任一失败**：停下来修，不打 tag。修完重跑全量三道关（不要只补跑失败那一道）。
- **tag 已存在**（本地或远端）：不要 force 覆盖。先查清是重复发版还是上一版打错 ——
  `git ls-remote --tags origin` 看远端实况，再决定是换版本号还是走回滚流程。
- **push 失败**：网络问题重试即可。tag 用 force push 会让远端历史与本地对不齐，风险大于收益。
- **CI 失败**（镜像没发出来）：修好后删 tag 重打 ——
  `git tag -d vX.Y.Z` + `git push --delete origin vX.Y.Z`，再走一次打 tag 流程。
  注意这会让旧 tag 失效，且 GHCR 上已推送的旧 tag 未必能被删除。
- **用户中途反悔**：在推 tag 之前都还能安全改版本重来；推了 tag 之后就只能走回滚流程。

## Windows (win32) platform notes

- 上面所有 git / npm / node 命令跨平台，PowerShell 里直接用。
- 仓库工作区是 **CRLF** 行尾。改文件时保持 CRLF —— 用会重写整个文件行尾的工具会产生
  与内容无关的巨大 diff。版本同步脚本已按原文件行尾写回，不需要额外处理。
- 查远端 tag：`git ls-remote --tags origin`；查 CI：`gh run list --limit 5`。
- 读文件内容优先用 Read / Edit 工具，而不是 `Get-Content`（Windows PowerShell 5.1 的
  `Get-Content` 默认按系统 ANSI 代码页读 UTF-8，中文会乱码）。

## Examples

**Input**：发版

**Output**：确认目标版本 `0.7.6` → 同步版本引用 → typecheck/test/build 全绿 →
提交 `chore: … (v0.7.6)` 推 main → 打并推 `v0.7.6` → CI 产出
`ghcr.io/goldtest/mmmcode:0.7.6` 与 `:latest` → 汇报，npm 包未发（用户未要求）。

**Input**：打个 tag 0.8.0

**Output**：目标版本直接用 `0.8.0`（不再 bump）→ 其余步骤同上，tag 为 `v0.8.0`。
