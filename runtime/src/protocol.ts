/**
 * Gateway <-> runtime IPC contract (JSON-RPC 2.0 over stdio, one JSON object per LF-terminated line).
 * Mirrored in gateway/internal/ipc/protocol.go and described in docs/ipc-protocol.md.
 */

export const PROTOCOL_VERSION = 1;

export const Methods = {
  // gateway -> runtime (requests)
  hello: "runtime.hello",
  runStart: "run.start",
  runCancel: "run.cancel",
  sessionList: "session.list",
  sessionGet: "session.get",
  sessionDelete: "session.delete",
  // runtime -> gateway
  toolAuthorize: "tool.authorize", // request: the gateway owns the allow/deny decision
  runEvent: "run.event", // notification
} as const;

/** Identity is resolved and authorized by the gateway; the runtime only validates its shape. */
export type Tenant = { workspace: string; userId: string };

export type SessionScope = { tenant: Tenant; agentId: string };

export type HelloResult = { protocolVersion: number; runtime: string; model?: string };

export type RunStartParams = SessionScope & {
  runId: string;
  /** Omit to start a new pi session. */
  sessionId?: string;
  input: { text: string };
};

/** Returned once the run is accepted; progress arrives as run.event notifications. */
export type RunStartResult = { sessionId: string };

export type RunCancelParams = { runId: string };

export type SessionGetParams = SessionScope & { sessionId: string };

export type SessionSummary = {
  id: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
};

export type TranscriptMessage =
  | { role: "user"; text: string; timestamp?: number }
  | {
      role: "assistant";
      text: string;
      thinking?: string;
      toolCalls?: Array<{ id: string; name: string; args: unknown }>;
      error?: string;
      timestamp?: number;
    }
  | { role: "tool"; toolCallId: string; toolName: string; text: string; isError: boolean }
  | { role: "summary"; text: string };

export type SessionDetail = { id: string; name?: string; messages: TranscriptMessage[] };

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
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; result: string }
  | { type: "message_end"; text: string; stopReason: string; usage?: Usage; error?: string }
  | { type: "compaction"; phase: "start" | "end" }
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
