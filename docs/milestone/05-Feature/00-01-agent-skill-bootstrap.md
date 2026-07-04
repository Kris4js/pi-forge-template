# 00-01 Agent Skill Bootstrap

## 目标

支持多智能体场景下按 agent 同步 skill，解决 workspace 懒创建导致 skill 无法提前准备的问题。

## 结论

workspace 仍然保持懒创建；在 runtime 初始化时执行 bootstrap，把服务端内置的 agent skills 同步到当前 workspace 的 `.pi/skills`，再创建 pi runtime。

## 目录约定

| 类型 | 路径 | 说明 |
|---|---|---|
| skill 源 | `src/skills/<agentName>/` | 每个 agent 的 skill source-of-truth |
| skill 目标 | `.workspaces/<workspace>/.pi/skills/` | pi 项目级 skill 发现目录 |
| session | `.workspaces/<workspace>/users/<userId>/sessions/` | 用户会话目录 |

## 请求参数

API 请求可以传入 `agentName`：

```json
{
  "workspace": "demo",
  "userId": "u1",
  "agentName": "coder",
  "prompt": "..."
}
```

未传时使用 `default`。

## 初始化流程

| 步骤 | 行为 |
|---|---|
| 1 | 解析 `workspace` / `userId` / `agentName` |
| 2 | 创建 workspace 基础目录 |
| 3 | 清空并同步 `src/skills/<agentName>` 到 `<workspace>/.pi/skills` |
| 4 | 创建 pi runtime |
| 5 | 打开 skill 加载：`noSkills: false` |
| 6 | system prompt 注入 agent identity |

## 行为细节

| 场景 | 行为 |
|---|---|
| `src/skills/<agentName>` 存在 | 覆盖同步到 workspace `.pi/skills` |
| `src/skills/<agentName>` 不存在 | 清空 workspace `.pi/skills` 后继续运行 |
| 多 agent 同 workspace/user | runtime cache key 包含 `agentName`，避免串 session/runtime |
| 显式新 session | 使用传入 `agentName` 初始化对应 skills |
| 查询 state / select session | 同样接受 `agentName`，读取对应 runtime |

## 相关实现

| 文件 | 说明 |
|---|---|
| `src/agent/bootstrap.ts` | `bootstrapAgentWorkspace()` 同步 agent skills |
| `src/agent/runtime.ts` | runtime init 前执行 bootstrap，并开启 skills |
| `src/workspace/paths.ts` | 创建 `.pi/skills` 目录，提供 `normalizeAgentName()` |
| `src/server/router.ts` | API 接收并传递 `agentName` |
| `src/server/runtimes.ts` | runtime cache key 增加 agent 维度 |
| `src/prompt/system.ts` | system prompt 注入 agent identity |

## 验证

| 命令 | 结果 |
|---|---|
| `npm run check` | 通过 |

## 后续约束

- prompt 继续按 `src/prompt/<agentName>` 方向演进。
- skill 不拼进 system prompt，交给 pi 的 skill 发现和按需加载机制。
- 不依赖全局 `~/.pi/agent/skills`，避免多租户和多 agent 串配置。
