import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@mariozechner/pi-coding-agent";
import { collectAssistantText, toToolStreamEvent } from "./events.js";
import {
  enforceRetentionPolicy,
  getRetentionMetadataFile,
  inspectRetentionPolicy,
  type RetentionPolicy,
} from "./retention.js";
import {
  ensureWorkspaceDirs,
  listWorkspaceNames,
  resolveWorkspacePaths,
  type WorkspaceOptions,
  type WorkspacePaths,
} from "../workspace/paths.js";
import { AgentRuntimeConfig } from "./config.js";
import { buildSystemPrompt } from "../prompt/system.js";
import type {
  ChatInput,
  ChatOptions,
  ChatResult,
} from "../types.js";

export type RuntimeOptions = WorkspaceOptions & {
  cwd?: string;
  agentDir?: string;
  sessionDir?: string;
  envFilePath?: string;
};

export class PiAgentRuntime {
  private runtime?: AgentSessionRuntime;
  private workspace?: WorkspacePaths;
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
      const { runtime, workspace } = await createPiRuntime(this.options, this.config);
      this.runtime = runtime;
      this.workspace = workspace;
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = undefined;
    }
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    return this.runExclusive(() => this.chatUnlocked(input.prompt, input));
  }

  async selectSession(sessionId: string): Promise<void> {
    await this.runExclusive(async () => {
      await this.init();
      await this.switchToSession(sessionId);
    });
  }

  async newSession(): Promise<string> {
    return this.runExclusive(async () => {
      await this.init();
      const runtime = this.getRuntime();
      await runtime.newSession();
      await runtime.session.bindExtensions({});
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

  async getSnapshot() {
    return this.runExclusive(async () => {
      await this.init();
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

  async dispose(): Promise<void> {
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
    };
  }

  private async switchToSession(sessionId: string) {
    const runtime = this.getRuntime();
    if (runtime.session.sessionId === sessionId) return;
    const sessions = await this.listSessions();
    const target = sessions.find((session) => session.id === sessionId);
    if (!target) throw new Error(`Session not found: ${sessionId}`);
    await runtime.switchSession(target.path);
    await runtime.session.bindExtensions({});
    await this.config.applyToRuntime(runtime);
  }
}

async function createPiRuntime(
  options: RuntimeOptions = {},
  config = new AgentRuntimeConfig({ envFilePath: options.envFilePath }),
): Promise<{
  runtime: AgentSessionRuntime;
  workspace: WorkspacePaths;
  config: AgentRuntimeConfig;
}> {
  const workspace = resolveWorkspacePaths(options);
  await ensureWorkspaceDirs(workspace);
  const cwd = options.cwd ?? workspace.cwd;
  const agentDir = options.agentDir ?? workspace.agentDir;
  const sessionDir = options.sessionDir ?? workspace.sessionDir;
  const workspaceAgents = await readWorkspaceAgents(workspace.workspaceDir);
  const settingsManager = SettingsManager.inMemory();

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: effectiveCwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd: effectiveCwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPromptOverride: () =>
          buildSystemPrompt({
            workspace: workspace.workspace,
            userId: workspace.userId,
            workspaceAgents,
          }),
      },
    });

    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd, sessionDir),
  });

  await runtime.session.bindExtensions({});
  await config.applyToRuntime(runtime);
  return { runtime, workspace, config };
}

async function readWorkspaceAgents(workspaceDir: string): Promise<string> {
  try {
    return (await readFile(join(workspaceDir, "AGENTS.md"), "utf8")).trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "";
    throw error;
  }
}

