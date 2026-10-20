import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Peer } from "../src/ipc/peer.ts";
import { startFakeOpenAI } from "./fake-openai.ts";
import type { RunEvent, RunEventParams, SessionDetail, SessionSummary, ToolAuthorizeParams } from "../src/protocol.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const tenant = { workspace: "acme", userId: "u1" };

let child: ChildProcessWithoutNullStreams;
let peer: Peer;
let dataDir: string;
let model: Awaited<ReturnType<typeof startFakeOpenAI>>;
const events = new Map<string, RunEvent[]>();
const finished = new Map<string, () => void>();
const authorizeCalls: ToolAuthorizeParams[] = [];
let decide: (p: ToolAuthorizeParams) => { decision: "allow" | "deny"; reason?: string } = () => ({ decision: "allow" });

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-forge-test-"));
  model = await startFakeOpenAI();
  child = spawn(process.execPath, ["--import", "tsx", join(root, "runtime/src/main.ts")], {
    cwd: root,
    env: {
      ...process.env,
      FORGE_ENV_FILE: "/nonexistent",
      PI_MODEL_PROVIDER: "custom",
      PI_MODEL_PROTOCOL: "openai-completions",
      PI_MODEL_BASE_URL: model.baseUrl,
      PI_MODEL_ID: "fake-model",
      PI_MODEL_API_KEY: "test-key",
      FORGE_DATA_DIR: dataDir,
      FORGE_AGENTS_DIR: join(root, "agents"),
    },
  });
  child.stderr.on("data", () => {});
  peer = new Peer(child.stdout, (line) => child.stdin.write(line));
  peer.handle("run.event", (p: RunEventParams) => {
    const list = events.get(p.runId) ?? [];
    list.push(p.event);
    events.set(p.runId, list);
    if (p.event.type === "run_finished") finished.get(p.runId)?.();
  });
  peer.handle("tool.authorize", (p: ToolAuthorizeParams) => {
    authorizeCalls.push(p);
    return decide(p);
  });
});

after(async () => {
  child.stdin.end();
  await new Promise((r) => child.once("exit", r));
  await model.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function run(runId: string, agentId: string, text: string, sessionId?: string) {
  const done = new Promise<void>((r) => finished.set(runId, r));
  const result = await peer.request<{ sessionId: string }>("run.start", { runId, tenant, agentId, sessionId, input: { text } });
  await done;
  return { sessionId: result.sessionId, events: events.get(runId)! };
}

test("hello reports protocol version and the configured model (custom models show the bare id)", async () => {
  const hello = await peer.request<{ protocolVersion: number; model: string }>("runtime.hello", {});
  assert.equal(hello.protocolVersion, 1);
  assert.equal(hello.model, "fake-model");
});

test("chat run streams text and persists into pi session storage", async () => {
  const first = await run("r1", "assistant", "你好");
  assert.equal(first.events[0]!.type, "run_started");
  assert.ok(first.events.some((e) => e.type === "text_delta"));
  const end = first.events.at(-1)!;
  assert.equal(end.type, "run_finished");
  assert.equal(end.type === "run_finished" && end.status, "completed");

  const second = await run("r2", "assistant", "第二轮", first.sessionId);
  assert.equal(second.sessionId, first.sessionId);

  const sessions = await peer.request<SessionSummary[]>("session.list", { tenant, agentId: "assistant" });
  assert.equal(sessions.length, 1);
  const detail = await peer.request<SessionDetail>("session.get", { tenant, agentId: "assistant", sessionId: first.sessionId });
  assert.deepEqual(
    detail.messages.map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
  // Other tenants cannot see it.
  const other = await peer.request<SessionSummary[]>("session.list", { tenant: { ...tenant, userId: "u2" }, agentId: "assistant" });
  assert.equal(other.length, 0);
});

test("tool calls are authorized by the gateway before execution", async () => {
  decide = () => ({ decision: "allow" });
  const allowed = await run("r3", "support-desk", '!search_kb {"query":"退款"}');
  assert.equal(authorizeCalls.at(-1)?.toolName, "search_kb");
  const toolEnd = allowed.events.find((e) => e.type === "tool_end");
  assert.ok(toolEnd && toolEnd.type === "tool_end" && !toolEnd.isError && toolEnd.result.includes("refund.md"));

  decide = (p) => (p.toolName === "create_ticket" ? { decision: "deny", reason: "rejected by reviewer" } : { decision: "allow" });
  const denied = await run("r4", "support-desk", '!create_ticket {"subject":"x","detail":"y"}');
  const deniedEnd = denied.events.find((e) => e.type === "tool_end");
  assert.ok(deniedEnd && deniedEnd.type === "tool_end" && deniedEnd.isError);
  assert.match(deniedEnd.result, /rejected by reviewer/);
  const tickets = await readFile(join(dataDir, "workspaces/acme/users/u1/agents/support-desk/tickets.jsonl"), "utf8").catch(
    () => "",
  );
  assert.equal(tickets, "");
});

test("file tools are sandboxed before reaching the gateway", async () => {
  const before = authorizeCalls.length;
  const result = await run("r5", "data-analyst", '!read {"path":"/etc/hosts"}');
  const toolEnd = result.events.find((e) => e.type === "tool_end");
  assert.ok(toolEnd && toolEnd.type === "tool_end" && toolEnd.isError);
  assert.match(toolEnd.result, /outside sandbox/);
  assert.equal(authorizeCalls.length, before);

  const skill = await run("r6", "data-analyst", `!read {"path":"${join(root, "agents/data-analyst/skills/drill-down/SKILL.md")}"}`);
  const skillEnd = skill.events.find((e) => e.type === "tool_end");
  assert.ok(skillEnd && skillEnd.type === "tool_end" && !skillEnd.isError);
});

test("invalid tenant segments are rejected", async () => {
  await assert.rejects(
    peer.request("session.list", { tenant: { workspace: "../etc", userId: "u1" }, agentId: "assistant" }),
    /invalid workspace/,
  );
});

test("runtime refuses to start without a configured model", async () => {
  const proc = spawn(process.execPath, ["--import", "tsx", join(root, "runtime/src/main.ts")], {
    cwd: root,
    env: { PATH: process.env.PATH, FORGE_ENV_FILE: "/nonexistent", FORGE_DATA_DIR: dataDir },
  });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((r) => proc.once("exit", r));
  assert.equal(code, 78);
  assert.match(stderr, /no model configured/);
});
