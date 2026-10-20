/**
 * Gateway <-> runtime IPC contract (JSON-RPC 2.0 over stdio, one JSON object per LF-terminated line).
 * Mirrored in gateway/internal/ipc/protocol.go and described in docs/ipc-protocol.md.
 */

export const PROTOCOL_VERSION = 1;

export const Methods = {
  // gateway -> runtime (requests)
  hello: "runtime.hello",
  modelsList: "models.list",
  runStart: "run.start",
  runCancel: "run.cancel",
  sessionList: "session.list",
  sessionGet: "session.get",
  sessionInfo: "session.info",
  sessionDelete: "session.delete",
  sessionUpdate: "session.update",
  artifactList: "artifact.list",
  imageModelsList: "images.models",
  imageGet: "image.get",
  artifactGet: "artifact.get",
  // runtime -> gateway
  toolAuthorize: "tool.authorize", // request: the gateway owns the allow/deny decision
  runEvent: "run.event", // notification
} as const;

/** Identity is resolved and authorized by the gateway; the runtime only validates its shape. */
export type Tenant = { workspace: string; userId: string };

/** Sessions belong to the user, not to an agent; a session records the agent it was started with. */
export type TenantParams = { tenant: Tenant };

export type SessionScope = TenantParams & { agentId: string };

export type HelloResult = { protocolVersion: number; runtime: string; model?: string };

export type ImageAsset = { id: string; name: string; mimeType: string };
export type Attachment = { name: string; mimeType: string; data: string };

export type RunStartParams = SessionScope & {
  runId: string;
  /** Omit to start a new pi session. */
  sessionId?: string;
  input: { text: string; attachments?: Attachment[] };
  /** A key from models.list; omit for the agent's / env default. */
  imageModel?: string;
  model?: string;
  /** off | minimal | low | medium | high | xhigh; pi clamps it to the model. */
  thinkingLevel?: string;
};

/** One model the console may choose. key is "<provider>/<id>". */
export type ModelChoice = { key: string; label: string; group: string; name: string; reasoning: boolean };

export type ModelsResult = {
  models: ModelChoice[];
  defaultModel: string;
  thinkingLevels: string[];
  defaultThinkingLevel: string;
};

/** Returned once the run is accepted; progress arrives as run.event notifications. */
export type RunStartResult = { sessionId: string };

export type RunCancelParams = { runId: string };

export type SessionGetParams = TenantParams & { sessionId: string };

export type SessionSummary = {
  id: string;
  /** The agent the session is bound to. */
  agentId?: string;
  /** Pinned sessions are listed first. */
  pinned?: boolean;
  name?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
};

export type TranscriptMessage =
  | { role: "user"; text: string; timestamp?: number; images?: ImageAsset[] }
  | {
      role: "assistant";
      text: string;
      thinking?: string;
      toolCalls?: Array<{ id: string; name: string; args: unknown }>;
      error?: string;
      timestamp?: number;
    }
  | { role: "tool"; toolCallId: string; toolName: string; text: string; isError: boolean; artifactRevision?: number; images?: ImageAsset[] }
  | { role: "summary"; text: string };

export type SessionInfo = { id: string; agentId?: string };

/** Rename (pi session_info entry) and/or pin (a per-user preference, not session content). */
export type SessionUpdateParams = SessionGetParams & { name?: string; pinned?: boolean };

export type SessionDetail = SessionInfo & { name?: string; messages: TranscriptMessage[] };

/** One published version of a session's HTML artifact. */
export type ArtifactSummary = { revision: number; bytes: number; createdAt: string };

export type ArtifactGetParams = SessionGetParams & { revision?: number };

export type ArtifactDetail = ArtifactSummary & { html: string };

export type ToolAuthorizeParams = {
  runId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
};

export type ToolAuthorizeResult = { decision: "allow" | "deny"; reason?: string };

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

export type RunStatus = "completed" | "failed" | "cancelled";

export type RunEvent =
  | { type: "run_started"; sessionId: string; agentId: string; model?: string }
  | { type: "images"; images: ImageAsset[]; toolCallId?: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; result: string }
  | { type: "message_end"; text: string; stopReason: string; usage?: Usage; error?: string }
  | { type: "compaction"; phase: "start" | "end" }
  /** The artifact argument of a streaming tool call, as appended text (offset 0 restarts it). */
  | { type: "artifact_draft"; toolCallId: string; offset: number; delta: string }
  /** A tool published a new artifact revision. */
  | { type: "artifact"; toolCallId: string; revision: number; bytes: number }
  | { type: "run_finished"; status: RunStatus; error?: string; usage: Usage };

export type RunEventParams = { runId: string; seq: number; event: RunEvent };

/** JSON-RPC error codes. -32xxx are reserved by the spec; application codes are positive. */
export const ErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  notFound: 404,
  conflict: 409,
  unavailable: 503,
} as const;
