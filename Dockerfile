# api-check —— 上游渠道可用性管理面板
# 纯 Node（无浏览器/无原生依赖），alpine 即可；pnpm workspace（根=server，web=前端）。
#
# 构建：docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t api-check .
# 运行：docker run -d -p 3000:3000 -v ./data:/app/data -e PANEL_PASSWORD=xxx api-check

# ---------------- 编译阶段 ----------------
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/
# 全量安装（devDependencies 是构建必需：typescript/vite/vitest）
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY server ./server
COPY web ./web
COPY scripts ./scripts
RUN pnpm build

# ---------------- 运行阶段 ----------------
FROM node:22-alpine
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=3000
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# 运行期只装 server 生产依赖（express/zod）；web 的 react 等前端依赖不进运行镜像
RUN pnpm install --prod --frozen-lockfile --filter api-check && pnpm store prune
# 构建产物：server 编译输出（dist/）+ 前端静态资源（web/dist，由 index.ts 静态托管）
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /app/data

EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
