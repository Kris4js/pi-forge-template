import type { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { collectAssistantText, toToolStreamEvent } from "./assistantEvents.js";
import {
  createMinipiRuntime,
  bindRuntimeSession,
  type RuntimeOptions,
} from "./sessionFactory.js";
import {
  enforceRetentionPolicy,
  getRetentionMetadataFile,
  inspectRetentionPolicy,
  type RetentionPolicy,
} from "./retention.js";
import {
  listWorkspaceNames,
  resolveWorkspacePaths,
  type WorkspacePaths,
} from "./workspace.js";
import { AgentRuntimeConfig } from "./config.js";
import type { LayeredMemoryStore } from "../memory/store.js";
import type { JsonSummaryStore } from "../memory/summaryStore.js";
import type {
  ChatOnceInput,
  ChatOptions,
  ChatResult,
} from "../types.js";

export class MinipiAgentRuntime {
  private runtime?: AgentSessionRuntime;
  private workspace?: WorkspacePaths;
  private store?: LayeredMemoryStore;
  private summaryStore?: JsonSummaryStore;
  private initPromise?: Promise<void>;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly retentionPolicy: RetentionPolicy;
  private readonly config: AgentRuntimeConfig;

  constructor(
    private readonly options: RuntimeOptions = {},
    retentionPolicy: RetentionPolicy = {},
  ) {
    this.retentionPolicy = retentionPolicy;
    this.config = new AgentRuntimeConfig({ envFilePath: options.envFilePath });
  }

  async init(): Promise<void> {
    if (this.runtime) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const { runtime, workspace, store, summaryStore } =
        await createMinipiRuntime(this.options, this.config);
      this.runtime = runtime;
      this.workspace = workspace;
      this.store = store;
      this.summaryStore = summaryStore;

      await this.config.startWatching(async () => {
        if (!this.runtime) return;
        await this.config.applyToRuntime(this.runtime);
      });
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = undefined;
    }
  }

  async chatOnce(input: ChatOnceInput): Promise<ChatResult> {
    return this.chat(input.prompt, {
      sessionId: input.sessionId,
      userId: input.userId,
      stream: input.stream,
      onTextDelta: input.onTextDelta,
      onToolEvent: input.onToolEvent,
    });
  }

  async chat(text: string, options: ChatOptions = {}): Promise<ChatResult> {
    return this.runExclusive(() => this.chatUnlocked(text, options));
  }

  async selectSession(sessionId: string): Promise<void> {
    await this.runExclusive(async () => {
      await this.init();
      await this.config.reloadIfChanged(this.getRuntime());
      await this.switchToSession(sessionId);
    });
  }

  async newSession(): Promise<string> {
    return this.runExclusive(async () => {
      await this.init();
      const runtime = this.getRuntime();
      await runtime.newSession();
      await bindRuntimeSession(runtime);
      await this.config.applyToRuntime(runtime);
      return runtime.session.sessionId;
    });
  }

  async listSessions(): Promise<Array<{ id: string; path: string; name?: string }>> {
    const workspace = this.workspace ?? resolveWorkspacePaths(this.options);
    const sessions = await SessionManager.list(workspace.cwd, workspace.sessionDir);
    return sessions.map((item) => ({
      id: item.id,
      path: item.path,
      name: item.name,
    }));
  }

  async listMemories(limit = 50): Promise<
    Array<{
      id: string;
      visibility: string;
      kind: string;
      text: string;
      confidence: number;
      createdAt: number;
      lastUsedAt: number;
    }>
  > {
    await this.init();
    const records = await this.getStore().list();
    return records
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        visibility: item.visibility,
        kind: item.kind,
        text: item.text,
        confidence: item.confidence,
        createdAt: item.createdAt,
        lastUsedAt: item.lastUsedAt,
      }));
  }

  async listSummaries(limit = 50): Promise<
    Array<{
      id: string;
      text: string;
      turnStart: number;
      turnEnd: number;
      createdAt: number;
      lastUsedAt: number;
      promotedToMemoryId?: string;
    }>
  > {
    await this.init();
    const records = await this.getSummaryStore().list();
    return records
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        text: item.text,
        turnStart: item.turnStart,
        turnEnd: item.turnEnd,
        createdAt: item.createdAt,
        lastUsedAt: item.lastUsedAt,
        promotedToMemoryId: item.promotedToMemoryId,
      }));
  }

  async getSnapshot() {
    return this.runExclusive(async () => {
      await this.init();
      await this.config.reloadIfChanged(this.getRuntime());
      return this.buildSnapshot();
    });
  }

  async listWorkspaces(): Promise<string[]> {
    return listWorkspaceNames(this.getWorkspace().rootDir);
  }

  async getModelCatalog(limit = 80) {
    await this.init();
    const session = this.getRuntime().session;
    return session.modelRegistry
      .getAll()
      .slice(0, limit)
      .map((model) => ({
        provider: model.provider,
        modelId: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        authConfigured: session.modelRegistry.hasConfiguredAuth(model),
      }));
  }

  async setModelConfig(input: {
    provider: string;
    modelId: string;
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    apiKey?: string;
  }) {
    return this.runExclusive(async () => {
      await this.init();
      const session = this.getRuntime().session;
      if (input.apiKey) {
        session.modelRegistry.authStorage.setRuntimeApiKey(input.provider, input.apiKey);
      }
      const model = session.modelRegistry.find(input.provider, input.modelId);
      if (!model) throw new Error(`Model not found: ${input.provider}/${input.modelId}`);
      await session.setModel(model);
      if (input.thinkingLevel) session.setThinkingLevel(input.thinkingLevel);
      return this.buildSnapshot();
    });
  }

  async dispose(): Promise<void> {
    this.config.dispose();
    if (!this.runtime) return;
    await this.runtime.dispose();
    this.runtime = undefined;
  }

  getWorkspace(): WorkspacePaths {
    if (!this.workspace) this.workspace = resolveWorkspacePaths(this.options);
    return this.workspace;
  }

  private async chatUnlocked(text: string, options: ChatOptions = {}): Promise<ChatResult> {
    await this.init();
    const runtime = this.getRuntime();
    await this.config.reloadIfChanged(runtime);

    if (options.sessionId) await this.switchToSession(options.sessionId);

    const session = runtime.session;
    let finalText = "";
    const writeToStdout = !options.onTextDelta && options.stream;
    const emitTextDelta = options.onTextDelta
      ?? (writeToStdout
        ? (delta: string) => {
            process.stdout.write(delta);
          }
        : undefined);
    const unsubscribe = session.subscribe((event) => {
      finalText = collectAssistantText(event, finalText);
      const toolEvent = toToolStreamEvent(event);
      if (toolEvent) options.onToolEvent?.(toolEvent);
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        emitTextDelta?.(event.assistantMessageEvent.delta);
      }
    });

    try {
      await session.prompt(text, { source: "rpc" });
    } finally {
      unsubscribe();
    }

    if (options.stream && !options.onTextDelta) process.stdout.write("\n");

    const retention = await enforceRetentionPolicy(
      runtime,
      this.retentionPolicy,
      getRetentionMetadataFile(this.getWorkspace().userDir),
    );

    return {
      sessionId: session.sessionId,
      text: finalText.trim(),
      workspace: this.getWorkspace().workspace,
      userId: this.getWorkspace().userId,
      retention,
    };
  }

  private getStore(): LayeredMemoryStore {
    if (!this.store) throw new Error("Memory store not initialized");
    return this.store;
  }

  private getSummaryStore(): JsonSummaryStore {
    if (!this.summaryStore) throw new Error("Summary store not initialized");
    return this.summaryStore;
  }

  private getRuntime(): AgentSessionRuntime {
    if (!this.runtime) throw new Error("Runtime not initialized");
    return this.runtime;
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async buildSnapshot() {
    const runtime = this.getRuntime();
    const session = runtime.session;
    const retention = await inspectRetentionPolicy(
      runtime,
      this.retentionPolicy,
      getRetentionMetadataFile(this.getWorkspace().userDir),
    );
    const provider = session.model
      ? {
          provider: session.model.provider,
          modelId: session.model.id,
          name: session.model.name,
          contextWindow: session.model.contextWindow,
          thinkingLevel: session.thinkingLevel,
        }
      : undefined;

    return {
      tenant: {
        workspace: this.getWorkspace().workspace,
        userId: this.getWorkspace().userId,
        sessionId: session.sessionId,
      },
      paths: this.getWorkspace(),
      workspace: this.getWorkspace(),
      session: {
        id: session.sessionId,
        file: session.sessionFile,
        name: session.sessionName,
      },
      provider,
      prompts: {
        systemPrompt: session.systemPrompt,
      },
      retention,
      sessions: await this.listSessions(),
      memories: await this.listMemories(),
      summaries: await this.listSummaries(),
    };
  }

  private async switchToSession(sessionId: string) {
    const runtime = this.getRuntime();
    if (runtime.session.sessionId === sessionId) return;
    const sessions = await this.listSessions();
    const target = sessions.find((session) => session.id === sessionId);
    if (!target) throw new Error(`Session not found: ${sessionId}`);
    await runtime.switchSession(target.path);
    await bindRuntimeSession(runtime);
    await this.config.applyToRuntime(runtime);
  }
}
