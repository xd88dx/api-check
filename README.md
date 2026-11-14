# api-check

上游渠道可用性管理面板。管理多个 LLM API 渠道（Base URL + 密钥），探测协议端点、拉取模型目录、执行「密钥×模型」实测矩阵。

> 本仓库处于 **M1 骨架**阶段，详见 `docs/SPEC.md` 与 `docs/ACCEPTANCE.md`。

## 技术栈

- Node ≥ 20 + TypeScript（strict）+ pnpm
- 后端：Express 5 + zod + 自写 logger + 原子落盘 store
- 前端：React 19 + Vite + react-i18next（原生 CSS）
- 测试：vitest

## 快速开始

```
pnpm install
pnpm build
pnpm test
```

启动面板：

```
start.bat
```

或：

```
pnpm build
pnpm start
```

## 目录结构

```
server/   后端（入口 server/index.ts，静态托管 web/dist）
web/      前端（Vite + React）
data/     运行数据（gitignore，含真实 key）
docs/     规格与验收清单
```

## 安全

- key 明文只存在于 `data/` 与进程内存，所有出口经 `mask()` 处理。
- `data/` 已加入 `.gitignore`。
