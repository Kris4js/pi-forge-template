import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { RpcError } from "../ipc/peer.ts";
import { ErrorCodes, type SessionDetail, type SessionSummary, type TranscriptMessage } from "../protocol.ts";
import type { TenantPaths } from "../tenant.ts";

/**
 * Memory = pi's own session storage. No custom persistence or retention logic lives here:
 * - history: SessionManager JSONL files (pi session format), one directory per workspace/user/agent
 * - context window: pi auto-compaction (configured through SettingsManager in run.ts)
 * - durable instructions: pi context files (AGENTS.md), see run.ts
 * This module only maps tenant paths onto SessionManager and shapes transcripts for the UI.
 */

const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export async function openSession(paths: TenantPaths, sessionId?: string): Promise<SessionManager> {
  await mkdir(paths.sessionDir, { recursive: true });
  if (!sessionId) return SessionManager.create(paths.agentHome, paths.sessionDir);
  return SessionManager.open(await findSessionFile(paths, sessionId), paths.sessionDir, paths.agentHome);
}

export async function listSessions(paths: TenantPaths): Promise<SessionSummary[]> {
  if (!existsSync(paths.sessionDir)) return [];
  const sessions = await SessionManager.list(paths.agentHome, paths.sessionDir);
  return sessions
    .sort((a, b) => b.modified.getTime() - a.modified.getTime())
    .map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: s.created.toISOString(),
      updatedAt: s.modified.toISOString(),
      messageCount: s.messageCount,
      preview: s.firstMessage.slice(0, 120),
    }));
}

export async function getSession(paths: TenantPaths, sessionId: string): Promise<SessionDetail> {
  const manager = SessionManager.open(await findSessionFile(paths, sessionId), paths.sessionDir, paths.agentHome);
  return {
    id: manager.getSessionId(),
    name: manager.getSessionName(),
    messages: toTranscript(manager.getBranch()),
  };
}

export async function deleteSession(paths: TenantPaths, sessionId: string): Promise<void> {
  await rm(await findSessionFile(paths, sessionId));
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
      out.push({
        role: "tool",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        text: textOf(message.content),
        isError: Boolean(message.isError),
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
