# api-check

上游渠道可用性管理面板。管理多个 LLM API 渠道（Base URL + 密钥），自动探测协议端点（OpenAI / Responses / Anthropic / Gemini）、拉取模型目录、执行「密钥×模型」实测矩阵，结果持久化并可导出。

纯测试与管理面板，不含转发网关：不做请求转发、路由分组、余额记账、多用户。

## 技术栈

- Node ≥ 20 + TypeScript（strict）+ pnpm
- 后端：Express 5 + zod + 自写 logger + 原子落盘 store
- 前端：React 19 + Vite + react-i18next（中英双语，原生 CSS）
- 测试：vitest

## 快速开始

```bash
pnpm install
pnpm build     # tsc 编译 server + vite 构建 web
pnpm start     # 单进程托管 API + web/dist，默认 http://localhost:3000
```

Windows 下也可直接双击 `start.bat`（内部执行 build + start）。

开发模式：`pnpm dev`（tsx watch 后端 + Vite dev 代理 API）。测试：`pnpm test`（vitest）、`pnpm typecheck`、`pnpm i18n:audit`（i18n 孤儿键/裸文案审计）。

环境变量：`PORT`（默认 3000）。

## 数据目录（`data/`）

运行时自动创建，已 gitignore，**含真实 key，切勿入库或外传**：

| 文件 | 内容 |
|---|---|
| `channels-config.json` | 配置态：渠道（name/baseUrl/insecure/enabled）、密钥（label/**key 明文**/enabled/concurrency）、模型勾选集、测试默认值 |
| `channels-state.json` | 状态态：各协议探测结果、目录拉取时间、矩阵结果（逐格分类/耗时/HTTP 状态）、任务快照 |
| `logs/start.log` | 启动与运行日志（追加写） |

- 配置态与状态态二分：删渠道时两者同步清理；重启进程后全量恢复。
- **key 明文只存在于 `channels-config.json` 与进程内存**。其余一切出口（API 响应、日志、导出文件、前端展示）均经 `mask()` 处理（形态 `sk-84…GVEQJ`），导出 JSON 连掩码与 key id 都不含（矩阵结果列以密钥备注 label 呈现）。
- 备份即备份这两个 JSON；迁移 = 拷走整个 `data/` 目录。

## 常见排查

- **端口被占用**：启动报 `EADDRINUSE` 时改用其他端口：`PORT=3199 pnpm start`（或 Windows `set PORT=3199`）。
- **探测全部失败**：先检查 Base URL 协议形态——OpenAI 兼容地址需**已含 `/v1`**（如 `https://api.example.com/v1`），Anthropic/Gemini 地址结尾的 `/v1` 会被自动剥去再拼 `/v1/messages`、`/v1beta/models`；尾部多余 `/` 无影响。协议探测行会展示每协议实际尝试的完整 URL，对照上游文档核对。
- **矩阵被拒（提示先探测）**：矩阵走「探测为可用的第一个协议」发请求，至少一个协议探测为「可用」后才能启动；探测/目录/矩阵三者同一渠道互斥，有后台任务运行中再发起会返回 409。
- **恢复后任务显示已停止**：进程重启会中断所有后台任务并把运行快照折算为 stopped，已完成格保留，重跑即可。

## 目录结构

```
server/   后端（入口 server/index.ts，静态托管 web/dist）
web/      前端（Vite + React + react-i18next）
scripts/  i18n_audit.mjs 审计脚本
data/     运行数据（gitignore，含真实 key）
docs/     SPEC.md 规格与 ACCEPTANCE.md 验收清单
```
