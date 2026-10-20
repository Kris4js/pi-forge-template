// Client for the gateway HTTP API (gateway/internal/httpapi).

export type Identity = { workspace: string; userId: string; apiKey: string };

export type Agent = {
  id: string;
  name: string;
  description?: string;
  tools: string[];
  approvalRequired: string[];
  starters: string[];
};

export type SessionSummary = { id: string; name?: string; updatedAt: string; messageCount: number; preview: string };

export type TranscriptMessage =
  | { role: "user"; text: string; timestamp?: number }
  | { role: "assistant"; text: string; thinking?: string; toolCalls?: { id: string; name: string; args: unknown }[]; error?: string }
  | { role: "tool"; toolCallId: string; toolName: string; text: string; isError: boolean }
  | { role: "summary"; text: string };

export type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };

export type RunEvent =
  | { type: "run"; runId: string; sessionId: string; agentId: string }
  | { type: "run_started"; sessionId: string; model?: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; result: string }
  | { type: "approval_required"; toolCallId: string; toolName: string; args: unknown; expiresAt: string }
  | { type: "approval_resolved"; toolCallId: string; decision: "allow" | "deny"; reason?: string; by?: string }
  | { type: "message_end"; text: string; stopReason: string; error?: string }
  | { type: "compaction"; phase: "start" | "end" }
  | { type: "run_finished"; status: string; error?: string; usage?: Usage };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Api {
  constructor(private readonly id: Identity) {}

  private headers(): HeadersInit {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.id.workspace) h["X-Workspace"] = this.id.workspace;
    if (this.id.userId) h["X-User-Id"] = this.id.userId;
    if (this.id.apiKey) h.Authorization = `Bearer ${this.id.apiKey}`;
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, { method, headers: this.headers(), body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  me() {
    return this.request<{ principal: { tenant: { workspace: string; userId: string } }; runtime: { model?: string } }>("GET", "/v1/me");
  }
  agents() {
    return this.request<Agent[]>("GET", "/v1/agents");
  }
  sessions(agentId: string) {
    return this.request<SessionSummary[]>("GET", `/v1/agents/${agentId}/sessions`);
  }
  session(agentId: string, sessionId: string) {
    return this.request<{ id: string; messages: TranscriptMessage[] }>("GET", `/v1/agents/${agentId}/sessions/${sessionId}`);
  }
  deleteSession(agentId: string, sessionId: string) {
    return this.request<void>("DELETE", `/v1/agents/${agentId}/sessions/${sessionId}`);
  }
  cancel(runId: string) {
    return this.request<void>("POST", `/v1/runs/${runId}/cancel`);
  }
  decide(runId: string, toolCallId: string, decision: "approve" | "reject") {
    return this.request<void>("POST", `/v1/runs/${runId}/approvals/${encodeURIComponent(toolCallId)}`, { decision });
  }

  /** Starts a run and feeds SSE events to onEvent until the stream ends. */
  async run(body: { agentId: string; sessionId?: string; text: string }, onEvent: (e: RunEvent) => void, signal?: AbortSignal) {
    const res = await fetch("/v1/runs", { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal });
    if (!res.ok || !res.body) throw new ApiError(res.status, await errorMessage(res));
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        let type = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) type = line.slice(7);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (type && data) onEvent({ ...JSON.parse(data), type } as RunEvent);
      }
    }
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? res.statusText;
  } catch {
    return res.statusText;
  }
}
