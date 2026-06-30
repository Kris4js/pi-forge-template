import { MinipiAgentRuntime } from "../src/index.js";

const runtime = new MinipiAgentRuntime({ workspace: "demo" });

const first = await runtime.chat(
  "你好，我叫 Kris。我喜欢简洁回答。请记住这个偏好。",
  { stream: true },
);
console.log(`sessionId=${first.sessionId}`);
console.log(`workspace=${first.workspace}`);

const second = await runtime.chat("你还记得我喜欢什么风格吗", {
  sessionId: first.sessionId,
  stream: true,
});
console.log(`answer=${second.text}`);
console.log(`retention=${JSON.stringify(second.retention)}`);

await runtime.dispose();
