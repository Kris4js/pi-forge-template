import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Peer } from "../src/ipc/peer.ts";
import { startFakeOpenAI } from "./fake-openai.ts";
import type {
  ArtifactDetail,
  ArtifactSummary,
  RunEvent,
  RunEventParams,
  SessionDetail,
  SessionSummary,
  ToolAuthorizeParams,
} from "../src/protocol.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const tenant = { workspace: "acme", userId: "u1" };

let child: ChildProcessWithoutNullStreams;
let peer: Peer;
let dataDir: string;
let model: Awaited<ReturnType<typeof startFakeOpenAI>>;
const events = new Map<string, RunEvent[]>();
const finished = new Map<string, () => void>();
const authorizeCalls: ToolAuthorizeParams[] = [];
type Decision = { decision: "allow" | "deny"; reason?: string };
let decide: (p: ToolAuthorizeParams) => Decision | Promise<Decision> = () => ({ decision: "allow" });

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
      PI_MODEL_IDS: "vendor/fast-model, fake-model",
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

  const sessions = await peer.request<SessionSummary[]>("session.list", { tenant });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.agentId, "assistant");
  const detail = await peer.request<SessionDetail>("session.get", { tenant, sessionId: first.sessionId });
  assert.equal(detail.agentId, "assistant");
  assert.deepEqual(
    detail.messages.map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
  // Other tenants cannot see it.
  const other = await peer.request<SessionSummary[]>("session.list", { tenant: { ...tenant, userId: "u2" } });
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
  const tickets = await readFile(join(dataDir, "workspaces/acme/users/u1/tickets.jsonl"), "utf8").catch(
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
    peer.request("session.list", { tenant: { workspace: "../etc", userId: "u1" } }),
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

const PAGE = (title: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui}</style></head><body><h1>${title}</h1><p>hello</p></body></html>`;

test("html artifacts: live draft, versioned publish, edit, validation and transcript", async () => {
  decide = () => ({ decision: "allow" });
  const scope = { tenant };

  const first = await run("a1", "html-designer", `!publish_design ${JSON.stringify({ html: PAGE("Coffee") })}`);
  const drafts = first.events.filter((e): e is Extract<RunEvent, { type: "artifact_draft" }> => e.type === "artifact_draft");
  assert.ok(drafts.length > 1, "draft streams in several pieces");
  const rebuilt = drafts.reduce((html, d) => html.slice(0, d.offset) + d.delta, "");
  assert.equal(rebuilt, PAGE("Coffee"));
  const published = first.events.find((e) => e.type === "artifact");
  assert.ok(published && published.type === "artifact" && published.revision === 1);

  const sessionId = first.sessionId;
  const edited = await run(
    "a2",
    "html-designer",
    `!edit_design ${JSON.stringify({ edits: [{ old_string: "<p>hello</p>", new_string: "<p>open 8-18</p>" }] })}`,
    sessionId,
  );
  assert.ok(edited.events.some((e) => e.type === "artifact" && e.revision === 2));

  const invalid = await run("a3", "html-designer", `!publish_design ${JSON.stringify({ html: "<div>no doctype</div>" })}`, sessionId);
  const rejected = invalid.events.find((e) => e.type === "tool_end");
  assert.ok(rejected && rejected.type === "tool_end" && rejected.isError && /doctype/.test(rejected.result));
  assert.ok(!invalid.events.some((e) => e.type === "artifact"));

  const list = await peer.request<ArtifactSummary[]>("artifact.list", { ...scope, sessionId });
  assert.deepEqual(list.map((a) => a.revision), [1, 2]);
  const latest = await peer.request<ArtifactDetail>("artifact.get", { ...scope, sessionId });
  assert.equal(latest.revision, 2);
  assert.match(latest.html, /open 8-18/);
  const v1 = await peer.request<ArtifactDetail>("artifact.get", { ...scope, sessionId, revision: 1 });
  assert.match(v1.html, /<p>hello<\/p>/);

  const detail = await peer.request<SessionDetail>("session.get", { ...scope, sessionId });
  const revisions = detail.messages.flatMap((m) => (m.role === "tool" && m.artifactRevision ? [m.artifactRevision] : []));
  assert.deepEqual(revisions, [1, 2]);

  // Other users cannot read it; deleting the session deletes its artifacts.
  await assert.rejects(peer.request("artifact.get", { tenant: { ...tenant, userId: "u2" }, sessionId }), /not found/);
  await peer.request("session.delete", { ...scope, sessionId });
  assert.deepEqual(await peer.request("artifact.list", { ...scope, sessionId }), []);
});

test("sessions are per user, not per agent; each stays bound to the agent it started with", async () => {
  decide = () => ({ decision: "allow" });
  const chat = await run("b1", "assistant", "你好");
  const support = await run("b2", "support-desk", "退款");
  const sessions = await peer.request<SessionSummary[]>("session.list", { tenant });
  const byId = new Map(sessions.map((s) => [s.id, s.agentId]));
  assert.equal(byId.get(chat.sessionId), "assistant");
  assert.equal(byId.get(support.sessionId), "support-desk");
  assert.deepEqual(await peer.request("session.info", { tenant, sessionId: support.sessionId }), {
    id: support.sessionId,
    agentId: "support-desk",
  });
  // Another agent cannot continue the session.
  await assert.rejects(
    peer.request("run.start", { runId: "b3", tenant, agentId: "support-desk", sessionId: chat.sessionId, input: { text: "x" } }),
    /belongs to agent assistant/,
  );
  // All of the user's sessions sit in one directory, below the user.
  const files = await readdir(join(dataDir, "workspaces/acme/users/u1/sessions"));
  assert.ok(files.some((f) => f.endsWith(`_${chat.sessionId}.jsonl`)) && files.some((f) => f.endsWith(`_${support.sessionId}.jsonl`)));
});

test("sessions can be renamed (pi session_info) and pinned (user preference), but not renamed mid-run", async () => {
  decide = () => ({ decision: "allow" });
  const a = await run("c1", "assistant", "第一个");
  const b = await run("c2", "assistant", "第二个");

  await peer.request("session.update", { tenant, sessionId: a.sessionId, name: "我的周报" });
  await peer.request("session.update", { tenant, sessionId: a.sessionId, pinned: true });
  let list = await peer.request<SessionSummary[]>("session.list", { tenant });
  assert.equal(list[0]!.id, a.sessionId, "pinned first even though b is newer");
  assert.equal(list[0]!.pinned, true);
  assert.equal(list[0]!.name, "我的周报");
  assert.ok(list.find((s) => s.id === b.sessionId)!.pinned === undefined);
  await assert.rejects(peer.request("session.update", { tenant, sessionId: a.sessionId, name: "   " }), /name must be/);

  // A run parked on an approval holds the session: renaming it then would fork pi's entry tree.
  let release!: (d: Decision) => void;
  const parked = new Promise<void>((resolve) => {
    decide = () => {
      resolve();
      return new Promise<Decision>((r) => (release = r));
    };
  });
  const done = new Promise<void>((r) => finished.set("c3", r));
  const started = await peer.request<{ sessionId: string }>("run.start", {
    runId: "c3",
    tenant,
    agentId: "support-desk",
    input: { text: '!create_ticket {"subject":"s","detail":"d"}' },
  });
  await parked;
  await assert.rejects(peer.request("session.update", { tenant, sessionId: started.sessionId, name: "x" }), /busy/);
  // Pinning is a preference outside the session file, so it is fine mid-run.
  await peer.request("session.update", { tenant, sessionId: started.sessionId, pinned: true });
  release({ decision: "deny", reason: "test" });
  await done;
  decide = () => ({ decision: "allow" });
  await peer.request("session.update", { tenant, sessionId: started.sessionId, name: "退款工单" });

  // Deleting a session drops its pin.
  await peer.request("session.delete", { tenant, sessionId: started.sessionId });
  await peer.request("session.update", { tenant, sessionId: a.sessionId, pinned: false });
  list = await peer.request<SessionSummary[]>("session.list", { tenant });
  assert.ok(list.every((s) => !s.pinned));
  const pins = JSON.parse(await readFile(join(dataDir, "workspaces/acme/users/u1/pins.json"), "utf8"));
  assert.deepEqual(pins.pinned, []);
});

test("the console can pick any registered model and thinking level, and nothing else", async () => {
  const list = await peer.request<{
    models: Array<{ key: string; label: string; group: string; name: string }>;
    defaultModel: string;
    thinkingLevels: string[];
    defaultThinkingLevel: string;
  }>("models.list", {});
  assert.deepEqual(
    list.models.map((m) => [m.key, m.label, m.group, m.name]),
    [
      ["custom/fake-model", "fake-model", "Custom", "fake-model"],
      ["custom/vendor/fast-model", "vendor/fast-model", "vendor", "fast-model"],
    ],
  );
  assert.equal(list.defaultModel, "custom/fake-model");
  assert.deepEqual(list.thinkingLevels, ["off", "low", "medium", "high"]);

  const done = new Promise<void>((r) => finished.set("m1", r));
  await peer.request("run.start", {
    runId: "m1",
    tenant,
    agentId: "assistant",
    input: { text: "hi" },
    model: "custom/vendor/fast-model",
    thinkingLevel: "high",
  });
  await done;
  const started = events.get("m1")!.find((e) => e.type === "run_started");
  assert.ok(started && started.type === "run_started" && started.model === "vendor/fast-model");

  await assert.rejects(
    peer.request("run.start", { runId: "m2", tenant, agentId: "assistant", input: { text: "x" }, model: "openai/gpt-x" }),
    /model not available/,
  );
  await assert.rejects(
    peer.request("run.start", { runId: "m3", tenant, agentId: "assistant", input: { text: "x" }, thinkingLevel: "max" }),
    /invalid thinkingLevel/,
  );
});
