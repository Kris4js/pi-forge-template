import assert from "node:assert/strict";
import { test } from "node:test";
const modulePath = "../../web/src/conversation.ts";
const { applyEvent, fromTranscript } = await import(modulePath);

const image = { id: "asset-1", name: "product.png", mimeType: "image/png" };
test("image groups attach to the correct uploaded turn or generated tool, live and after reload", () => {
  let items = fromTranscript([{ role: "user", text: "查看产品", images: [image] }]);
  assert.deepEqual(items[0]?.kind === "user" && items[0].images, [image]);
  items = applyEvent(items, { type: "tool_start", toolCallId: "t1", toolName: "generate", args: {} }, { now: 1 });
  items = applyEvent(items, { type: "images", toolCallId: "t1", images: [image] }, { now: 2 });
  assert.deepEqual(items[1]?.kind === "tool" && items[1].images, [image]);
  const reloaded = fromTranscript([
    { role: "assistant", text: "", toolCalls: [{ id: "t1", name: "generate", args: {} }] },
    { role: "tool", toolCallId: "t1", toolName: "generate", text: "done", isError: false, images: [image] },
  ]);
  assert.deepEqual(reloaded[0]?.kind === "tool" && reloaded[0].images, [image]);
  assert.deepEqual(applyEvent([], { type: "images", images: [image] }, { now: 3 }), []);
});
