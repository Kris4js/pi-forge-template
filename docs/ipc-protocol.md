# gateway ⇄ runtime IPC 协议（v1）

- 传输：runtime 子进程的 stdin（gateway → runtime）和 stdout（runtime → gateway）；stderr 是日志。
- 帧格式：每行一个 JSON 对象，**只按 LF 切分**（不要用会把 U+2028/U+2029 当换行的 reader）。
- 消息格式：JSON-RPC 2.0，双向都可以发 request / notification。
- 类型定义：`runtime/src/protocol.ts` 与 `gateway/internal/ipc/protocol.go`，两边需要同步修改，并递增 `PROTOCOL_VERSION`。

## gateway → runtime

| method | params | result |
|---|---|---|
| `runtime.hello` | `{}` | `{protocolVersion, runtime, model?}`，握手时校验协议版本 |
| `image.get` | `{tenant, sessionId, id}` | `{name,mimeType,data}`，会话及图片必须属于当前用户；data 为 Base64 |
| `run.start` | `{runId, tenant:{workspace,userId}, agentId, sessionId?, input:{text, attachments?:[{name,mimeType,data}]}}` | `{sessionId}`，表示 run 已被接受，后续进度通过 `run.event` 推送 |
| `run.cancel` | `{runId}` | `{cancelled}` |
| `session.list` | `{tenant, agentId}` | `SessionSummary[]` |
| `session.get` | `{tenant, agentId, sessionId}` | `{id, name?, messages: TranscriptMessage[]}` |
| `session.delete` | `{tenant, agentId, sessionId}` | `{deleted}` |

## runtime → gateway

| 类型 | method | params | result |
|---|---|---|---|
| request | `tool.authorize` | `{runId, toolCallId, toolName, input}` | `{decision: "allow"\|"deny", reason?}`，gateway 可以挂起直到人工审批完成 |
| notification | `run.event` | `{runId, seq, event}` | — |

`event.type`：`images`（`{images:[{id,name,mimeType}], toolCallId?}`，无 toolCallId 为本轮用户上传，有则为工具生成结果）、`run_started`、`text_delta`、`thinking_delta`、`tool_start`、`tool_end`、`message_end`、`compaction`、`run_finished`。每个 run 恰好以一个 `run_finished{status, error?, usage}` 结束。

时序保证：同一个 run 的 notification 按发送顺序处理；`tool_start` 一定先于对应的 `tool.authorize` 到达。

## 错误码

| code | 含义 | HTTP 映射 |
|---|---|---|
| -32602 | 参数非法（含非规范化的租户段） | 400 |
| -32601 | 未知 method | 502 |
| 404 | agent / session 不存在 | 404 |
| 409 | run 已存在 / 会话正忙 | 409 |
| 其他 | 运行时错误 | 502 |
