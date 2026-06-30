import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonMemoryStore, LayeredMemoryStore } from "../src/memory/store.js";

const root = await mkdtemp(join(tmpdir(), "minipi-memory-test-"));
try {
  const aliceStore = new LayeredMemoryStore(
    { workspace: "demo", userId: "alice", sessionId: "alice-s1" },
    new JsonMemoryStore(join(root, "alice-memory.json"), { workspace: "demo", userId: "alice", visibility: "user" }),
    new JsonMemoryStore(join(root, "shared-memory.json"), { workspace: "demo", userId: "*", visibility: "workspace" }),
  );
  const bobStore = new LayeredMemoryStore(
    { workspace: "demo", userId: "bob", sessionId: "bob-s1" },
    new JsonMemoryStore(join(root, "bob-memory.json"), { workspace: "demo", userId: "bob", visibility: "user" }),
    new JsonMemoryStore(join(root, "shared-memory.json"), { workspace: "demo", userId: "*", visibility: "workspace" }),
  );

  await aliceStore.add({ sessionId: "alice-s1", kind: "preference", text: "Alice 偏好中文回答", visibility: "user", source: "user", confidence: 0.9 });
  await aliceStore.add({ sessionId: "alice-s1", kind: "fact", text: "当前 session 临时主题是 A", visibility: "session", source: "user", confidence: 0.7 });
  await aliceStore.add({ sessionId: "alice-s1", kind: "fact", text: "共享规则：回答必须基于事实", visibility: "workspace", source: "system", confidence: 1 });

  const aliceUserResults = await aliceStore.search("alice-s2", "中文回答", 5, "user");
  assert.equal(aliceUserResults.length, 1);
  assert.equal(aliceUserResults[0]?.userId, "alice");

  const bobUserResults = await bobStore.search("bob-s1", "中文回答", 5, "all");
  assert.equal(bobUserResults.some((item) => item.userId === "alice"), false);

  const aliceOtherSessionResults = await aliceStore.search("alice-s2", "临时主题", 5, "all");
  assert.equal(aliceOtherSessionResults.some((item) => item.visibility === "session"), false);

  const bobWorkspaceResults = await bobStore.search("bob-s1", "共享规则", 5, "workspace");
  assert.equal(bobWorkspaceResults.length, 1);
  assert.equal(bobWorkspaceResults[0]?.visibility, "workspace");

  console.log("memory isolation tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
