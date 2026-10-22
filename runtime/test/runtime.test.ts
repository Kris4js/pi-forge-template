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
  UserAskParams,
  UserAskResult,
} from "../src/protocol.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const tenant = { workspace: "acme", userId: "u1" };

let child: ChildProcessWithoutNullStreams;
let peer: Peer;
let dataDir: string;
let lastModelRequest: unknown;
let model: Awaited<ReturnType<typeof startFakeOpenAI>>;
const events = new Map<string, RunEvent[]>();
const finished = new Map<string, () => void>();
const authorizeCalls: ToolAuthorizeParams[] = [];
type Decision = { decision: "allow" | "deny"; reason?: string };
let decide: (p: ToolAuthorizeParams) => Decision | Promise<Decision> = () => ({ decision: "allow" });
let answerQuestion: (p: UserAskParams) => UserAskResult = () => ({ status: "skipped" });

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-forge-test-"));
  model = await startFakeOpenAI({ onRequest: (body) => { lastModelRequest = body; } });
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
      PI_IMAGE_URL: `${model.baseUrl}/images`,
      PI_IMAGE_API_KEY: "fake-image-key",
      PI_IMAGE_MODEL_ID: "test/image",
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
  peer.handle("user.ask", (p: UserAskParams) => answerQuestion(p));
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

test("ask_user is a default tool: it waits for the user's answer through the gateway and continues the run", async () => {
  decide = () => ({ decision: "allow" });
  const asked: UserAskParams[] = [];
  answerQuestion = (p) => {
    asked.push(p);
    return { status: "answered", answer: "继续排查（推荐）" };
  };
  const ask = { question: "接下来你想怎么处理？", options: ["继续排查（推荐）", "直接建工单"] };
  const result = await run("ask1", "support-desk", `!ask_user ${JSON.stringify(ask)}`);
  assert.equal(authorizeCalls.at(-1)?.toolName, "ask_user");
  assert.equal(asked.length, 1);
  assert.deepEqual({ question: asked[0]!.question, options: asked[0]!.options }, ask);
  assert.equal(asked[0]!.runId, "ask1");
  const end = result.events.find((e) => e.type === "tool_end");
  assert.ok(end && end.type === "tool_end" && !end.isError && end.result.includes("继续排查（推荐）"));
  // The run did not stop at the question: the model replied to the answer in the same run.
  assert.ok(result.events.some((e) => e.type === "text_delta"));
  const finish = result.events.at(-1);
  assert.ok(finish?.type === "run_finished" && finish.status === "completed");

  answerQuestion = () => ({ status: "expired" });
  const expired = await run("ask2", "support-desk", `!ask_user ${JSON.stringify(ask)}`);
  const expiredEnd = expired.events.find((e) => e.type === "tool_end");
  assert.ok(expiredEnd && expiredEnd.type === "tool_end" && expiredEnd.result.includes("没有回答"));

  // A default tool: agents get it without listing it (assistant's agent.json has no tools at all).
  answerQuestion = () => ({ status: "answered", answer: "好" });
  const viaDefault = await run("ask3", "assistant", `!ask_user ${JSON.stringify(ask)}`);
  const defaultEnd = viaDefault.events.find((e) => e.type === "tool_end");
  assert.ok(defaultEnd && defaultEnd.type === "tool_end" && !defaultEnd.isError && defaultEnd.result.includes("好"));
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


test("attachments cross IPC into the model and remain isolated from other users", async () => {
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S0AAAAASUVORK5CYII=";
  const runId = "attachment-run";
  const done = new Promise<void>((resolve) => finished.set(runId, resolve));
  const started = await peer.request<{ sessionId: string }>("run.start", {
    runId, tenant, agentId: "assistant", input: { text: "", attachments: [
      { name: "product.png", mimeType: "image/png", data },
      { name: "spec.txt", mimeType: "text/plain", data: Buffer.from("capacity 500ml").toString("base64") },
    ] },
  });
  await done;
  assert.equal((events.get(runId)!.at(-1) as { status: string }).status, "completed");
  assert.match(JSON.stringify(lastModelRequest), /data:image\/png;base64,/);
  assert.match(JSON.stringify(lastModelRequest), /capacity 500ml/);
  const imageEvent = events.get(runId)!.find((event) => event.type === "images");
  assert.ok(imageEvent && imageEvent.type === "images");
  const asset = imageEvent.images[0]!;
  const stored = await peer.request<{ data: string; mimeType: string }>("image.get", { tenant, sessionId: started.sessionId, id: asset.id });
  assert.equal(stored.data, data);
  assert.equal(stored.mimeType, "image/png");
  await assert.rejects(peer.request("image.get", { tenant: { ...tenant, userId: "u2" }, sessionId: started.sessionId, id: asset.id }));
  await assert.rejects(peer.request("image.get", { tenant, sessionId: started.sessionId, id: "../../.env" }));
  const detail = await peer.request<SessionDetail>("session.get", { tenant, sessionId: started.sessionId });
  assert.match(JSON.stringify(detail.messages), /product.png/);
  assert.deepEqual(detail.messages.find((message) => message.role === "user" && message.images?.length), { role: "user", text: "", images: [asset], files: [{ name: "spec.txt", mimeType: "text/plain", size: 14 }], timestamp: detail.messages.find((message) => message.role === "user")?.timestamp });
  await assert.rejects(peer.request("session.get", { tenant: { ...tenant, userId: "u2" }, sessionId: started.sessionId }));
  await assert.rejects(peer.request("run.start", { runId: "invalid-attachment", tenant, agentId: "assistant", input: {
    text: "test", attachments: [{ name: "../escape.txt", mimeType: "text/plain", data: "eA==" }],
  } }), /附件名称无效/);
});


test("image-designer generates, publishes and edits session-scoped references through governed tools", async () => {
 const first = await run("generate-image", "image-designer", '!generate_images {"images":[{"prompt":"white ceramic cup"}]}');
 const image = first.events.find((event) => event.type === "images");
 assert.ok(image && image.type === "images" && image.toolCallId);
 const asset = image.images[0]!;
 assert.ok(authorizeCalls.some((call) => call.runId === "generate-image" && call.toolName === "generate_images"));
 const detail = await peer.request<SessionDetail>("session.get", { tenant, sessionId: first.sessionId });
 assert.ok(detail.messages.some((message) => message.role === "tool" && message.images?.[0]?.id === asset.id));
 const edited = await run("edit-image", "image-designer", `!generate_images ${JSON.stringify({ images: [{ prompt: "change background to blue", referenceIds: [asset.id] }] })}`, first.sessionId);
 assert.ok(edited.events.some((event) => event.type === "images"));
 const other = await run("foreign-reference", "image-designer", `!generate_images ${JSON.stringify({ images: [{ prompt: "edit", referenceIds: [asset.id] }] })}`);
 assert.ok(other.events.some((event) => event.type === "tool_end" && event.isError));
 assert.ok(!other.events.some((event) => event.type === "images"));
});


test("image generation permits 30 images per run and blocks the next batch", async () => {
 const result = await run("image-budget", "image-designer", "!image-budget");
 const images = result.events.filter((event) => event.type === "images");
 assert.equal(images.reduce((sum, event) => sum + (event.type === "images" ? event.images.length : 0), 0), 30);
 assert.equal(result.events.filter((event) => event.type === "tool_end" && event.isError).length, 1);
});
