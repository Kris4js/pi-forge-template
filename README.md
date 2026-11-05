# pi-forge

![Go](https://img.shields.io/badge/Go-00ADD8?logo=go&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)

基于 [pi SDK](https://github.com/earendil-works/pi-mono) 的多租户 agent 平台底座。仓库组织参考 [claude-quickstarts](https://github.com/anthropics/claude-quickstarts)：一套通用基础设施，加上一组按业务划分、可独立验证的 agent。

```
            HTTP / SSE                     JSON-RPC over stdio
 web (React) ──────────► gateway (Go) ◄──────────────────────► runtime (TS, pi-sdk)
                         认证 · 租户 · 准入                        AgentSession · 工具 · skills
                         审批 · 超时 · 审计                        pi SessionManager + 文件 / SQL 存储
```

| 目录 | 职责 |
|---|---|
| [`gateway/`](gateway) | Go。HTTP API、API Key → 租户身份、agent 访问控制、工具调用决策（allow / ask / deny）、人工审批、并发配额、超时、审计日志；负责拉起并守护 runtime 进程 |
| [`runtime/`](runtime) | TS。用 pi-coding-agent SDK 执行 run：加载 agent 定义、构建 AgentSession、流式事件回传；保留 pi SessionManager 条目树与 auto-compaction，支持文件、SQLite、MySQL、PostgreSQL 存储 |
| [`agents/`](agents) | 业务 agent，每个目录一个，声明式定义（`agent.json` + `prompt.md` + 可选 `tools.ts` / `skills/`） |
| [`web/`](web) | React + Vite 对话验证台：选择 agent、会话管理、流式输出、工具卡片、审批按钮 |
| [`docs/`](docs) | [架构](docs/architecture.md)、[IPC 协议](docs/ipc-protocol.md) |

## 快速开始

需要 Go ≥ 1.23、Node ≥ 22.13（SQLite 使用 Node 内置 `node:sqlite`）。

```bash
make install
cp .env.example .env        # 填写模型配置（必填），未配置模型时 runtime 拒绝启动
make dev                    # gateway :8090，自动拉起 runtime
make web                    # 另开一个终端：http://localhost:5173
```

模型在 `.env` 中注册，二选一：

```bash
# 自定义 OpenAI / Anthropic 兼容端点（界面上只显示模型 id）
PI_MODEL_PROVIDER=custom
PI_MODEL_PROTOCOL=openai-completions     # 或 anthropic-messages
PI_MODEL_BASE_URL=https://openrouter.ai/api/v1
PI_MODEL_ID=deepseek/deepseek-chat
PI_MODEL_IDS=qwen/qwen3-max,moonshotai/kimi-k2   # 可选：同一端点的其它模型，出现在输入框的模型选择器里
PI_MODEL_API_KEY=...

# pi 内置 provider（界面上显示 provider/model）
PI_MODEL_PROVIDER=anthropic
PI_MODEL_ID=claude-sonnet-5-5
ANTHROPIC_API_KEY=...
```

单个 agent 也可以在 `agent.json` 的 `model` 字段里指定自己的模型。

## 个人项目与对话存储

侧栏可创建、编辑项目，并按全部、未分组或具体项目筛选对话。项目属于当前 `workspace + userId`，包含多个独立对话；项目说明在每次运行时注入模型上下文，更新后从下一轮生效。不同对话不自动共享聊天记录。新对话绑定当前项目，已有对话保持原归属和 agent；包含对话或正在运行的项目不能删除（409）。

| 配置 | 用途 |
|---|---|
| `FORGE_STORAGE=file` | 默认值，保留原有 JSONL 和 pins.json；项目保存为用户目录下的 projects/*.json |
| `FORGE_STORAGE=sqlite` | 历史、置顶、项目写入 SQLite，默认 `.data/conversations.sqlite`，可用 `FORGE_SQLITE_PATH` 指定 |
| `FORGE_STORAGE=mysql` | 配合 `FORGE_DATABASE_URL=mysql://user:password@host:3306/database` |
| `FORGE_STORAGE=pgsql` | 配合 `FORGE_DATABASE_URL=postgresql://user:password@host:5432/database`；也接受 postgres / postgresql |

MySQL / PostgreSQL 数据库需预先创建，runtime 启动时创建 `forge_records` 表。每条记录以 workspace、user、kind、id 隔离，保存完整 pi 条目树和版本号；并发版本冲突拒绝覆盖。配置错误或数据库不可达时启动失败，不回退到文件。数据库模式不写会话 JSONL、项目 JSON 或 pins.json；附件、图片、HTML 产物和工具工作目录仍在 `FORGE_DATA_DIR`，备份时需同时保留。

切换存储不会自动导入历史。迁移步骤：停止 gateway，备份数据，在仓库根目录配置目标 `FORGE_STORAGE` 和数据库连接，然后运行：

```bash
npm run migrate:storage
```

命令导入 `FORGE_DATA_DIR` 中的 pi v3 会话、置顶及项目，保留原始条目 ID，不修改或删除源文件；重复执行跳过数据库中已有记录。失败可修复原因后重跑。完成后以相同配置启动 gateway。改回 `file` 只能看到原文件中的历史，数据库新增内容不会自动反向同步。

当前仍采用单 gateway/runtime 运行模型；数据库适配不包含跨实例 run 锁、分布式审批或附件对象存储。SDK 恢复桥接适配至 pi SessionManager 内部索引接口，升级 SDK 时必须运行恢复测试。SQLite 在部分 Node 版本会提示实验性 API。

真实数据库回归测试可配置 `FORGE_TEST_MYSQL_URL` / `FORGE_TEST_PGSQL_URL` 后运行 `npm test`；仅对专用测试数据库使用这两个变量。未配置时对应测试跳过。

## 内置验证 agent

| agent | 验证点 |
|---|---|
| `assistant` | 纯对话：流式输出、会话持久化、多轮续聊、上下文压缩 |
| `support-desk` | 自定义工具（`tools.ts`）；`search_kb` 直接放行，`create_ticket` 必须人工审批 |
| `data-analyst` | pi skills（5 个分析方法论 SKILL.md）+ `read` 内置工具的路径沙箱 + 数据查询工具 |
| `html-designer` | 改编自 [vercel-labs/fx0](https://github.com/vercel-labs/fx0)：把描述写成单个自包含 HTML 页面；右侧栏实时预览（生成中显示无脚本草稿，发布后为可交互页面）、版本切换、设备宽度、复制/下载；10 种 design.md 风格作为 pi skills |

新增 agent 的方法见 [agents/README.md](agents/README.md)。

## HTTP API

身份来自 `Authorization: Bearer <key>`；key 固定了租户，或者允许调用方通过 `X-Workspace` / `X-User-Id` 指定（见 [`config/keys.example.json`](config/keys.example.json)）。本地开发设置 `FORGE_DEV_AUTH=1` 后可以不带 key，直接用这两个 header。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/me` | 当前身份与 runtime 信息 |
| GET | `/v1/agents` | 当前身份可用的 agent |
| GET | `/v1/models` | `.env` 注册的模型（`PI_MODEL_ID` + `PI_MODEL_IDS`）与可选思考强度；run 只能用这里的模型 |
| GET / POST | `/v1/projects` | 项目列表 / 创建 `{"name","instructions?"}` |
| PATCH / DELETE | `/v1/projects/{project}` | 更新 `{"name?","instructions?"}` / 删除空项目 |
| GET | `/v1/sessions` | 用户的全部会话（每项带 `agentId`、可选 `projectId`）；可用 `?projectId=...` 筛选 |
| GET / DELETE | `/v1/sessions/{session}` | 会话记录 / 删除 |
| PATCH | `/v1/sessions/{session}` | `{"name"?, "pinned"?, "projectId"?}`：重命名 / 置顶 / 移入项目（字符串）或移出项目（`null`），下一轮起使用新项目指令；运行中不允许重命名或改项目，数据库模式下运行中置顶也返回 409 |
| GET | `/v1/artifacts` | 当前用户所有会话的最新页面（每会话一条），按可用 agent 过滤 |
| GET | `/v1/sessions/{session}/artifacts` | 会话的 HTML 页面版本列表 |
| GET | `/v1/sessions/{session}/artifacts/{revision\|latest}` | 某个版本，JSON（`html` 字段），从不以 text/html 返回 |
| POST | `/v1/runs` | `{"agentId","sessionId?","projectId?","text","model?","thinkingLevel?","stream?"}`，默认返回 SSE |
| GET | `/v1/runs/{run}/events?from=N` | 重放 / 续接事件流 |
| POST | `/v1/runs/{run}/cancel` | 取消 |
| POST | `/v1/runs/{run}/approvals/{toolCallId}` | `{"decision":"approve"\|"reject"}` |

```bash
curl -N -X POST localhost:8090/v1/runs -H 'X-Workspace: acme' -H 'X-User-Id: alice' \
  -d '{"agentId":"assistant","text":"你好"}'
```

附件通过输入框「＋ → 上传照片和文件」选择，随 `/v1/runs` 请求的 `attachments: [{name,mimeType,data}]`（原始 Base64，不含 data URL 前缀）一起发送。支持 PNG/JPEG/WebP、DOCX/PDF/XLSX/PPTX 与 UTF-8 的 txt/md/csv/json/yaml/yml/log；最多 20 个，图片及文档单个 4 MB、文本单个 100 KB、总计 80 MB。仅此路由允许 112 MiB 请求体，其他路由仍为 1 MiB。文件落入当前用户的 `attachments/<随机ID>/`；图片作为视觉输入、文本作为附件上下文交给模型。无文字时也可发送；不支持视觉的模型会拒绝图片。首版不支持扫描件 OCR、旧版 .doc/.xls/.ppt、文档在线预览/下载及附件自动清理，删除会话不会删除用户附件。图片消息支持单图展示、多图横向轮播及大图预览（方向键切换、Escape 关闭、下载）；本次起发送的图片引用会随会话持久化，刷新后可恢复。图片通过鉴权的 `GET /v1/sessions/{session}/images/{image}` 读取，不使用公开文件 URL；升级前已发送的图片不自动补建历史引用。

SSE 事件依次为：`run`（runId / sessionId）→ `run_started` → `text_delta` / `thinking_delta` / `tool_start` / `approval_required` / `approval_resolved` / `tool_end` / `message_end` / `compaction` / `artifact_draft` / `artifact` → `run_finished`（`completed | failed | cancelled | timeout`）。

## 开发

```bash
make test     # go test -race + runtime 端到端测试（真实拉起 runtime 进程，接本地 OpenAI 兼容 fake 服务，无需凭证）
make check    # go vet + tsc
make build    # bin/gateway + web/dist；FORGE_WEB_DIR=web/dist 时由 gateway 直接托管前端
```


## 文档解析依赖

文档在发送时由 Python 子进程通过 MarkItDown 0.1.5 提取文本/Markdown，直接作为本轮用户资料提供给模型；原文件与 `.md` 提取结果保存在用户附件目录，历史会话保留提取文本。前端发送等待期间禁用重复提交；解析失败显示具体错误并保留草稿，不静默忽略文件。此版本没有后台任务列表、OCR、向量检索或长文档分段读取。

本地继续使用原有命令：

```bash
make install  # 安装 npm、Go 及文档解析依赖
make dev      # 启动网关及 TS runtime
# 另一终端：make web
```

`make install` 优先使用 uv 创建 Python 3.12 环境；没有 uv 时使用系统 `python3`（需要 3.10+ 及 venv/pip）。仅单独安装文档依赖时：

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r packages/documents/requirements.txt
```

运行时自动使用根目录 `.venv/bin/python`，也可设置 `FORGE_DOCUMENT_PYTHON` 指定解释器。Docker 最终镜像改为 Debian slim 并安装隔离 Python 环境；不需要外部解析服务。未安装 Python 依赖时图片和文本附件仍可用，Office/PDF 会明确失败。测试在解释器不存在时跳过真实文档转换用例，请先安装依赖再完整验收。

每个 runtime 同时只允许一个解析子进程，繁忙时明确拒绝；单次发送全部附件解析最多 20 秒，超时杀掉子进程。单文件及本次附件提取文本合计上限 100000 字符，超限要求拆分而非截断。PDF 最多 200 页；Excel 最多 50 个工作表、100000 单元格；Office ZIP 最多 5000 项、64 MiB 声明解压体积。加密文件和带 VBA 的文件拒绝处理。Excel 不重算公式（使用已有缓存值），PPTX/复杂 PDF 不保证表格和布局还原，图片文字不做 OCR。

子进程使用最小环境、不继承 API 密钥、禁用插件及 Python socket 联网，Linux 限制 2 GiB 虚拟地址空间、CPU 30 秒。这是资源与网络访问防护，不是完整操作系统安全沙箱；公网不可信文档生产环境仍应结合容器权限/网络限制。失败时已保存的附件可能保留，暂不自动清理。
