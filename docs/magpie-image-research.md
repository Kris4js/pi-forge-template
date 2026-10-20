# Magpie 图片 MCP 接入调查

调查日期：2026-10-20。只读探测，未调用生成、编辑或视频工具，未读取凭证。

## 已实测

本机 `/Applications/magpie.app/Contents/MacOS/magpie --version` 返回 `magpie 0.1.1296`。

通过子进程 stdio JSON-RPC 执行 `initialize` → `notifications/initialized` → `tools/list`：

- 服务名 `magpie-image`，服务版本 `1`；返回协议版本 `2025-06-18`。
- 客户端以 `2024-11-05` 初始化时，服务仍返回上述版本；正式客户端需正确处理版本协商。
- `generate_image`：必填 `prompt`；可选 `reference_images: string[]`、`path`、`size`、`n: 1..4`、`quality`、`background`。
- `reference_images` 接受文件路径或 HTTP(S) URL，用于编辑或组合图片。
- `size` 接受 `1024x1024`、`1536x1024`、`1024x1536` 等尺寸或 `16:9` 等比例；实际支持取决于 Magpie 中配置的模型。
- 约 20 秒内完成则返回文件位置，否则返回任务 ID。
- `generation_result({id})` 等待该任务；约 20 秒后若仍未完成，需用同一 ID 再查，不能重新生成。
- 同一服务另有 `generate_video`，不在本次接入范围。
- 生图模型由 Magpie 配置选择；工具 schema 没有 model 参数。

来源：本机命令 help、version 及 MCP 工具发现结果。原始发现 JSON 临时保存在 `/tmp/magpie-image-tools.json`，不含凭证，不保证长期存在。

## 未验证

没有实际生成图片，因此尚不知道工具成功/排队返回的具体 JSON 结构（是否 structuredContent、content.text 的格式）、失败错误结构、默认模型、计费、取消行为及服务器退出后的任务存活规则。不能仅凭工具描述编写可靠的路径/任务 ID 字符串解析器。

## 建议的最小接入

新增一个 image-designer agent，提供一个受治理工具 generate_images。工具参数包含 prompt、size、count，以及已登记资产的引用 ID；不让模型传任意本机路径、URL 或输出路径。

执行顺序：

1. 经现有 gateway tool.authorize 审批后执行。
2. 通过 MCP 客户端连接 Magpie stdio；stderr 只写日志，不混入 JSON-RPC。
3. 从当前用户、当前会话的图片资产 ID 安全解析参考图。现有提示词附件路径不能直接当作可信工具输入。
4. 输出到宿主指定的唯一临时目录，调用 generate_image；排队时查询同一个 generation_result ID。
5. 验证返回文件实际位于该目录内，拒绝符号链接逃逸、非图片和超限文件。
6. 读取图片，调用现有 ctx.publishImages()，返回 details.images，复用轮播、下载及历史恢复。
7. finally 关闭 MCP 客户端/子进程并清理临时输出。取消停止等待和后续轮询，但不能在供应商无取消能力时保证外部生成停止；不要自动重试生成。

参考图优先从图片资产解析；若需要跨会话复用，须另行明确授权，不默认开放用户任意文件。

本地先配置 image backend 为 Magpie；未来替换为图片模型 API 时保留 agent 工具参数、图片资产和前端不变，只替换调用供应商与结果归一化部分。没有确定第二家供应商前不构建通用插件框架。

## 限制

当前 ctx.publishImages 使用上传附件限制：最多 4 张、单张 4 MiB、总计 8 MiB。实际高分辨率生成图片可能超限；首版应明确报错，不静默压缩。

默认全局 run 超时 300 秒；agent 的 timeoutMs 不能超过全局限制。生成与编辑可能超时。任务取消、工具审批和外部供应商的生成状态不是同一回事，不能把停止等待当作撤销生成。

Magpie 是本机 macOS 应用依赖，不能把 `/Applications/...` 命令直接搬入 Linux 部署。线上需改为图片 API 后端或明确部署独立图片服务。

仓库依据：runtime/src/agents/manifest.ts、runtime/src/run.ts、runtime/src/attachments.ts、runtime/src/image-assets.ts、gateway/internal/config/config.go、agents/README.md。
