# Agents

每个子目录是一个独立的业务 agent，目录名就是 agent id（`[a-z0-9][a-z0-9_-]*`）。新增 agent 不需要改动 gateway 或 runtime 代码，重启 gateway 即可生效。

```
agents/<id>/
  agent.json      必填：元数据、工具白名单、治理策略
  prompt.md       必填：system prompt
  tools.ts        可选：自定义工具（default export 一个工厂函数）
  skills/         可选：pi skills（<name>/SKILL.md），需要在 tools 里开启 read
  ...             其他只读资源（知识库、样例数据），工具通过 ctx.agentDir 读取
```

## agent.json

```jsonc
{
  "id": "support-desk",
  "name": "客服工单",
  "description": "...",
  "prompt": "prompt.md",                   // 默认值
  "model": { "provider": "anthropic", "id": "claude-sonnet-5-5", "thinkingLevel": "low" },  // 可选，默认使用 .env 中的配置
  "tools": ["search_kb", "create_ticket"],   // 白名单：pi 内置工具(read/ls/grep/find/edit/write/bash) + tools.ts 中定义的工具
  "memory": { "compaction": true },          // 是否开启 pi auto-compaction，默认开启
  "preview": { "tool": "publish_design", "argument": "html" },  // 可选：该工具的该参数流式转发为页面草稿
  "policy": {                                // 由 gateway 执行
    "tools": { "search_kb": "allow", "create_ticket": "ask" },   // 白名单内未列出的工具默认 allow
    "maxToolCalls": 8,                       // 单个 run 的工具调用预算
    "timeoutMs": 180000,                     // 不能超过 FORGE_RUN_TIMEOUT_MS
    "roles": ["member"]                      // 可用角色，省略表示所有人可用
  },
  "starters": ["怎么申请退款？"]              // 前端展示的示例问题
}
```

## tools.ts

```ts
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentToolsFactory } from "../../runtime/src/agents/manifest.ts";

const tools: AgentToolsFactory = (ctx) => [
  defineTool({
    name: "my_tool",
    label: "My tool",
    description: "给模型看的说明",
    parameters: Type.Object({ q: Type.String() }),
    async execute(_id, params) {
      // ctx.tenant / ctx.agentDir（只读资源）/ ctx.userHome（当前用户可写目录，所有 agent 共用）
      // ctx.sessionId / ctx.artifacts（会话的 HTML 产物版本，publish 后返回 details.artifact 即可在控制台预览）
      return { content: [{ type: "text", text: `result for ${params.q}` }], details: {} };
    },
  }),
];
export default tools;
```

## 生成图片结果

生图工具获得图片字节后，调用 `await ctx.publishImages([{ name: "product.png", mimeType: "image/png", data: base64 }])`，并在成功的工具返回值中提供 `details: { images }`。`data` 是不带 data URL 前缀的 Base64；使用与上传相同的格式、大小和数量限制。不要把 Base64 放入文本回复。

运行时会将图片保存为当前用户、当前会话的资产，实时推送并在工具结果中保留引用；前端复用上传图片的轮播、大图预览和下载。不包含实际生图供应商或 MCP 连接，工具仍需自行获取图片。不同生成版本应由工具分开返回，不混为一组。

每个 run 都会以当前租户的 `ctx` 重新调用工厂函数，所以工具天然只作用于当前租户。有副作用的工具应在 `policy.tools` 里设为 `ask`。
