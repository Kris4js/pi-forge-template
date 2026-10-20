# 架构

## 进程模型

```
gateway (Go, 1 个进程)
 ├─ HTTP server              认证 → 授权 → 准入 → 启动 run → SSE
 ├─ runs.Manager             run 状态、事件日志、审批、超时、审计
 └─ ipc.Supervisor ── stdin/stdout ──► runtime (Node + tsx, 1 个子进程)
                                         ├─ Runner：每个 run 一个 pi AgentSession，结束即 dispose
                                         ├─ governance 扩展：pi tool_call 钩子 → 沙箱 → tool.authorize
                                         └─ pi SessionManager：JSONL 会话文件
```

- **gateway 是唯一入口**。runtime 不监听端口，只通过 stdio 和 gateway 通信，stdout 专用于协议（SDK 或工具的 `console.log` 会被重定向到 stderr，再转进 gateway 日志）。
- **runtime 不持有租户状态**。会话状态都在 pi 的 JSONL 文件里，每个 run 从文件重建 AgentSession，结束后释放。因此 runtime 可以随时重启：gateway 的 Supervisor 检测到退出后按退避重启，在途 run 统一以 `failed` 结束。
- 一个 runtime 进程可以并发执行多个 run（全是异步 I/O）。以后要横向扩展，可以在 Supervisor 层改成进程池，按 `workspace` 做哈希分配，协议不用变。

## 职责边界

| 关注点 | 位置 | 说明 |
|---|---|---|
| 认证 | `gateway/internal/auth` | API Key（sha256 后常量时间比较）→ Principal{tenant, roles} |
| 租户规范化 | `gateway/internal/tenant` | workspace / user 统一规范成安全的路径段；runtime 端 `tenant.ts` 只接受已规范化的值（防御纵深） |
| agent 访问控制 | `gateway/internal/policy` | `policy.roles` |
| 工具决策 | `gateway/internal/policy` + `runs` | 不在 `tools` 白名单内的一律拒绝 → 调用次数预算 → `allow / ask / deny` |
| 人工审批 | `gateway/internal/runs` | `ask` 时挂起该工具调用，推送 `approval_required`，等审批 / 超时 / run 结束，超时视为拒绝 |
| 准入与配额 | `gateway/internal/runs` | 全局并发、单 workspace 并发、单会话同时只能有一个 run |
| 超时 | `gateway/internal/runs` | `min(agent.policy.timeoutMs, FORGE_RUN_TIMEOUT_MS)`，到期后调用 `run.cancel`，结果标记为 `timeout` |
| 审计 | gateway 日志 `audit: *` | run 开始/结束、每次工具决策（含审批人）、会话删除 |
| 文件沙箱 | `runtime/src/governance.ts` | pi 内置文件工具：读只允许 agent 定义目录和用户的 agent home，写只允许 agent home |
| 执行 | `runtime/src/run.ts` | pi `createAgentSession` + `DefaultResourceLoader`（关闭所有自动发现，只显式加载 agent 的 prompt / skills / tools） |

工具调用必须先后通过两道关：runtime 先检查沙箱（路径属于运行时的概念），再由 gateway 做策略决策（权限属于治理的概念）。governance 扩展加载失败时 run 直接失败，绝不在没有钩子的情况下执行工具。

## 多租户与存储

```
$FORGE_DATA_DIR/workspaces/<workspace>/
  AGENTS.md                                   # 可选，workspace 级指令，所有用户和 agent 共享
  users/<user>/                               # 最后一层：用户目录，所有 agent 共用；工具的 cwd，可写
    sessions/<timestamp>_<sessionId>.jsonl    # pi SessionManager 会话文件（所有 agent 的会话都在这里）
    artifacts/<sessionId>/v<n>.html           # 会话的 HTML 产物版本
```

延续旧服务的 `workspace / user` 两级租户模型，user 是最后一层：会话不按 agent 划分，侧栏列出用户的全部会话。每个会话在创建时用 pi 的 custom entry（`pi-forge.agent`，不进入 LLM 上下文）记录绑定的 agent：重新打开时由同一个 agent 继续，用其他 agent 续写会被 runtime 拒绝（409）；gateway 在列表、读取、删除和产物访问时按绑定的 agent 做 `policy.roles` 检查。

## Memory：完全复用 pi 官方机制

不再保留任何自研的记忆或留存逻辑（旧的 `retention.ts`：自己估算 token、按天数过期、`retention.json`、手动 compact，已全部删除）。

| 能力 | pi 官方机制 | 使用方式 |
|---|---|---|
| 会话历史 | `SessionManager` JSONL（session format v3，树结构，支持分支） | `SessionManager.create / open / list`，按租户目录隔离 |
| 上下文窗口管理 | AgentSession auto-compaction | 通过 `SettingsManager.inMemory({ compaction: { enabled } })` 开关，由 pi 自己按 contextWindow 判断何时压缩 |
| 长期指令 | context files（AGENTS.md） | 通过 `agentsFilesOverride` 显式注入 workspace 级 `AGENTS.md`（不使用向上目录遍历，避免跨租户读取） |
| 会话展示 | `SessionManager.getBranch()` | 当前分支的消息，压缩点显示为摘要标记 |

`runtime/src/memory/sessions.ts` 只是很薄的一层：把租户路径映射到 SessionManager，按 id 查找会话文件，以及给前端整理消息格式。

## Agent 定义

`agents/<id>/agent.json` 由两端共享读取：gateway 读元数据和 `policy`，runtime 读 prompt / model / tools / skills。agent 定义在进程生命周期内不变，修改后需要重启 gateway（runtime 会被一起重启）。详见 [agents/README.md](../agents/README.md)。

## HTML 产物与预览

源自 vercel-labs/fx0 的设计 agent 能力被拆成平台通用部分和 agent 专属部分：

| 部分 | 位置 | 说明 |
|---|---|---|
| 产物存储 | `runtime/src/artifacts/store.ts` | 每个 pi 会话一组版本：`<userHome>/artifacts/<sessionId>/v<n>.html` + `index.json`；同一内容重复发布不产生新版本；删除会话一并删除 |
| 校验 | `runtime/src/artifacts/validate.ts` | 单文件完整文档、≤512 KiB、仅内联脚本/样式与 data: 资源，禁止注释、表单、base、嵌套 frame、meta refresh、脚本 URL |
| 实时草稿 | `runtime/src/run.ts` | agent.json 的 `preview: { tool, argument }` 声明后，pi 流式解析该工具参数时以 `artifact_draft`（offset + delta）转发 |
| 发布事件 | `runtime/src/run.ts` | 工具结果 `details.artifact = { revision, bytes }` → `artifact` 事件；会话记录里同样保留，历史回放可恢复版本 |
| 查询 | gateway `GET …/artifacts[/{revision}]` | 只返回 JSON，产物永远不会以 text/html 在控制台同源下渲染 |
| 预览 | `web/src/components/PreviewPanel.tsx` | 发布版：`sandbox="allow-scripts"`（无 allow-same-origin → 不透明源，Chrome 中为独立进程）+ 注入 CSP（禁止一切网络）+ 心跳（自导航后恢复）+ 外链经用户确认；草稿：去脚本、去外部资源后增量 patch 进无脚本 iframe |

其它 agent 只要在工具里调用 `ctx.artifacts.publish(html)` 并返回 `details.artifact`，就能复用右侧预览。

## 已知边界

- run 状态和审批都在 gateway 内存中：gateway 重启后在途 run 会丢失，SSE 断开会取消对应的 run。
- 文件沙箱基于路径前缀判断，没有处理符号链接；`bash` 工具无法做路径沙箱，不要给不可信租户开放（策略默认拒绝不在白名单内的工具）。
- API Key 来自静态 JSON 文件，没有做速率限制。
