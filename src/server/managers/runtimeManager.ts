import { MinipiAgentRuntime, resolveWorkspacePaths } from "../../index.js";

export type RuntimeModelOverride = {
  provider: string;
  modelId: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  apiKey?: string;
};

type RuntimeCacheEntry = {
  workspace: string;
  userId: string;
  runtime: MinipiAgentRuntime;
  lastUsedAt: number;
  activeRequests: number;
  appliedModelOverrideSignature?: string;
};

type ChatOnceInput = Parameters<MinipiAgentRuntime["chatOnce"]>[0];

export type ChatRunResult = {
  output: Awaited<ReturnType<MinipiAgentRuntime["chatOnce"]>>;
  recoveredSession?: boolean;
  previousSessionId?: string;
};

export type RuntimeManagerOptions = {
  idleTtlMs: number;
};

export class RuntimeManager {
  private readonly runtimes = new Map<string, RuntimeCacheEntry>();
  private readonly modelOverrides = new Map<string, RuntimeModelOverride>();

  constructor(private readonly options: RuntimeManagerOptions) {}

  async runChatRequest(input: {
    workspace: string;
    userId: string;
    prompt: string;
    sessionId?: string;
    stream: boolean;
    onTextDelta?: ChatOnceInput["onTextDelta"];
    onToolEvent?: ChatOnceInput["onToolEvent"];
  }): Promise<ChatRunResult> {
    const run = async (runtime: MinipiAgentRuntime, sessionId?: string) => {
      return runtime.chatOnce({
        prompt: input.prompt,
        userId: input.userId,
        sessionId,
        stream: input.stream,
        onTextDelta: input.onTextDelta,
        onToolEvent: input.onToolEvent,
      });
    };

    if (!input.sessionId) {
      const output = await this.withNewSessionRuntime(input.workspace, input.userId, (runtime, sessionId) => run(runtime, sessionId));
      return { output };
    }

    try {
      const output = await this.withRuntime(input.workspace, input.userId, input.sessionId, (runtime) => run(runtime, input.sessionId));
      return { output };
    } catch (error) {
      if (!this.isSessionNotFoundError(error)) throw error;
      await this.disposeRuntimeEntry(input.workspace, input.userId, input.sessionId);
      const output = await this.withNewSessionRuntime(input.workspace, input.userId, (runtime, sessionId) => run(runtime, sessionId));
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
    fn: (runtime: MinipiAgentRuntime, sessionId: string) => Promise<T>,
  ): Promise<T> {
    // 保证 workspace 和 userId 规范性一致
    const normalizedWorkspace = this.normalizeWorkspaceKey(workspace);
    const normalizedUserId = this.normalizeUserIdKey(userId);

    // 新建 RuntimeEntry
    const entry: RuntimeCacheEntry = {
      workspace: normalizedWorkspace,
      userId: normalizedUserId,
      runtime: new MinipiAgentRuntime({ workspace: normalizedWorkspace, userId: normalizedUserId }),
      lastUsedAt: Date.now(),
      activeRequests: 1,
    };
    let registeredKey: string | undefined;
    try {
      // 模型配置检查
      await this.ensureRuntimeModelOverride(entry);
      
      // 将 RuntimeEntry 注册到缓存
      const sessionId = await entry.runtime.newSession();
      registeredKey = this.makeRuntimeKey(normalizedWorkspace, normalizedUserId, sessionId);
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
    sessionId: string | undefined,
    fn: (runtime: MinipiAgentRuntime) => Promise<T>,
  ): Promise<T> {
    const entry = this.getRuntimeEntry(workspace, userId, sessionId);
    entry.activeRequests += 1;
    entry.lastUsedAt = Date.now();
    try {
      await this.ensureRuntimeModelOverride(entry);
      return await fn(entry.runtime);
    } finally {
      entry.activeRequests -= 1;
      entry.lastUsedAt = Date.now();
    }
  }

  async setModelOverride(workspace: string, override: RuntimeModelOverride): Promise<void> {
    const normalizedWorkspace = this.normalizeWorkspaceKey(workspace);
    this.modelOverrides.set(normalizedWorkspace, override);
    await this.applyModelOverrideToWorkspace(normalizedWorkspace, override);
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

  private getRuntimeEntry(workspace: string, userId: string, sessionId?: string): RuntimeCacheEntry {
    const normalizedWorkspace = this.normalizeWorkspaceKey(workspace);
    const normalizedUserId = this.normalizeUserIdKey(userId);
    const key = this.makeRuntimeKey(normalizedWorkspace, normalizedUserId, sessionId);
    let entry = this.runtimes.get(key);
    if (!entry) {
      entry = {
        workspace: normalizedWorkspace,
        userId: normalizedUserId,
        runtime: new MinipiAgentRuntime({ workspace: normalizedWorkspace, userId: normalizedUserId }),
        lastUsedAt: Date.now(),
        activeRequests: 0,
      };
      this.runtimes.set(key, entry);
    }
    return entry;
  }

  private async disposeRuntimeEntry(workspace: string, userId: string, sessionId?: string): Promise<void> {
    const key = this.makeRuntimeKey(this.normalizeWorkspaceKey(workspace), this.normalizeUserIdKey(userId), sessionId);
    const entry = this.runtimes.get(key);
    if (!entry) return;
    this.runtimes.delete(key);
    if (entry.activeRequests <= 0) await entry.runtime.dispose().catch(() => undefined);
  }

  private async ensureRuntimeModelOverride(entry: RuntimeCacheEntry): Promise<void> {
    const override = this.modelOverrides.get(entry.workspace);
    if (!override) return;
    const signature = JSON.stringify(override);
    if (entry.appliedModelOverrideSignature === signature) return;
    await entry.runtime.setModelConfig(override);
    entry.appliedModelOverrideSignature = signature;
  }

  private async applyModelOverrideToWorkspace(workspace: string, override: RuntimeModelOverride): Promise<void> {
    const signature = JSON.stringify(override);
    const targets = [...this.runtimes.values()].filter((entry) => entry.workspace === workspace);
    await Promise.all(
      targets.map(async (entry) => {
        entry.activeRequests += 1;
        try {
          await entry.runtime.setModelConfig(override);
          entry.appliedModelOverrideSignature = signature;
          entry.lastUsedAt = Date.now();
        } finally {
          entry.activeRequests -= 1;
          entry.lastUsedAt = Date.now();
        }
      }),
    );
  }

  private makeRuntimeKey(workspace: string, userId: string, sessionId?: string): string {
    const sessionKey = sessionId?.trim();
    const tenantKey = `${workspace}:user:${userId}`;
    return sessionKey ? `${tenantKey}:session:${sessionKey}` : `${tenantKey}:active`;
  }

  private isSessionNotFoundError(error: unknown): boolean {
    return error instanceof Error && /Session not found/i.test(error.message);
  }
}
