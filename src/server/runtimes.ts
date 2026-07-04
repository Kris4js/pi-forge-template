import { PiAgentRuntime, resolveWorkspacePaths } from "../index.js";

type RuntimeCacheEntry = {
  workspace: string;
  userId: string;
  agentName: string;
  runtime: PiAgentRuntime;
  lastUsedAt: number;
  activeRequests: number;
};

type ChatInput = Parameters<PiAgentRuntime["chat"]>[0];

export type ChatRunResult = {
  output: Awaited<ReturnType<PiAgentRuntime["chat"]>>;
  recoveredSession?: boolean;
  previousSessionId?: string;
};

export type RuntimeManagerOptions = {
  idleTtlMs: number;
};

export class RuntimeManager {
  private readonly runtimes = new Map<string, RuntimeCacheEntry>();

  constructor(private readonly options: RuntimeManagerOptions) {}

  async runChatRequest(input: {
    workspace: string;
    userId: string;
    agentName?: string;
    prompt: string;
    sessionId?: string;
    stream: boolean;
    onTextDelta?: ChatInput["onTextDelta"];
    onToolEvent?: ChatInput["onToolEvent"];
  }): Promise<ChatRunResult> {
    const run = async (runtime: PiAgentRuntime, sessionId?: string) => {
      return runtime.chat({
        prompt: input.prompt,
        userId: input.userId,
        agentName: input.agentName,
        sessionId,
        stream: input.stream,
        onTextDelta: input.onTextDelta,
        onToolEvent: input.onToolEvent,
      });
    };

    if (!input.sessionId) {
      const output = await this.withNewSessionRuntime(input.workspace, input.userId, input.agentName, (runtime, sessionId) => run(runtime, sessionId));
      return { output };
    }

    try {
      const output = await this.withRuntime(input.workspace, input.userId, input.agentName, input.sessionId, (runtime) => run(runtime, input.sessionId));
      return { output };
    } catch (error) {
      if (!this.isSessionNotFoundError(error)) throw error;
      await this.disposeRuntimeEntry(input.workspace, input.userId, input.agentName, input.sessionId);
      const output = await this.withNewSessionRuntime(input.workspace, input.userId, input.agentName, (runtime, sessionId) => run(runtime, sessionId));
      return {
        output,
        recoveredSession: true,
        previousSessionId: input.sessionId,
      };
    }
  }

  async withNewSessionRuntime<T>(
    workspace: string,
    userId: string,
    agentName: string | undefined,
    fn: (runtime: PiAgentRuntime, sessionId: string) => Promise<T>,
  ): Promise<T> {
    const normalizedWorkspace = this.normalizeWorkspaceKey(workspace);
    const normalizedUserId = this.normalizeUserIdKey(userId);
    const normalizedAgentName = this.normalizeAgentNameKey(agentName, normalizedWorkspace);

    const entry: RuntimeCacheEntry = {
      workspace: normalizedWorkspace,
      userId: normalizedUserId,
      agentName: normalizedAgentName,
      runtime: new PiAgentRuntime({ workspace: normalizedWorkspace, userId: normalizedUserId, agentName: normalizedAgentName }),
      lastUsedAt: Date.now(),
      activeRequests: 1,
    };
    let registeredKey: string | undefined;
    try {
      const sessionId = await entry.runtime.newSession();
      registeredKey = this.makeRuntimeKey(normalizedWorkspace, normalizedUserId, normalizedAgentName, sessionId);
      this.runtimes.set(registeredKey, entry);
      return await fn(entry.runtime, sessionId);
    } catch (error) {
      if (!registeredKey) await entry.runtime.dispose().catch(() => undefined);
      throw error;
    } finally {
      entry.activeRequests -= 1;
      entry.lastUsedAt = Date.now();
    }
  }

  async withRuntime<T>(
    workspace: string,
    userId: string,
    agentName: string | undefined,
    sessionId: string | undefined,
    fn: (runtime: PiAgentRuntime) => Promise<T>,
  ): Promise<T> {
    const entry = this.getRuntimeEntry(workspace, userId, agentName, sessionId);
    entry.activeRequests += 1;
    entry.lastUsedAt = Date.now();
    try {
      return await fn(entry.runtime);
    } finally {
      entry.activeRequests -= 1;
      entry.lastUsedAt = Date.now();
    }
  }

  async cleanupIdleRuntimes(): Promise<void> {
    const now = Date.now();
    const disposals: Promise<void>[] = [];
    for (const [key, entry] of this.runtimes) {
      if (entry.activeRequests > 0) continue;
      if (now - entry.lastUsedAt < this.options.idleTtlMs) continue;
      this.runtimes.delete(key);
      disposals.push(entry.runtime.dispose().catch(() => undefined));
    }
    await Promise.all(disposals);
  }

  async disposeAllRuntimes(): Promise<void> {
    const entries = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(entries.map((entry) => entry.runtime.dispose().catch(() => undefined)));
  }

  normalizeUserIdKey(userId: string): string {
    return resolveWorkspacePaths({ userId: userId || "anonymous" }).userId;
  }

  normalizeWorkspaceKey(workspace: string): string {
    return resolveWorkspacePaths({ workspace: workspace || "demo" }).workspace;
  }

  normalizeAgentNameKey(agentName: string | undefined, workspace = "demo"): string {
    return resolveWorkspacePaths({ workspace: agentName || workspace || "demo" }).workspace;
  }

  private getRuntimeEntry(workspace: string, userId: string, agentName: string | undefined, sessionId?: string): RuntimeCacheEntry {
    const normalizedWorkspace = this.normalizeWorkspaceKey(workspace);
    const normalizedUserId = this.normalizeUserIdKey(userId);
    const normalizedAgentName = this.normalizeAgentNameKey(agentName, normalizedWorkspace);
    const key = this.makeRuntimeKey(normalizedWorkspace, normalizedUserId, normalizedAgentName, sessionId);
    let entry = this.runtimes.get(key);
    if (!entry) {
      entry = {
        workspace: normalizedWorkspace,
        userId: normalizedUserId,
        agentName: normalizedAgentName,
        runtime: new PiAgentRuntime({ workspace: normalizedWorkspace, userId: normalizedUserId, agentName: normalizedAgentName }),
        lastUsedAt: Date.now(),
        activeRequests: 0,
      };
      this.runtimes.set(key, entry);
    }
    return entry;
  }

  private async disposeRuntimeEntry(workspace: string, userId: string, agentName: string | undefined, sessionId?: string): Promise<void> {
    const key = this.makeRuntimeKey(
      this.normalizeWorkspaceKey(workspace),
      this.normalizeUserIdKey(userId),
      this.normalizeAgentNameKey(agentName, workspace),
      sessionId,
    );
    const entry = this.runtimes.get(key);
    if (!entry) return;
    this.runtimes.delete(key);
    if (entry.activeRequests <= 0) await entry.runtime.dispose().catch(() => undefined);
  }

  private makeRuntimeKey(workspace: string, userId: string, agentName: string, sessionId?: string): string {
    const sessionKey = sessionId?.trim();
    const tenantKey = `${workspace}:user:${userId}:agent:${agentName}`;
    return sessionKey ? `${tenantKey}:session:${sessionKey}` : `${tenantKey}:active`;
  }

  private isSessionNotFoundError(error: unknown): boolean {
    return error instanceof Error && /Session not found/i.test(error.message);
  }
}
