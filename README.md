# pi-forge

基于 [pi SDK](https://github.com/earendil-works/pi-mono) 的多租户 agent 平台底座。仓库组织参考 [claude-quickstarts](https://github.com/anthropics/claude-quickstarts)：一套通用基础设施，加上一组按业务划分、可独立验证的 agent。

```
            HTTP / SSE                     JSON-RPC over stdio
 web (React) ──────────► gateway (Go) ◄──────────────────────► runtime (TS, pi-sdk)
                         认证 · 租户 · 准入                        AgentSession · 工具 · skills
                         审批 · 超时 · 审计                        pi SessionManager (JSONL)
```

| 目录 | 职责 |
|---|---|
| [`gateway/`](gateway) | Go。HTTP API、API Key → 租户身份、agent 访问控制、工具调用决策（allow / ask / deny）、人工审批、并发配额、超时、审计日志；负责拉起并守护 runtime 进程 |
| [`runtime/`](runtime) | TS。用 pi-coding-agent SDK 执行 run：加载 agent 定义、构建 AgentSession、流式事件回传；会话存储完全复用 pi 官方的 SessionManager 与 auto-compaction |
| [`agents/`](agents) | 业务 agent，每个目录一个，声明式定义（`agent.json` + `prompt.md` + 可选 `tools.ts` / `skills/`） |
| [`web/`](web) | React + Vite 对话验证台：选择 agent、会话管理、流式输出、工具卡片、审批按钮 |
| [`docs/`](docs) | [架构](docs/architecture.md)、[IPC 协议](docs/ipc-protocol.md) |

## 快速开始

需要 Go ≥ 1.23、Node ≥ 22。

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
| GET | `/v1/sessions` | 用户的全部会话（跨 agent，每项带绑定的 `agentId`） |
| GET / DELETE | `/v1/sessions/{session}` | 会话记录 / 删除 |
| PATCH | `/v1/sessions/{session}` | `{"name"?, "pinned"?}`：重命名（pi `session_info` 条目，运行中的会话返回 409）/ 置顶（用户级偏好 `pins.json`） |
| GET | `/v1/sessions/{session}/artifacts` | 会话的 HTML 页面版本列表 |
| GET | `/v1/sessions/{session}/artifacts/{revision\|latest}` | 某个版本，JSON（`html` 字段），从不以 text/html 返回 |
| POST | `/v1/runs` | `{"agentId","sessionId?","text","model?","thinkingLevel?","stream?"}`，默认返回 SSE |
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

## 图片生成与编辑（OpenRouter）

在 `.env` 中单独配置图片接口，密钥不发送到浏览器：

```dotenv
PI_IMAGE_URL=https://openrouter.ai/api/v1/images
PI_IMAGE_API_KEY=你的OpenRouter密钥
PI_IMAGE_MODEL_ID=你的图片模型ID
PI_IMAGE_MODEL_IDS=另一个图片模型ID,第三个图片模型ID
```

重启服务，选择「电商详情页」，在输入框左下方选择已注册图片模型。右侧原有模型仍是负责理解需求、调用工具的聊天模型。输入生成要求，或上传参考图并描述编辑目标；`generate_images` 默认需要审批，批准后才发起付费请求。生成结果复用轮播、预览、下载及会话历史。仅列出环境变量允许的模型，不会把平台所有模型自动开放。

接口使用 OpenRouter 专用 `POST /api/v1/images`，编辑通过 `input_references` 的 data URL 提供本会话资产；不是 `/images/generations` 或 `/images/edits`。可用模型及能力见 https://openrouter.ai/api/v1/images/models ，协议见 https://openrouter.ai/docs/guides/overview/multimodal/image-generation 。模型需支持所选比例、图片数量和参考图；兼容性错误如实返回，不自动降级或重试。

### 电商详情页工作流

参考 [1click-ecom-detailpage](https://github.com/coolqoo/1click-ecom-detailpage) 的购买驱动诊断、购买理由卡、视觉风格锁和逐屏提示词流程，按本服务的工具能力重新编写提示词，未直接安装其脚本或复制完整 Skill。默认中文、5 张详情图规划，整组通过一次工具审批后并行生成，不强制先出首屏样张；仅用户要求时分阶段确认，超过单次 10 张时分批调用并分别审批；面向海外市场时按目标语言本地化。缺少真实评价或对比证据时改用产品细节或 FAQ，不沿用参考项目的模拟评价/数据默认行为。

界面显示名为「电商详情页」，内部 ID 保留 `image-designer`，兼容已有会话和图片模型选择。交付为详情分屏图片，不是 HTML 网页。修改定义后重启服务；旧会话沿用历史上下文，新会话更适合使用新流程。

首版非流式，图片请求最多等待 240 秒，电商详情页每轮总超时为 3 小时（含审批等待）。每轮累计最多请求 30 张、单次最多 10 张，更多分批；失败的已发出请求同样占用预算。上传和参考图最多 20 张，单张 4 MiB、附件合计 80 MiB，超限明确失败，不自动压缩；已完成生成仍可能产生费用。停止通过 AbortSignal 断开请求，不保证供应商停止计算。图片费用尚未合并进聊天 token 用量显示。不会自动重试生成，但 Agent 是否再次调用仍由模型决定，重复审批时应检查参数。

尚未配置真实 OpenRouter 密钥进行生图验收，自动测试使用兼容服务测试桩。此前 Magpie 实测报错找不到配置的图片模型，现不再依赖 Magpie 或 MCP。
