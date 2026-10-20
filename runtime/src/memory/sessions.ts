import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { ArtifactStore } from "../artifacts/store.ts";
import { RpcError } from "../ipc/peer.ts";
import { ErrorCodes, type SessionDetail, type SessionInfo, type SessionSummary, type TranscriptMessage } from "../protocol.ts";
import type { TenantPaths } from "../tenant.ts";

/**
 * Memory = pi's own session storage. No custom persistence or retention logic lives here:
 * - history: SessionManager JSONL files (pi session format), one directory per workspace/user/agent
 * - context window: pi auto-compaction (configured through SettingsManager in run.ts)
 * - durable instructions: pi context files (AGENTS.md), see run.ts
 * This module only maps tenant paths onto SessionManager and shapes transcripts for the UI.
 *
 * Sessions live at the user level, shared by all agents. Each records the agent it was started with
 * as a pi custom entry (not part of the LLM context), so it is always continued by that agent.
 */

const AGENT_ENTRY = "pi-forge.agent";

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

/** Reads only the head of the file: the binding is written before the first prompt. */
async function readAgentFromFile(path: string): Promise<string | undefined> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      if (!line.includes(AGENT_ENTRY)) continue;
      try {
        const entry = JSON.parse(line) as { type?: string; customType?: string; data?: { agentId?: unknown } };
        if (entry.type === "custom" && entry.customType === AGENT_ENTRY && typeof entry.data?.agentId === "string") {
          return entry.data.agentId;
        }
      } catch {
        // a line cut by the 64 KiB window
      }
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export async function openSession(paths: TenantPaths, sessionId?: string): Promise<SessionManager> {
  await mkdir(paths.sessionDir, { recursive: true });
  if (!sessionId) return SessionManager.create(paths.userHome, paths.sessionDir);
  return SessionManager.open(await findSessionFile(paths, sessionId), paths.sessionDir, paths.userHome);
}

export async function listSessions(paths: TenantPaths): Promise<SessionSummary[]> {
  if (!existsSync(paths.sessionDir)) return [];
  const sessions = await SessionManager.list(paths.userHome, paths.sessionDir);
  const agents = await Promise.all(sessions.map((s) => readAgentFromFile(s.path).catch(() => undefined)));
  const pins = await readPins(paths);
  return sessions
    .map((s, i) => ({ s, agentId: agents[i], pinned: pins.has(s.id) }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.s.modified.getTime() - a.s.modified.getTime())
    .map(({ s, agentId, pinned }) => ({
      id: s.id,
      agentId,
      pinned: pinned || undefined,
      name: s.name,
      createdAt: s.created.toISOString(),
      updatedAt: s.modified.toISOString(),
      messageCount: s.messageCount,
      preview: s.firstMessage.slice(0, 120),
    }));
}

export async function getSession(paths: TenantPaths, sessionId: string): Promise<SessionDetail> {
  const manager = SessionManager.open(await findSessionFile(paths, sessionId), paths.sessionDir, paths.userHome);
  return {
    id: manager.getSessionId(),
    agentId: sessionAgent(manager),
    name: manager.getSessionName(),
    messages: toTranscript(manager.getBranch()),
  };
}

export async function getSessionInfo(paths: TenantPaths, sessionId: string): Promise<SessionInfo> {
  return { id: sessionId, agentId: await readAgentFromFile(await findSessionFile(paths, sessionId)) };
}

export async function deleteSession(paths: TenantPaths, sessionId: string): Promise<void> {
  await rm(await findSessionFile(paths, sessionId));
  await ArtifactStore.forSession(paths, sessionId).remove();
  await setPinned(paths, sessionId, false);
}

const MAX_NAME = 80;

/**
 * Rename appends pi's own session_info entry. It must not race a run on the same session: two
 * SessionManagers appending to one file would fork the entry tree, so busy sessions are refused.
 */
export async function updateSession(
  paths: TenantPaths,
  sessionId: string,
  update: { name?: unknown; pinned?: unknown },
  isBusy: (sessionKey: string) => boolean,
): Promise<void> {
  const file = await findSessionFile(paths, sessionId);
  if (update.name !== undefined) {
    const name = typeof update.name === "string" ? update.name.replace(/[\r\n]+/g, " ").trim() : "";
    if (!name || name.length > MAX_NAME) throw new RpcError(ErrorCodes.invalidParams, `name must be 1..${MAX_NAME} characters`);
    if (isBusy(sessionKey(paths, sessionId))) throw new RpcError(ErrorCodes.conflict, "session is busy");
    SessionManager.open(file, paths.sessionDir, paths.userHome).appendSessionInfo(name);
  }
  if (update.pinned !== undefined) {
    if (typeof update.pinned !== "boolean") throw new RpcError(ErrorCodes.invalidParams, "pinned must be a boolean");
    await setPinned(paths, sessionId, update.pinned);
  }
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
function toTranscript(entries: SessionEntry[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const entry of entries) {
    if (entry.type === "compaction") {
      out.push({ role: "summary", text: entry.summary });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message as { role: string; [key: string]: any };
    if (message.role === "user") {
      out.push({ role: "user", text: textOf(message.content), timestamp: message.timestamp });
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
        artifactRevision: typeof revision === "number" && !message.isError ? revision : undefined,
      });
    }
  }
  return out;
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}
