# syntax=docker/dockerfile:1
#
# waygate-mmcode —— MiniMax Code 反代 + 多账号管理（统一 Web 服务）
#
# 设计要点：
#   · **多阶段构建**：编译期要 TypeScript 与全部 devDeps，运行期只要 dist + 生产依赖。
#   · **单端口**：容器只暴露 8789 —— 反代、管理页、管理 API 全在这一个端口上。
#   · **状态外挂**：`/data` 是卷，账号注册表、令牌、管理密钥都在里面；
#     容器重建不丢账号（**这是本镜像最容易踩的坑**：不挂卷 = 每次重建都要重新授权）。
#   · **非 root 运行**：不碰宿主机的 root 权限。
#   · **健康检查**：直接打 /healthz，编排层据此判断是否就绪。

# ───────────────────────── 构建阶段 ─────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# 先只拷依赖清单 —— 依赖层没变时这一步能命中缓存，改代码不用重装依赖。
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY web ./web
RUN npm run build

# ───────────────────────── 运行阶段 ─────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# ── V8 堆上限（软闸）─────────────────────────────────────────────────
# 为什么要有它：--max-old-space-size 让 V8 在**触及上限前**主动 GC，
#   而不是任由堆无限膨胀直到进程被 OOM-kill。
#   区别在于「主动 GC」是**优雅降级**（慢一点，但服务还在），
#   「被 OOM-kill」是**硬重启**（客户端全部断连）。
#
# ⚠️ 数值必须与 compose 的 mem_limit 配套考虑：
#   512m 的 cgroup 里，384m 的堆 + ~60m 的 Node 运行时/原生对象
#   ≈ 444m，再留 ~68m 给**堆外**缓冲（Buffer、undici 连接缓冲）。
#   这点余量不算宽裕 —— 所以下面的 NODE_OPTIONS 之外，
#   代码里也必须给请求体/响应体缓冲**显式上限**（见 src/proxy.ts）。
#   调大这个数很容易，调小 mem_limit 只会让 OOM-kill 来得更早。
ENV NODE_OPTIONS=--max-old-space-size=384

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# dist 里已经含静态管理页（构建阶段由 scripts/copy-web.mjs 复制进去）。
COPY --from=build /app/dist ./dist

# 状态目录：挂卷到这里。账号、令牌、管理密钥都在这儿。
ENV MMCODE_HOME=/data/.waygate
ENV WAYGATE_HOME=/data/.waygate
ENV TZ=Asia/Shanghai
RUN mkdir -p /data/.waygate \
    && addgroup -S mmcode \
    && adduser -S -G mmcode -h /app mmcode \
    && chown -R mmcode:mmcode /data /app
USER mmcode

VOLUME ["/data"]
EXPOSE 8789

# 探活：/healthz 不鉴权，只回状态。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8789/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js", "web", "--host", "0.0.0.0", "--port", "8789"]
