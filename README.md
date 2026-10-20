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
| GET | `/v1/sessions` | 用户的全部会话（跨 agent，每项带绑定的 `agentId`） |
| GET / DELETE | `/v1/sessions/{session}` | 会话记录 / 删除 |
| PATCH | `/v1/sessions/{session}` | `{"name"?, "pinned"?}`：重命名（pi `session_info` 条目，运行中的会话返回 409）/ 置顶（用户级偏好 `pins.json`） |
| GET | `/v1/sessions/{session}/artifacts` | 会话的 HTML 页面版本列表 |
| GET | `/v1/sessions/{session}/artifacts/{revision\|latest}` | 某个版本，JSON（`html` 字段），从不以 text/html 返回 |
| POST | `/v1/runs` | `{"agentId","sessionId?","text","stream?"}`，默认返回 SSE |
| GET | `/v1/runs/{run}/events?from=N` | 重放 / 续接事件流 |
| POST | `/v1/runs/{run}/cancel` | 取消 |
| POST | `/v1/runs/{run}/approvals/{toolCallId}` | `{"decision":"approve"\|"reject"}` |

```bash
curl -N -X POST localhost:8090/v1/runs -H 'X-Workspace: acme' -H 'X-User-Id: alice' \
  -d '{"agentId":"assistant","text":"你好"}'
```

SSE 事件依次为：`run`（runId / sessionId）→ `run_started` → `text_delta` / `thinking_delta` / `tool_start` / `approval_required` / `approval_resolved` / `tool_end` / `message_end` / `compaction` / `artifact_draft` / `artifact` → `run_finished`（`completed | failed | cancelled | timeout`）。

## 开发

```bash
make test     # go test -race + runtime 端到端测试（真实拉起 runtime 进程，接本地 OpenAI 兼容 fake 服务，无需凭证）
make check    # go vet + tsc
make build    # bin/gateway + web/dist；FORGE_WEB_DIR=web/dist 时由 gateway 直接托管前端
```
