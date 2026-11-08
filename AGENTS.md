# AGENTS.md

给 AI 编码助手（及本仓库贡献者）的**工作约定**。

本项目是 MiniMax Code 的本地反代 + 多账号管理服务：协议翻译、凭证生命周期、
自动换号调度、Web 管理页。改动会直接影响 SSE 帧形状、换号逻辑与凭证安全，
请按下面的约定行事。

---

## 仓库概览

| 目录 | 作用 |
| --- | --- |
| `src/` | TypeScript 源码（反代、账号池、凭证、管理 API、Web 服务） |
| `web/` | 管理页静态资源（原生 JS/CSS，无构建步骤） |
| `scripts/` | 构建辅助脚本（如 `copy-web.mjs`） |
| `.github/workflows/` | CI（`ci.yml`）与镜像发布（`docker.yml`） |

常用命令：

```bash
npm run typecheck   # tsc 类型检查
npm test            # vitest 单元测试
npm run build       # 编译到 dist/ 并复制 web 静态资源
```

---

## ⚠️ 版本管理与发布流程

### 唯一原则：**Git tag 是版本的唯一真相**

**推远端 ≠ 发版。** 日常开发只推 `main` 分支，CI 会跑测试并构建一个
`main-<sha>` 的**临时镜像**（不覆盖 `latest`）。只有推送 `vX.Y.Z` 形式的
tag 才会发布正式镜像。

### 标准发布流程

```bash
# 1. 改 package.json 的 version，与 tag 对齐（v0.5.3 ↔ "version": "0.5.3"）
# 2. 提交并推送 main
git add -A && git commit -m "..." && git push origin main

# 3. 打 tag 并推送 —— 这一步才会真正发布镜像
git tag -a v0.5.3 -m "v0.5.3"
git push origin v0.5.3
```

推送 tag 后，`.github/workflows/docker.yml` 自动完成：
类型检查 → 单元测试 → 构建镜像 → 推送到 GHCR。

产出的镜像标签：

```
ghcr.io/goldtest/mmmcode:0.5.3        ← 正式版（由 tag 触发）
ghcr.io/goldtest/mmmcode:latest       ← 指向最新正式版
ghcr.io/goldtest/mmmcode:main-<sha>   ← 推 main 时的临时构建
```

### 部署方式（用户的实际用法）

用户**通过镜像部署**，不通过 npm 安装：

```bash
docker compose pull && docker compose up -d
```

`docker-compose.yml` 默认使用 `ghcr.io/goldtest/mmmcode:latest`。
要固定版本就把 `image` 改成具体版本标签（如 `ghcr.io/goldtest/mmmcode:0.5.3`）。

### 推 tag 前的检查清单

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 全部通过
- [ ] `npm run build` 成功
- [ ] `package.json` 的 `version` 已更新，且与 tag 一致
- [ ] `README.md` 中有本次改动的用户可见说明（若涉及）

---

## 🚫 构建产物不入库

**`dist/` 不进版本库**（已在 `.gitignore` 中）。

理由：
- `dist/` 由 `npm run build` 生成，CI 在**镜像内从源码重新编译**，
  入库产物毫无用处；
- 入库的产物会随源码漂移，污染 `git diff`、制造无意义的冲突；
- 版本由 Git tag 追溯，产物不需要入库备份。

同理，`node_modules/`、`.env`、`*.local.json`（管理密钥、令牌）也一律不入库。

> 本地 `dist/` 可以保留（`.gitignore` 只影响 Git 跟踪，不删除文件），
> 但**不要手动 `git add -f dist`**。

---

## 代码约定

### 安全红线

- **绝不回显令牌**。管理 API 的账号视图（`accountView`）只能返回脱敏信息。
- **绝不提交密钥**。管理密钥、账号令牌、refresh token 只落在
  `~/.waygate/`（容器内是 `/data/.waygate` 卷）里。
- 登录态/凭证相关代码改动前，先读 `src/credential.ts` 的注释 —— 那里的
  「凭证互斥」「刷新自愈」逻辑很微妙，改错了会静默丢号。

### 改动纪律

- **先读再改**：改动前读周边代码，沿用既有风格与注释密度（本仓库注释偏多，
  解释的是「为什么」而非「做了什么」）。
- **改动要配测试**：`src/*.spec.ts` 是回归网。新增功能必须补测试，
  尤其是账号池、凭证、协议翻译这几个核心模块。
- **别改调度语义**：调度模型是「优先级分层 + 额度冻结 + session 绑定」，
  同层账号**随机分配**。展示顺序（如账号卡片排序）**不等于**调度优先级，
  不要把两者混为一谈。
- **网页端是原生 JS**：`web/` 下无构建步骤、无框架。保持同样的风格，
  不要引入构建工具或依赖。

### 注释风格

用中文注释，重点解释**为什么这么设计**、以及**踩坑点**，例如：

```ts
/* 为什么要有它：--max-old-space-size 让 V8 在**触及上限前**主动 GC，
   而不是任由堆无限膨胀直到进程被 OOM-kill。 */
```

---

## 验证清单

提交前跑完这三项，CI 也会跑同样的三道关：

```bash
npm run typecheck
npm test
npm run build
```

改动 `web/` 时额外确认：管理页能正常加载、账号卡片能渲染、
登录/授权流程能走通（改前端逻辑容易漏掉边界情况）。

---

## 常见任务速查

| 任务 | 做法 |
| --- | --- |
| 改反代/调度/凭证逻辑 | 先读 `src/pool.ts`、`src/credential.ts` 顶部注释，改完补 `*.spec.ts` |
| 改管理页 UI | 改 `web/app.js` / `web/style.css`，别引入构建步骤 |
| 新增管理 API | 在 `src/admin-api.ts` 加路由 + 更新文件头的路由表注释 + 补 `admin-api.spec.ts` |
| 发版 | 改 `package.json` version → 推 main → 打 `vX.Y.Z` tag 并推送 |
| 回滚发版 | 删 tag 后重新打：`git tag -d vX.Y.Z && git push --delete origin vX.Y.Z` |
