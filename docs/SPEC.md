# api-check — 上游渠道可用性管理面板 · 功能规格（SPEC）

> 本文档是 OpenCode 的执行合同。规格与红线冲突时以红线为准；发现规格不可实现或自相矛盾时**停下来问**，不要自行发明替代设计。每批（M1→M4）完成后停下报告，验收通过才进下一批。

## 1. 定位

管理多个 LLM API 渠道（Base URL + 密钥），自动探测协议端点、拉取模型目录、执行「密钥×模型」实测矩阵，结果持久化并可导出。

**纯测试与管理面板，不含转发网关。** 明确不做：请求转发、路由分组、余额记账、渠道图标、多用户/权限。凡是让本工具变成「网关」的想法一律砍掉。

## 2. 技术栈与仓库结构

- Node ≥ 20 + TypeScript（strict），包管理器 pnpm。
- 后端 `server/`：Express 5 + zod 校验 + 自写轻量 logger（console + 追加写 `data/logs/start.log` 双输出）。
- 前端 `web/`：React 19 + Vite + react-i18next，**原生 CSS**（不上 Tailwind/UI 组件库）。
- 测试 vitest（后端为主；探测/编排/落盘必须有单测）。
- 生产形态：`pnpm build`（tsc + vite build）后由 server 单进程静态托管 `web/dist`；开发时 Vite dev + API 代理。
- 仓库结构（pnpm workspace，server 在根）：

```text
api-check/
├─ package.json / pnpm-workspace.yaml / tsconfig*.json
├─ server/
│  ├─ index.ts          # 入口：装配、静态托管、start.bat 调用
│  ├─ store.ts          # 渠道配置/状态读写、原子落盘
│  ├─ mask.ts           # key 掩码（唯一实现点）
│  ├─ logger.ts
│  ├─ probe.ts          # 四协议探测
│  ├─ catalog.ts        # 模型目录拉取
│  ├─ runner.ts         # 矩阵测试编排器（队列/间隔/中断）
│  └─ routes.ts         # REST API
├─ web/src/…            # React 页面 + i18n/
├─ docs/                # SPEC.md、ACCEPTANCE.md（不得改动）
├─ data/                # 运行数据（gitignore，含真实 key）
└─ start.bat
```

单文件 ≤ 500 行，超出必须拆模块（这是验收硬判据，防巨型文件）。

## 3. REST API（全部 `/api` 前缀，JSON）

- `GET/POST /api/channels`、`PUT/DELETE /api/channels/:id`（删除需前端二次确认）
- `PUT /api/channels/:id/keys`（整表替换：增/删/启停/并发/label）
- `PUT /api/channels/:id/models`（勾选集与手动添加）
- `POST /api/channels/:id/probe`（四协议探测，后台任务）
- `POST /api/channels/:id/catalog`（拉模型目录，后台任务）
- `POST /api/channels/:id/test`（启动矩阵，body：`{ modelIds?, keyIds?, intervalMs?, timeoutMs? }`）
- `POST /api/test/stop`、`GET /api/channels/:id/task`（进度轮询）
- `GET /api/channels/:id/export`（`Content-Disposition` 附件下载）

任务模型：**单渠道同一时刻只允许一个后台任务**（探测/目录/矩阵互斥），占用中再发起返回 409。前端一律轮询（200ms 起、退避到 1s），不上 SSE/WebSocket。

## 4. 协议探测规格

四协议、每协议发**一次最小真实请求**（无目录时 model 用 `gpt-4o-mini` 占位）：

| 协议 | URL 拼接（baseUrl 归一化） | 请求 |
|---|---|---|
| OpenAI | `{base}/chat/completions`（base 已含 `/v1`） | POST `{model, messages:[{role:"user",content:"ping"}], max_tokens:1, stream:false}` |
| Responses | `{base}/responses` | POST `{model, input:"ping", max_output_tokens:16}` |
| Anthropic | `{base 去尾 /v1}/v1/messages` | POST，头 `x-api-key` + `anthropic-version: 2023-06-01`，`{model, max_tokens:1, messages:[…]}` |
| Gemini | `{base 去尾 /v1}/v1beta/models` | GET，`?key=` 或头 `x-goog-api-key` |

规则：baseUrl 尾部 `/` 去掉；「去尾 /v1」只剥**结尾**的 `/v1`（大小写敏感、仅一次）。探测行 UI 必须展示每协议实际尝试的完整 URL。


## 5. 数据模型与持久化

两个文件、原子写（tmp + rename，写前 fsync）、启动全量恢复：

- `data/channels-config.json`（配置态）：
  - `channels[]`: `{ id, name, baseUrl, insecure, enabled, createdAt }`
  - `channels[].keys[]`: `{ id, label, key(明文), enabled, concurrency(默认1), createdAt }`
  - `channels[].models[]`: `{ id, selected, source(catalog|manual), contextHint? }`
  - 设置：`testDefaults: { intervalMs(默认1000), timeoutMs(默认60000) }`
- `data/channels-state.json`（状态态）：
  - `channels[id].probe`: 各协议 `{ url, cls, latencyMs, httpStatus, rawSnippet, at }`
  - `channels[id].catalogAt`、`channels[id].lastTestAt`
  - `channels[id].results[modelId][keyId]`: `{ cls, latencyMs, httpStatus, rawSnippet, at }`
  - 任务运行快照 `{ running, stopped, currentIndex, total }`

规则：key 明文只存在于 config 文件与内存；其余一切出口（日志/API/前端/测试）见 mask()。`data/` 整目录进 `.gitignore`。手动添加的模型（source=manual）永不被目录同步删除；目录同步**只增不删**已勾选项。

## 6. 错误分类（全局唯一实现点，探测与矩阵共用）

| cls | 判定 | UI 颜色 | 语义 |
|---|---|---|---|
| `ok` | HTTP 2xx 且响应体含模型回复/模型列表迹象 | 绿 | 可用 |
| `unsupported` | HTTP 404（或 Gemini 404/400 endpoint not found） | 红 | 端点/路径不存在 |
| `auth` | HTTP 401 / 403 | 红 | 端点存在，凭据无效 |
| `rate_limited` | HTTP 429（含 403 但 body 明示 quota/rate 的兜底可后议） | **黄** | **限流≠不可用**，端点与凭据均有效 |
| `timeout` | 按静默时长超时（默认 60s 可配） | 灰 | 未定，待复测 |
| `error` | 其余（5xx/网络/解析失败） | 红 | 附 rawSnippet |

硬性规则：① 分类判定只看 HTTP 状态码与响应体片段，**禁止**对 message 文案做关键词猜测（除上表明确项）；② `rawSnippet` 保存上游错误原文前 300 字符，原样透传展示，**绝不翻译/改写**；③ 429 绝不参与「只选可用」的剔除。

## 7. 模型目录

- OpenAI/Responses：`GET {base}/models`（Bearer）。
- Anthropic：`GET {base 去尾/v1}/v1/models`（`x-api-key` + `anthropic-version`）。
- Gemini：`GET {base 去尾/v1}/v1beta/models`（分页 `pageSize` 尽量拉全，返回 `models[]` 中 `supportedGenerationMethods` 含 `generateContent` 的条目）。
- 拉取失败或返回空：**明确报错并保留现有目录**，绝不报「刷新成功 0 个模型」的假成功；已勾选项不受影响。
- chips UI：显示模型名 + `contextHint`（目录若带 context window 字段则展示，无则不显示，**不猜**）；支持手动添加模型、单个删除（仅 manual 来源可删）、全选/全不选/只选可用；「供应商列表：N 分钟前」时间戳 + 重新获取按钮。
- 优先用**探测成功的协议**拉目录；多协议可用时按 openai → anthropic → gemini 顺序取第一个成功者。

## 8. 矩阵测试编排器（runner）

- 维度：**行 = 已选模型，列 = 已启用密钥**；单元格 = 用该密钥对该模型经「渠道主协议」发一次最小请求（同 §4 OpenAI/Anthropic 形态，`max_tokens:1`），按 §6 分类。
- 主协议 = 探测 `ok` 的第一个协议（顺序 openai → responses → anthropic → gemini）；全部非 ok 时拒绝启动矩阵并提示先探测。
- **全局串行队列**：同一渠道同一时刻一个任务；请求间强制间隔 `intervalMs`（默认 1s，验收场景配 12000——crow 免费层 5rpm）；单请求按**静默时长**超时（头到了但 body 挂住同样计时），`timeoutMs` 默认 60s。
- 进度：`{ running, stopped, current: {modelId, keyId, index, total} }`，轮询获取；`POST /api/test/stop` 中断后当前请求允许完成、队列清空、状态落 `stopped: true`。
- 结果逐格写入 state 并落盘（每格完成即 flush，不积攒）；结果行 UI 实时刷新。
- 每格展示：分类色块 + 耗时（<1000ms 显示 `NNN ms`，否则 `N.N 秒`）+ 错误码 + rawSnippet 悬浮提示。
- 「只选可用」：按最近一次矩阵结果将 `ok` 模型勾选、其余取消勾选，**预览 diff 后一键应用**（不静默改配置）；429 模型视为可用保留。

## 9. i18n 规格

- `web/src/i18n/zh.ts` + `en.ts`：key → 文本字典（扁平命名空间，如 `channel.title`、`matrix.cls.ok`）；react-i18next；顶栏语言切换 + localStorage 持久化（默认跟随浏览器，无则 zh）。
- 三条纪律：① 面板自身文案**全部**走字典键，组件里不得出现裸英文句子（模型名/协议名/HTTP 状态等数据除外）；② 上游错误原文（rawSnippet）原样展示永不翻译；③ 错误分类的**语义标签**（如「限流」/Rate limited）走 `matrix.cls.*` 字典键，颜色只由 cls 决定。
- 交付前自跑一次审计脚本（提供 `scripts/i18n_audit.mjs`，扫描组件内裸英文文本与字典孤儿键，输出清单；M4 验收要求清零或逐条说明豁免）。

## 10. 安全与红线（OpenCode 硬约束，违反即打回）

1. **key 明文只许出现在 `data/`（gitignored）与进程内存**；代码、测试、文档、日志、API 响应出现明文即打回——所有出口过 `mask()`（形态 `sk-84…GVEQJ`：前 5 + `…` + 后 5，不足 12 字符全掩码）。
2. 测试与代码中一律用占位符（如 `sk-test-0000…`）或本地 mock 上游，**严禁**把任何真实凭据写进仓库。
3. git：允许本地 `add/commit`（每批一次、message 规范），**严禁 push**；不得改写历史。
4. 依赖白名单：express、zod、react、react-dom、react-i18next、vite、@vitejs/plugin-react、typescript、vitest、 necessary @types/*。新增任何依赖必须先问。
5. 行尾：`.gitattributes` 全 LF（`*.bat` CRLF 例外）+ `.editorconfig`；不得改动 `docs/` 两份任务书。
6. `insecure` 仅作用于该渠道的探测/目录/矩阵请求（自签证书场景），面板上带警示文案。

## 11. 里程碑与交付物

| 批 | 交付物 | 完成判据 |
|---|---|---|
| M1 骨架 | 仓库初始化（.gitattributes/.editorconfig/.gitignore/README 骨架）、server 骨架（装配/store/mask/logger/渠道与密钥 CRUD API/原子落盘）、web 骨架（Vite+React+i18n 双语+切换、渠道列表/编辑、密钥管理 UI）、start.bat、store 与 mask 的 vitest | 面板可建渠道/加 key/重启恢复；`pnpm build && pnpm test` 全绿 |
| M2 探测 | probe.ts 四协议探测器、catalog.ts、协议探测行 UI（含实际 URL 展示）、模型 chips 管理、本地 mock 上游（测试用，含五分类各一例） | mock 源五分类全对；目录拉取成功/失败两路正确 |
| M3 矩阵 | runner.ts 编排器、矩阵 UI、进度轮询、结果持久化、只选可用（预览 diff）、scripts/i18n_audit.mjs | mock 验证串行/中断/静默超时/429 黄色；i18n 审计可跑 |
| M4 收尾 | 导出 JSON、crowllm 真源联调修正、i18n 审计清零、README（部署/排查/数据目录说明）、全流程打磨 | 真源全流程一次通过 + ACCEPTANCE M4 清单全绿 |

每批完成：自跑 build+test 全绿 → 本地 commit（`feat(m1): …` 风格）→ 停下报告等待验收。**验收不过的批按 ACCEPTANCE 缺陷清单返工，返工轮次不限。**

## 12. M5 改进批次（2026-11-14 用户需求增补）

1. **矩阵测试次数与连通率**：矩阵区新增「测试次数」设置（1–10，默认 1，持久化至 `testDefaults.repeat`）。每格串行执行 N 次（全局串行队列与 intervalMs 不变）。**连通率 = count(cls ∈ {ok, rate_limited}) / N**。色块：连通率 ≥50% 绿；0<r<50% 黄；=0 且全部 timeout 灰；=0 其余红。格内展示 `2/3 · 可用`（主 cls 取最后一次非失败结果，全失败取最后一次）；N=1 时单元格形态与旧版一致。多次明细（每次 cls+耗时）放入单元格 tooltip。
2. **矩阵列头**：密钥列头显示 `密钥 <label>`（en: `Key <label>`），不再裸显 label。
3. **模型目录关键字过滤**：目录区新增过滤输入框，客户端实时过滤（大小写不敏感子串）；过滤不影响勾选状态、手动添加与目录重取。
4. **区块顺序**：编辑页自上而下 = 基本信息 → 密钥管理 → 模型目录 → 协议探测 → 矩阵测试。
5. **探测可指定模型**：探测区新增可选模型输入；填入时四协议全部用该模型（单候选，不走目录候选循环）；留空 = 现状（目录首模型 + 多候选循环）。
6. **视图状态持久化**（修复「探测运行中页面跳回列表」）：View 写入 `location.hash`（`#/list`、`#/channel/<id>`），App 启动时恢复；任何整页刷新后停留原视图，任务轮询不中断。
7. **页面美化**（原生 CSS，不引框架/UI 库）：CSS 设计 token（色板/间距/圆角/阴影/字体栈）；区块卡片化+轻阴影；按钮四态体系（primary/secondary/danger/ghost）；表格斑马纹+hover+分类色徽章化；chips 胶囊化；控件统一；布局 max-width 1080px 居中+窄屏响应式；双语下无布局断裂。
8. 本节所有新文案走 i18n 字典键（zh/en 同步）。





