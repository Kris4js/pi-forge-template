import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Peer } from "../src/ipc/peer.ts";
import { flushSession, persistSession, restoreSession, type SessionRecord } from "../src/memory/managed-session.ts";
import { DatabaseStore } from "../src/memory/database.ts";
import { getSessionInfo, listAllArtifacts, listSessions } from "../src/memory/sessions.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { tenantPaths } from "../src/tenant.ts";
import type { Project, RunEventParams, SessionDetail, SessionSummary } from "../src/protocol.ts";
import { startFakeOpenAI } from "./fake-openai.ts";

const root = resolve(import.meta.dirname, "../..");
const tenant = { workspace: "acme", userId: "db-user" };

test("SDK database bridge preserves original entries, branches, labels and compaction context", () => {
  const source = SessionManager.inMemory("/tmp", { id: "restore-test" });
  source.appendCustomEntry("pi-forge.agent", { agentId: "assistant" });
  source.appendModelChange("custom", "fake");
  source.appendThinkingLevelChange("low");
  const first = source.appendMessage({ role: "user", content: "first", timestamp: 1 });
  source.appendMessage({ role: "user", content: "abandoned", timestamp: 2 });
  source.branch(first);
  const kept = source.appendMessage({ role: "user", content: "active", timestamp: 3 });
  source.appendCompaction("summary", kept, 10000);
  source.appendLabelChange(kept, "bookmark");
  source.appendSessionInfo("named");
  const record: SessionRecord = { header: source.getHeader()!, entries: source.getEntries(), leafId: source.getLeafId(), updatedAt: new Date().toISOString() };
  const restored = restoreSession("/tmp", record);
  assert.equal(restored.getSessionId(), source.getSessionId());
  assert.equal(restored.getSessionFile(), undefined);
  assert.deepEqual(restored.getEntries(), source.getEntries());
  assert.deepEqual(restored.getBranch(), source.getBranch());
  assert.deepEqual(restored.buildSessionContext(), source.buildSessionContext());
  assert.equal(restored.getLabel(kept), "bookmark");
  assert.equal(restored.getSessionName(), "named");
  restored.appendMessage({ role: "user", content: "next", timestamp: 4 });
  assert.equal(restored.getLeafEntry()!.parentId, record.leafId);
  assert.equal(source.getEntries().length, record.entries.length);
});

test("SQL optimistic writes reject stale updates instead of overwriting history", async () => {
  const store = new DatabaseStore(async () => ({ rows: [], changes: 0 }), async () => {});
  const paths = tenantPaths("/tmp", tenant);
  await assert.rejects(store.put(paths, "session", "id", {}, 4), /changed concurrently/);
  await assert.rejects(store.remove(paths, "session", "id", 4), /changed concurrently/);
});

test("concurrent creates of the same record surface as conflicts on every SQL dialect", async () => {
  const paths = tenantPaths("/tmp", tenant);
  const sqlite = Object.assign(new Error("UNIQUE constraint failed"), { errcode: 1555 });
  const mysql = Object.assign(new Error("Duplicate entry"), { errno: 1062, code: "ER_DUP_ENTRY" });
  const pgsql = Object.assign(new Error("duplicate key value"), { code: "23505" });
  for (const error of [sqlite, mysql, pgsql]) {
    const store = new DatabaseStore(async () => { throw error; }, async () => {});
    await assert.rejects(store.put(paths, "project", "id", {}, 0), /changed concurrently/);
  }
  const other = new DatabaseStore(async () => { throw new Error("connection refused"); }, async () => {});
  await assert.rejects(other.put(paths, "project", "id", {}, 0), /connection refused/);
});

test("file mode lists and inspects old-format sessions without rewriting them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-list-"));
  try {
    const paths = tenantPaths(dir, tenant);
    await mkdir(paths.sessionDir, { recursive: true });
    const timestamp = new Date().toISOString();
    // pi v1: no header version and no entry IDs; SessionManager.open() would migrate and rewrite it.
    const original = [
      { type: "session", id: "legacy", timestamp, cwd: paths.userHome },
      { type: "custom", customType: "pi-forge.agent", data: { agentId: "assistant" }, timestamp },
      { type: "custom", customType: "pi-forge.project", data: { projectId: "p1" }, timestamp },
      { type: "message", timestamp, message: { role: "user", content: "legacy history", timestamp: 1 } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    const file = join(paths.sessionDir, "2026-01-01T00-00-00-000Z_legacy.jsonl");
    await writeFile(file, original);
    const [listed] = await listSessions(paths);
    assert.equal(listed!.id, "legacy");
    assert.equal(listed!.agentId, "assistant");
    assert.equal(listed!.projectId, "p1");
    assert.deepEqual(await getSessionInfo(paths, "legacy"), { id: "legacy", agentId: "assistant", projectId: "p1" });
    assert.equal(await readFile(file, "utf8"), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("artifact index lists the latest revision of each existing conversation, newest first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-artifacts-"));
  try {
    const paths = tenantPaths(dir, tenant);
    await mkdir(paths.sessionDir, { recursive: true });
    const timestamp = new Date().toISOString();
    for (const [id, name] of [["older", "Older page"], ["newer", "Newer page"], ["plain", "No artifact"]]) {
      const lines = [
        { type: "session", version: 3, id, timestamp, cwd: paths.userHome },
        { type: "custom", id: `${id}-a`, parentId: null, customType: "pi-forge.agent", data: { agentId: "html-designer" }, timestamp },
        { type: "message", id: `${id}-m`, parentId: `${id}-a`, timestamp, message: { role: "user", content: name, timestamp: 1 } },
      ];
      await writeFile(join(paths.sessionDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`), lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
    const page = (text: string) => `<!doctype html><html><head><title>${text}</title></head><body><p>${text}</p></body></html>`;
    assert.ok((await ArtifactStore.forSession(paths, "older").publish(page("one"))).ok);
    await new Promise((r) => setTimeout(r, 5));
    assert.ok((await ArtifactStore.forSession(paths, "newer").publish(page("first"))).ok);
    assert.ok((await ArtifactStore.forSession(paths, "newer").publish(page("second"))).ok);
    // Artifacts of a conversation that no longer exists are not listed.
    assert.ok((await ArtifactStore.forSession(paths, "deleted").publish(page("orphan"))).ok);
    const list = await listAllArtifacts(paths);
    assert.deepEqual(list.map((a) => [a.sessionId, a.revision, a.revisions, a.sessionName, a.agentId]), [
      ["newer", 2, 2, "Newer page", "html-designer"],
      ["older", 1, 1, "Older page", "html-designer"],
    ]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("database write failures are retained and surfaced at flush and further appends", async () => {
  const store = new DatabaseStore(async () => { throw new Error("database unavailable"); }, async () => {});
  const manager = SessionManager.inMemory("/tmp");
  persistSession(tenantPaths("/tmp", tenant), manager, 0, false, store);
  manager.appendMessage({ role: "user", content: "must not vanish silently", timestamp: 1 });
  await assert.rejects(flushSession(manager), /database unavailable/);
  assert.throws(() => manager.appendSessionInfo("next"), /database unavailable/);
});

test("offline file import preserves entries and pins, is repeatable, and never rewrites sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-migrate-"));
  try {
    const paths = tenantPaths(dir, tenant);
    await mkdir(paths.sessionDir, { recursive: true });
    await mkdir(join(paths.userHome, "projects"), { recursive: true });
    const manager = SessionManager.inMemory(paths.userHome);
    manager.appendCustomEntry("pi-forge.agent", { agentId: "assistant" });
    manager.appendCustomEntry("pi-forge.project", { projectId: "project-import" });
    manager.appendMessage({ role: "user", content: "source history", timestamp: 1 });
    manager.appendSessionInfo("Imported title");
    const original = [manager.getHeader(), ...manager.getEntries()].map((e) => JSON.stringify(e)).join("\n") + "\n";
    const source = join(paths.sessionDir, `source_${manager.getSessionId()}.jsonl`);
    await writeFile(source, original);
    await writeFile(paths.pinsFile, JSON.stringify({ pinned: [manager.getSessionId()] }));
    const project: Project = { id: "project-import", name: "Imported", instructions: "retained", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
    await writeFile(join(paths.userHome, "projects/project-import.json"), JSON.stringify(project));
    const path = join(dir, "migrated.sqlite");
    const env = { ...process.env, FORGE_ENV_FILE: "/nonexistent", FORGE_DATA_DIR: dir, FORGE_STORAGE: "sqlite", FORGE_SQLITE_PATH: path };
    const execute = () => promisify(execFile)(process.execPath, ["--import", "tsx", join(root, "runtime/src/memory/migrate.ts")], { cwd: root, env });
    assert.match((await execute()).stdout, /Imported 2 records; skipped 0/);
    assert.match((await execute()).stdout, /Imported 0 records; skipped 2/);
    assert.equal(await readFile(source, "utf8"), original);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path);
    try {
      const row = db.prepare("SELECT payload FROM forge_records WHERE kind = 'session'").get() as { payload: string };
      const record = JSON.parse(row.payload) as SessionRecord;
      assert.equal(record.pinned, true);
      assert.deepEqual(restoreSession(paths.userHome, record).getEntries(), manager.getEntries());
      assert.deepEqual(JSON.parse((db.prepare("SELECT payload FROM forge_records WHERE kind = 'project'").get() as { payload: string }).payload), project);
    } finally { db.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const driver of ["file", "sqlite", "mysql", "pgsql"]) {
  const url = driver === "mysql" ? process.env.FORGE_TEST_MYSQL_URL : process.env.FORGE_TEST_PGSQL_URL;
  test(`${driver}: projects, persistence, restart, isolation and busy mutations`, { skip: (driver === "mysql" || driver === "pgsql") && !url }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), `forge-${driver}-`));
    const scopedTenant = { ...tenant, workspace: `test-${crypto.randomUUID()}` };
    let lastRequest: unknown;
    const fake = await startFakeOpenAI({ onRequest: (body) => { lastRequest = body; } });
    const env = {
      ...process.env, FORGE_ENV_FILE: "/nonexistent", FORGE_STORAGE: driver,
      FORGE_DATABASE_URL: url, FORGE_SQLITE_PATH: join(dataDir, "test.sqlite"),
      FORGE_DATA_DIR: dataDir, FORGE_AGENTS_DIR: join(root, "agents"),
      PI_MODEL_PROVIDER: "custom", PI_MODEL_PROTOCOL: "openai-completions", PI_MODEL_ID: "fake-model",
      PI_MODEL_BASE_URL: fake.baseUrl, PI_MODEL_API_KEY: "test-key",
    };
    function start() {
      const child = spawn(process.execPath, ["--import", "tsx", join(root, "runtime/src/main.ts")], { cwd: root, env });
      let stderr = "";
      child.stderr.on("data", (data) => { stderr += data; });
      const peer = new Peer(child.stdout, (line) => child.stdin.write(line));
      const pending = new Map<string, (event: RunEventParams["event"]) => void>();
      peer.handle("run.event", (event: RunEventParams) => {
        if (event.event.type === "run_finished") pending.get(event.runId)?.(event.event);
      });
      peer.handle("tool.authorize", () => ({ decision: "allow" }));
      peer.handle("user.ask", () => ({ status: "skipped" }));
      return {
        peer,
        async stop() { const exited = once(child, "exit"); child.stdin.end(); await exited; },
        async run(text: string, options: { projectId?: string; sessionId?: string } = {}) {
          const runId = crypto.randomUUID();
          const done = new Promise<RunEventParams["event"]>((resolve) => pending.set(runId, resolve));
          const result = await peer.request<{ sessionId: string }>("run.start", { tenant: scopedTenant, agentId: "assistant", runId, input: { text }, ...options });
          const end = await done;
          assert.ok(end.type === "run_finished" && end.status === "completed", `${JSON.stringify(end)} ${stderr}`);
          pending.delete(runId);
          return result.sessionId;
        },
      };
    }
    let runtime = start();
    try {
      await runtime.peer.request("runtime.hello", {});
      const project = await runtime.peer.request<Project>("project.create", { tenant: scopedTenant, name: "Launch", instructions: "Always include PROJECT_TOKEN_42." });
      assert.equal(project.name, "Launch");
      await assert.rejects(runtime.peer.request("project.create", { tenant: scopedTenant, name: " " }), /name must/);
      await assert.rejects(runtime.peer.request("project.update", { tenant: scopedTenant, projectId: project.id, instructions: "x".repeat(20001) }), /instructions/);
      const sid = await runtime.run("remember first", { projectId: project.id });
      assert.match(JSON.stringify(lastRequest), /PROJECT_TOKEN_42/);
      await runtime.run('!ask_user {"questions":[{"header":"Next","question":"Continue?","options":["Yes","No"]}]}', { sessionId: sid });
      const before = await runtime.peer.request<SessionDetail>("session.get", { tenant: scopedTenant, sessionId: sid });
      assert.equal(before.projectId, project.id);
      assert.ok(before.messages.some((m) => m.role === "tool" && m.toolName === "ask_user"));
      await runtime.peer.request("session.update", { tenant: scopedTenant, sessionId: sid, name: "Saved", pinned: true });
      await runtime.peer.request("project.update", { tenant: scopedTenant, projectId: project.id, name: "Renamed", instructions: "UPDATED_PROJECT_TOKEN" });
      await runtime.stop();
      runtime = start();
      await runtime.run("after restart", { sessionId: sid });
      assert.match(JSON.stringify(lastRequest), /remember first/);
      assert.match(JSON.stringify(lastRequest), /UPDATED_PROJECT_TOKEN/);
      assert.doesNotMatch(JSON.stringify(lastRequest), /PROJECT_TOKEN_42/);
      const list = await runtime.peer.request<SessionSummary[]>("session.list", { tenant: scopedTenant, projectId: project.id });
      assert.equal(list.length, 1);
      assert.equal(list[0]!.name, "Saved");
      assert.equal(list[0]!.pinned, true);
      const otherProject = await runtime.peer.request<Project>("project.create", { tenant: scopedTenant, name: "Other" });
      await assert.rejects(runtime.run("mismatch", { projectId: otherProject.id, sessionId: sid }), /different project/);
      await assert.rejects(runtime.run("missing", { projectId: "missing" }), /project not found/);
      const plain = await runtime.run("independent");
      assert.doesNotMatch(JSON.stringify(lastRequest), /UPDATED_PROJECT_TOKEN|remember first/);
      const otherSession = await runtime.run("other project", { projectId: otherProject.id });
      assert.doesNotMatch(JSON.stringify(lastRequest), /UPDATED_PROJECT_TOKEN|remember first/);
      // Moving a conversation between projects: the next turn uses the new project's instructions.
      await runtime.peer.request("project.update", { tenant: scopedTenant, projectId: otherProject.id, instructions: "OTHER_PROJECT_TOKEN" });
      await assert.rejects(runtime.peer.request("session.update", { tenant: scopedTenant, sessionId: sid, projectId: "missing" }), /project not found/);
      await assert.rejects(runtime.peer.request("session.update", { tenant: scopedTenant, sessionId: sid, projectId: 7 }), /projectId must be/);
      await runtime.peer.request("session.update", { tenant: scopedTenant, sessionId: sid, projectId: null });
      assert.equal((await runtime.peer.request<SessionDetail>("session.get", { tenant: scopedTenant, sessionId: sid })).projectId, undefined);
      await runtime.run("unfiled turn", { sessionId: sid });
      assert.doesNotMatch(JSON.stringify(lastRequest), /UPDATED_PROJECT_TOKEN|OTHER_PROJECT_TOKEN/);
      await runtime.peer.request("session.update", { tenant: scopedTenant, sessionId: sid, projectId: otherProject.id });
      await runtime.run("moved turn", { sessionId: sid });
      assert.match(JSON.stringify(lastRequest), /OTHER_PROJECT_TOKEN/);
      assert.doesNotMatch(JSON.stringify(lastRequest), /UPDATED_PROJECT_TOKEN/);
      const moved = await runtime.peer.request<SessionSummary[]>("session.list", { tenant: scopedTenant });
      assert.equal(moved.find((s) => s.id === sid)!.projectId, otherProject.id);
      await runtime.peer.request("session.update", { tenant: scopedTenant, sessionId: sid, projectId: project.id });
      assert.equal((await runtime.peer.request<SessionDetail>("session.get", { tenant: scopedTenant, sessionId: sid })).projectId, project.id);
      for (const foreign of [{ ...scopedTenant, userId: "other" }, { ...scopedTenant, workspace: "other" }, ...(driver === "file" ? [] : [{ ...scopedTenant, userId: scopedTenant.userId.toUpperCase() }])]) {
        assert.deepEqual(await runtime.peer.request("session.list", { tenant: foreign }), []);
        assert.deepEqual(await runtime.peer.request("project.list", { tenant: foreign }), []);
        await assert.rejects(runtime.peer.request("session.get", { tenant: foreign, sessionId: sid }), /not found/);
        await assert.rejects(runtime.peer.request("project.update", { tenant: foreign, projectId: project.id, name: "stolen" }), /not found/);
      }
      await assert.rejects(runtime.peer.request("project.delete", { tenant: scopedTenant, projectId: project.id }), /contains conversations/);
      // Pending questions outlive UI detachment. Their assistant/tool call history must already be durable.
      let release!: (answer: { status: string }) => void;
      let asked!: () => void;
      const waiting = new Promise<void>((resolve) => { asked = resolve; });
      runtime.peer.handle("user.ask", () => { asked(); return new Promise((resolve) => { release = resolve; }); });
      const active = runtime.run('!ask_user {"questions":[{"header":"Next","question":"Wait?","options":["Yes","No"]}]}', { sessionId: sid });
      await waiting;
      const waitingDetail = await runtime.peer.request<SessionDetail>("session.get", { tenant: scopedTenant, sessionId: sid });
      assert.ok(waitingDetail.messages.some((m) => m.role === "assistant" && m.toolCalls?.some((t) => t.name === "ask_user")));
      await assert.rejects(runtime.peer.request("session.delete", { tenant: scopedTenant, sessionId: sid }), /busy/);
      await assert.rejects(runtime.peer.request("session.update", { tenant: scopedTenant, sessionId: sid, name: "busy" }), /busy/);
      release({ status: "skipped" });
      await active;
      if (driver !== "file") {
        const files = await readdir(dataDir, { recursive: true });
        assert.ok(!files.some((file) => file.endsWith(".jsonl") || file.endsWith("pins.json") || /projects.*\.json$/.test(file)), files.join("\n"));
      }
      for (const sessionId of [sid, plain, otherSession]) await runtime.peer.request("session.delete", { tenant: scopedTenant, sessionId });
      for (const projectId of [project.id, otherProject.id]) await runtime.peer.request("project.delete", { tenant: scopedTenant, projectId });
      assert.deepEqual(await runtime.peer.request("project.list", { tenant: scopedTenant }), []);
    } finally {
      await runtime.stop();
      await fake.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}
