import type { FileAsset, ImageAsset, RunEvent, TranscriptMessage, Usage } from "./api";

export type ToolStatus = "running" | "pending" | "waiting" | "success" | "error" | "denied";

export type Approval = { state: "pending" | "approved" | "rejected"; reason?: string; by?: string; expiresAt?: string };

export type Item =
  | { kind: "user"; key: string; text: string; at?: number; images?: ImageAsset[]; files?: FileAsset[] }
  | {
      kind: "assistant";
      key: string;
      text: string;
      thinking: string;
      error?: string;
      /** Still receiving deltas. */
      open: boolean;
      thinkingStartedAt?: number;
      thinkingMs?: number;
    }
  | {
      kind: "tool";
      key: string;
      id: string;
      name: string;
      args: unknown;
      result?: string;
      status: ToolStatus;
      approval?: Approval;
      /** ask_user: how the user answered (live runs; reloads read it from the tool result). */
      question?: { status: string; answer?: string };
      /** Artifact revision this call published. */
      artifactRevision?: number;
      images?: ImageAsset[];
      startedAt?: number;
      durationMs?: number;
    }
  | { kind: "summary"; key: string; text: string }
  | { kind: "status"; key: string; status: string; error?: string; usage?: Usage; model?: string; durationMs?: number };

let seq = 0;
const key = () => `i${++seq}`;

/** Rebuild the view from a stored pi session (GET /v1/agents/:id/sessions/:sid). */
export function fromTranscript(messages: TranscriptMessage[]): Item[] {
  const items: Item[] = [];
  for (const m of messages) {
    if (m.role === "user") items.push({ kind: "user", key: key(), text: m.text, at: m.timestamp, images: m.images, files: m.files });
    else if (m.role === "summary") items.push({ kind: "summary", key: key(), text: m.text });
    else if (m.role === "assistant") {
      if (m.text || m.thinking || m.error) {
        items.push({ kind: "assistant", key: key(), text: m.text, thinking: m.thinking ?? "", error: m.error, open: false });
      }
      for (const call of m.toolCalls ?? []) {
        items.push({ kind: "tool", key: key(), id: call.id, name: call.name, args: call.args, status: "success" });
      }
    } else {
      const tool = items.find((i): i is Extract<Item, { kind: "tool" }> => i.kind === "tool" && i.id === m.toolCallId);
      if (tool) Object.assign(tool, { result: m.text, status: m.isError ? "error" : "success", artifactRevision: m.artifactRevision, images: m.images });
    }
  }
  return items;
}

export function userItem(text: string, files?: FileAsset[]): Item {
  return { kind: "user", key: key(), text, at: Date.now(), files: files?.length ? files : undefined };
}

/** Fold one streamed run event into the item list (immutably). */
export function applyEvent(items: Item[], e: RunEvent, ctx: { now: number; model?: string; runStartedAt?: number }): Item[] {
  const next = [...items];
  const last = next.at(-1);
  const updateTool = (id: string, patch: (t: Extract<Item, { kind: "tool" }>) => Partial<Extract<Item, { kind: "tool" }>>) =>
    next.map((i) => (i.kind === "tool" && i.id === id ? { ...i, ...patch(i) } : i));
  const closeThinking = (a: Extract<Item, { kind: "assistant" }>) =>
    a.thinkingStartedAt && a.thinkingMs === undefined ? { ...a, thinkingMs: ctx.now - a.thinkingStartedAt } : a;

  switch (e.type) {
    case "images": {
      if (e.toolCallId) return updateTool(e.toolCallId, () => ({ images: e.images }));
      const user = [...next].reverse().find((item) => item.kind === "user");
      return next.map((item) => item === user && item.kind === "user" ? { ...item, images: e.images } : item);
    }
    case "text_delta":
    case "thinking_delta": {
      const current: Extract<Item, { kind: "assistant" }> =
        last?.kind === "assistant" && last.open ? last : { kind: "assistant", key: key(), text: "", thinking: "", open: true };
      const updated =
        e.type === "text_delta"
          ? { ...closeThinking(current), text: current.text + e.delta }
          : { ...current, thinking: current.thinking + e.delta, thinkingStartedAt: current.thinkingStartedAt ?? ctx.now };
      return current === last ? [...next.slice(0, -1), updated] : [...next, updated];
    }
    case "message_end":
      if (last?.kind === "assistant" && last.open) {
        return [...next.slice(0, -1), { ...closeThinking(last), open: false, error: e.error }];
      }
      return e.error ? [...next, { kind: "assistant", key: key(), text: "", thinking: "", error: e.error, open: false }] : next;
    case "tool_start":
      return [
        ...next,
        { kind: "tool", key: key(), id: e.toolCallId, name: e.toolName, args: e.args, status: "running", startedAt: ctx.now },
      ];
    case "approval_required":
      return updateTool(e.toolCallId, () => ({ status: "pending", approval: { state: "pending", expiresAt: e.expiresAt } }));
    case "approval_resolved":
      return updateTool(e.toolCallId, () =>
        e.decision === "allow"
          ? { status: "running", approval: { state: "approved", by: e.by } }
          : { status: "denied", approval: { state: "rejected", reason: e.reason, by: e.by } },
      );
    case "question":
      return updateTool(e.toolCallId, () => ({ status: "waiting" }));
    case "question_resolved":
      return updateTool(e.toolCallId, () => ({ status: "running", question: { status: e.status, answer: e.answer } }));
    case "tool_end":
      return updateTool(e.toolCallId, (t) => ({
        result: e.result,
        status: t.status === "denied" ? "denied" : e.isError ? "error" : "success",
        durationMs: t.startedAt ? ctx.now - t.startedAt : undefined,
      }));
    case "artifact":
      return updateTool(e.toolCallId, () => ({ artifactRevision: e.revision }));
    case "compaction":
      return e.phase === "end" ? [...next, { kind: "summary", key: key(), text: "上下文已由 pi 自动压缩" }] : next;
    case "run_finished":
      return [
        ...next.map((i) => (i.kind === "assistant" && i.open ? { ...closeThinking(i), open: false } : i)),
        {
          kind: "status",
          key: key(),
          status: e.status,
          error: e.error,
          usage: e.usage,
          model: ctx.model,
          durationMs: ctx.runStartedAt ? ctx.now - ctx.runStartedAt : undefined,
        },
      ];
    default:
      return next;
  }
}
