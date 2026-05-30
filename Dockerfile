# ── 构建阶段 ──────────────────────────────────────────────────────────────────
# 关键：用 --platform=$BUILDPLATFORM 强制 builder 跑在构建机原生 arch
# （GitHub runner = amd64）。否则 buildx 多架构构建时，arm64 阶段会让 npm
# 跑在 QEMU 模拟下，Node 20 + Alpine + qemu-user-static 经常触发 SIGILL
# （exit 132）。better-sqlite3 是 native module，通过 npm_config_target_*
# 引导 prebuild-install 拉对应目标 arch 的预编译 .node 文件，所以构建过程
# 完全不依赖 QEMU 模拟。
FROM --platform=$BUILDPLATFORM node:20-alpine AS builder
ARG TARGETARCH

WORKDIR /app

# better-sqlite3 编译依赖（兜底，正常 prebuild-install 直接拉 .node）
RUN apk add --no-cache python3 make g++

# 把目标平台 / libc 钉死给 prebuild-install。
# better-sqlite3 在 npm 上有 linux + musl + {x64, arm64} 的预编译包。
ENV npm_config_target_platform=linux
ENV npm_config_target_libc=musl

# 先复制依赖清单，利用 Docker 层缓存
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/

RUN npm_config_target_arch=${TARGETARCH} npm ci && \
    npm_config_target_arch=${TARGETARCH} npm --prefix web ci

# 复制源码
COPY tsconfig.json ./
COPY src/ ./src/
COPY web/ ./web/
COPY plugins/ ./plugins/

# 构建后端 + 前端
RUN npm run build:all

# 裁剪：删除 devDeps 和编译产物
RUN npm prune --production && \
    rm -rf node_modules/better-sqlite3/deps \
           node_modules/better-sqlite3/src \
           node_modules/better-sqlite3/build/Release/obj.target \
           node_modules/prebuild-install \
           node_modules/.bin \
           node_modules/.cache && \
    find node_modules -type f -name "*.md" -delete && \
    find node_modules -type f -name "*.ts" -delete && \
    find node_modules -type f -name "*.map" -delete && \
    find node_modules -type d -name "test" -prune -exec rm -rf {} + && \
    find node_modules -type d -name "tests" -prune -exec rm -rf {} +

# ── 运行阶段 ──────────────────────────────────────────────────────────────────
# 使用 alpine 裸镜像 + nodejs，去掉 npm/yarn 等工具链
FROM alpine:3.19 AS runtime

WORKDIR /app

# nodejs 运行时 + better-sqlite3 依赖的 libstdc++
RUN apk add --no-cache nodejs libstdc++

ENV NODE_ENV=production
ENV PORT=8788
ENV MIMO2CODEX_HOST=0.0.0.0
# Containerized deployments are exposed to other people by definition, so
# auth is on by default. Override with MIMO2CODEX_AUTH=off only for trusted
# closed-network setups. See README for the bootstrap-URL flow on first run.
ENV MIMO2CODEX_AUTH=on

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/plugins ./plugins
COPY package.json ./
COPY .env.example ./.env.example

EXPOSE 8788

ENTRYPOINT ["node", "dist/cli.js"]
