import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, relative, isAbsolute } from "node:path";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { ATTACHMENT_NOTES, attachmentMimeType } from "../attachments.ts";
import { IMAGE_ENTRY } from "../image-assets.ts";
import type { FileAsset, ImageAsset } from "../protocol.ts";
import { ArtifactStore } from "../artifacts/store.ts";
import { RpcError } from "../ipc/peer.ts";
import { ErrorCodes, type ArtifactEntry, type SessionDetail, type SessionInfo, type SessionSummary, type TranscriptMessage } from "../protocol.ts";
import type { TenantPaths } from "../tenant.ts";
import { database } from "./database.ts";
import { persistSession, restoreSession, type SessionRecord } from "./managed-session.ts";

/** Sessions keep pi's entry tree in either JSONL or the configured database.
 * Agent and project bindings are custom entries, outside the model's context. The agent binding is
 * fixed; the project binding may be re-appended (moved between projects), and the last one wins
 * (`projectId: null` = no project).
 */

const AGENT_ENTRY = "pi-forge.agent";
const PROJECT_ENTRY = "pi-forge.project";

/** The latest project binding of an entry list; undefined when unbound or removed. */
function latestProject(entries: readonly SessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === "custom" && e.customType === PROJECT_ENTRY) {
      const projectId = (e.data as { projectId?: unknown } | undefined)?.projectId;
      return typeof projectId === "string" ? projectId : undefined;
    }
  }
  return undefined;
}

export function sessionProject(manager: SessionManager): string | undefined {
  return latestProject(manager.getEntries());
}

export function bindProject(manager: SessionManager, projectId: string | null): void {
  manager.appendCustomEntry(PROJECT_ENTRY, { projectId });
}

export async function storedSession(paths: TenantPaths, sessionId: string) {
  if (!SESSION_ID.test(sessionId)) throw new RpcError(ErrorCodes.invalidParams, "invalid sessionId");
  const record = await database!.get<SessionRecord>(paths, "session", sessionId);
  if (!record) throw new RpcError(ErrorCodes.notFound, "session not found");
  return record;
}

/** Summarize a stored record directly: no clone or tree index per listed session. */
function summary(record: SessionRecord): SessionSummary {
  let agentId: string | undefined;
  let name: string | undefined;
  let messageCount = 0;
  let preview: string | undefined;
  for (const e of record.entries) {
    if (e.type === "message") {
      messageCount++;
      if (preview === undefined && e.message.role === "user") preview = textOf(e.message.content).slice(0, 120);
    } else if (e.type === "session_info") name = e.name?.trim() || undefined;
    else if (e.type === "custom" && agentId === undefined && e.customType === AGENT_ENTRY) {
      const data = e.data as { agentId?: unknown } | undefined;
      if (typeof data?.agentId === "string") agentId = data.agentId;
    }
  }
  return {
    id: record.header.id, agentId, projectId: latestProject(record.entries), name, pinned: record.pinned || undefined,
    createdAt: record.header.timestamp, updatedAt: record.updatedAt, messageCount, preview: preview ?? "",
  };
}

/** The agent a session is bound to, from its custom entry. */
export function sessionAgent(manager: SessionManager): string | undefined {
  for (const entry of manager.getEntries()) {
    if (entry.type === "custom" && entry.customType === AGENT_ENTRY) {
      const agentId = (entry.data as { agentId?: unknown } | undefined)?.agentId;
      if (typeof agentId === "string") return agentId;
    }
  }
  return undefined;
}

export function bindAgent(manager: SessionManager, agentId: string): void {
  manager.appendCustomEntry(AGENT_ENTRY, { agentId });
}

type Bindings = { agentId?: string; projectId?: string };

/**
 * Streams the file without SessionManager.open() (which may rewrite old formats) and parses only the
 * binding lines: the first agent binding, the last project binding.
 */
async function readBindingsFromFile(path: string): Promise<Bindings> {
  const found: Bindings = {};
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    const agent = found.agentId === undefined && line.includes(AGENT_ENTRY);
    if (!agent && !line.includes(PROJECT_ENTRY)) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; customType?: string; data?: { agentId?: unknown; projectId?: unknown } };
      if (entry.type !== "custom") continue;
      if (agent && entry.customType === AGENT_ENTRY && typeof entry.data?.agentId === "string") found.agentId = entry.data.agentId;
      if (entry.customType === PROJECT_ENTRY) found.projectId = typeof entry.data?.projectId === "string" ? entry.data.projectId : undefined;
    } catch {
      // not a complete entry line
    }
  }
  return found;
}

const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export async function openSession(paths: TenantPaths, sessionId?: string): Promise<SessionManager> {
  if (database) {
    const stored = sessionId ? await storedSession(paths, sessionId) : undefined;
    const manager = stored ? restoreSession(paths.userHome, stored.value) : SessionManager.inMemory(paths.userHome);
    persistSession(paths, manager, stored?.version ?? 0, stored?.value.pinned);
    return manager;
  }
  await mkdir(paths.sessionDir, { recursive: true });
  if (!sessionId) return SessionManager.create(paths.userHome, paths.sessionDir);
  return SessionManager.open(await findSessionFile(paths, sessionId), paths.sessionDir, paths.userHome);
}

export async function listSessions(paths: TenantPaths): Promise<SessionSummary[]> {
  if (database) {
    const records = await database.list<SessionRecord>(paths, "session");
    return records.map(summary)
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  }
  if (!existsSync(paths.sessionDir)) return [];
  const sessions = await SessionManager.list(paths.userHome, paths.sessionDir);
  const bindings = await Promise.all(sessions.map((s) => readBindingsFromFile(s.path).catch((): Bindings => ({}))));
  const pins = await readPins(paths);
  return sessions
    .map((s, i) => ({ s, ...bindings[i], pinned: pins.has(s.id) }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.s.modified.getTime() - a.s.modified.getTime())
    .map(({ s, agentId, projectId, pinned }) => ({
      id: s.id,
      agentId,
      projectId,
      pinned: pinned || undefined,
      name: s.name,
      createdAt: s.created.toISOString(),
      updatedAt: s.modified.toISOString(),
      messageCount: s.messageCount,
      preview: s.firstMessage.slice(0, 120),
    }));
}

export async function getSession(paths: TenantPaths, sessionId: string): Promise<SessionDetail> {
  const manager = await openSession(paths, sessionId);
  return {
    id: manager.getSessionId(),
    agentId: sessionAgent(manager),
    projectId: sessionProject(manager),
    name: manager.getSessionName(),
    messages: toTranscript(manager.getBranch(), paths.userHome),
  };
}

export async function getSessionInfo(paths: TenantPaths, sessionId: string): Promise<SessionInfo> {
  if (database) {
    const { agentId, projectId } = summary((await storedSession(paths, sessionId)).value);
    return { id: sessionId, agentId, projectId };
  }
  return { id: sessionId, ...(await readBindingsFromFile(await findSessionFile(paths, sessionId))) };
}

/** Artifacts of the user's existing conversations: one entry per conversation, its latest revision. */
export async function listAllArtifacts(paths: TenantPaths): Promise<ArtifactEntry[]> {
  const sessions = await listSessions(paths);
  const entries = await Promise.all(sessions.map(async (s): Promise<ArtifactEntry | undefined> => {
    const revisions = await ArtifactStore.forSession(paths, s.id).list().catch(() => []);
    const latest = revisions.at(-1);
    if (!latest) return undefined;
    const sessionName = (s.name || s.preview || "").replace(/\s+/g, " ").trim();
    return { ...latest, sessionId: s.id, sessionName, agentId: s.agentId, projectId: s.projectId, revisions: revisions.length };
  }));
  return entries.filter((e): e is ArtifactEntry => !!e).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteSession(paths: TenantPaths, sessionId: string): Promise<void> {
  if (database) {
    const stored = await storedSession(paths, sessionId);
    await database.remove(paths, "session", sessionId, stored.version);
  } else {
    await rm(await findSessionFile(paths, sessionId));
    await setPinned(paths, sessionId, false);
  }
  await ArtifactStore.forSession(paths, sessionId).remove();
}

const MAX_NAME = 80;

/**
 * Rename appends pi's own session_info entry; a project move appends a new project binding (null
 * removes it). Neither may race a run on the same session: two writers appending to one entry tree
 * would fork it, so busy sessions are refused. The caller checks that a target project exists.
 */
export async function updateSession(
  paths: TenantPaths,
  sessionId: string,
  update: { name?: unknown; pinned?: unknown; projectId?: string | null },
  isBusy: (sessionKey: string) => boolean,
): Promise<void> {
  let name: string | undefined;
  if (update.name !== undefined) {
    name = typeof update.name === "string" ? update.name.replace(/[\r\n]+/g, " ").trim() : "";
    if (!name || name.length > MAX_NAME) throw new RpcError(ErrorCodes.invalidParams, `name must be 1..${MAX_NAME} characters`);
  }
  if (update.pinned !== undefined && typeof update.pinned !== "boolean") {
    throw new RpcError(ErrorCodes.invalidParams, "pinned must be a boolean");
  }
  const appends = name !== undefined || update.projectId !== undefined;
  // With a database every write is versioned against the running session's own saves, pins included.
  if ((appends || database) && isBusy(sessionKey(paths, sessionId))) throw new RpcError(ErrorCodes.conflict, "session is busy");
  const apply = (manager: SessionManager) => {
    if (name !== undefined) manager.appendSessionInfo(name);
    if (update.projectId !== undefined && update.projectId !== (sessionProject(manager) ?? null)) bindProject(manager, update.projectId);
  };
  if (database) {
    const stored = await storedSession(paths, sessionId);
    if (appends) {
      const manager = restoreSession(paths.userHome, stored.value);
      apply(manager);
      stored.value.entries = manager.getEntries();
      stored.value.leafId = manager.getLeafId();
    }
    if (update.pinned !== undefined) stored.value.pinned = update.pinned as boolean;
    stored.value.updatedAt = new Date().toISOString();
    await database.put(paths, "session", sessionId, stored.value, stored.version);
    return;
  }
  const file = await findSessionFile(paths, sessionId);
  if (appends) apply(SessionManager.open(file, paths.sessionDir, paths.userHome));
  if (update.pinned !== undefined) await setPinned(paths, sessionId, update.pinned as boolean);
}

export function sessionKey(paths: TenantPaths, sessionId: string): string {
  return `${paths.sessionDir}:${sessionId}`;
}

async function readPins(paths: TenantPaths): Promise<Set<string>> {
  try {
    const data = JSON.parse(await readFile(paths.pinsFile, "utf8")) as { pinned?: unknown };
    return new Set(Array.isArray(data.pinned) ? data.pinned.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

let pinWrites: Promise<unknown> = Promise.resolve();

async function setPinned(paths: TenantPaths, sessionId: string, pinned: boolean): Promise<void> {
  const write = async () => {
    const pins = await readPins(paths);
    if (pins.has(sessionId) === pinned) return;
    if (pinned) pins.add(sessionId);
    else pins.delete(sessionId);
    await mkdir(paths.userHome, { recursive: true });
    const tmp = `${paths.pinsFile}.tmp`;
    await writeFile(tmp, JSON.stringify({ pinned: [...pins] }, null, 2), "utf8");
    await rename(tmp, paths.pinsFile);
  };
  const next = pinWrites.then(write, write);
  pinWrites = next.catch(() => {});
  await next;
}

/** pi names files `<timestamp>_<sessionId>.jsonl`. */
async function findSessionFile(paths: TenantPaths, sessionId: string): Promise<string> {
  if (!SESSION_ID.test(sessionId)) throw new RpcError(ErrorCodes.invalidParams, "invalid sessionId");
  const files = existsSync(paths.sessionDir) ? await readdir(paths.sessionDir) : [];
  const file = files.find((name) => name.endsWith(`_${sessionId}.jsonl`));
  if (!file) throw new RpcError(ErrorCodes.notFound, "session not found");
  return join(paths.sessionDir, file);
}

/** Active branch (root -> leaf) rendered for display. Compactions appear as a summary marker. */
function toTranscript(entries: SessionEntry[], userHome: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let pending: { text: string; promptText: string; images: ImageAsset[]; files?: FileAsset[] } | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === IMAGE_ENTRY) {
      pending = entry.data as typeof pending;
      continue;
    }
    if (entry.type === "compaction") {
      out.push({ role: "summary", text: entry.summary });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message as { role: string; [key: string]: any };
    if (message.role === "user") {
      const text = textOf(message.content);
      const matching = pending?.promptText === text ? pending : undefined;
      const recovered = matching ? undefined : fromAttachmentPrompt(text, userHome);
      const files = matching?.files ?? recovered?.files;
      out.push({ role: "user", text: matching?.text ?? recovered!.text, images: matching?.images?.length ? matching.images : undefined, files: files?.length ? files : undefined, timestamp: message.timestamp });
      pending = undefined;
    } else if (message.role === "assistant") {
      const blocks: any[] = Array.isArray(message.content) ? message.content : [];
      const toolCalls = blocks
        .filter((b) => b.type === "toolCall")
        .map((b) => ({ id: b.id as string, name: b.name as string, args: b.arguments }));
      const thinking = blocks
        .filter((b) => b.type === "thinking")
        .map((b) => b.thinking as string)
        .join("\n");
      out.push({
        role: "assistant",
        text: textOf(blocks),
        thinking: thinking || undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        error: message.errorMessage,
        timestamp: message.timestamp,
      });
    } else if (message.role === "toolResult") {
      const revision = message.details?.artifact?.revision;
      out.push({
        role: "tool",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        text: textOf(message.content),
        isError: Boolean(message.isError),
        images: !message.isError ? message.details?.images : undefined,
        artifactRevision: typeof revision === "number" && !message.isError ? revision : undefined,
      });
    }
  }
  return out;
}

/** Sessions recorded before attachment metadata was stored: split the expanded prompt back into typed text and file cards. */
function fromAttachmentPrompt(prompt: string, userHome: string): { text: string; files?: FileAsset[] } {
  const at = prompt.indexOf(ATTACHMENT_NOTES);
  if (at < 0) return { text: prompt };
  const notes = prompt.slice(at).replace(/<attachment-content name="[^\n]*">[\s\S]*?<\/attachment-content>/g, "");
  const files: FileAsset[] = [];
  for (const [, name, path] of notes.matchAll(/^附件 ("(?:[^"\\]|\\.)*")，已保存至 ("(?:[^"\\]|\\.)*")$/gm)) {
    const file = { name: JSON.parse(name!) as string, path: JSON.parse(path!) as string };
    if (/\.(png|jpe?g|webp)$/i.test(file.name)) continue;
    files.push({ name: file.name, mimeType: attachmentMimeType(file.name), size: attachmentSize(userHome, file.path) });
  }
  return { text: prompt.slice(0, at), files };
}

/** Size of a stored attachment, read only from this user's attachment folder. */
function attachmentSize(userHome: string, path: string): number | undefined {
  const rel = relative(join(userHome, "attachments"), path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  try { return statSync(path).size; } catch { return undefined; }
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}
