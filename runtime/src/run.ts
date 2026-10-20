import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentCatalog } from "./agents/manifest.ts";
import { governanceExtension } from "./governance.ts";
import { RpcError, type Peer } from "./ipc/peer.ts";
import { openSession, textOf } from "./memory/sessions.ts";
import { Models } from "./model/registry.ts";
import {
  ErrorCodes,
  Methods,
  type RunEvent,
  type RunStartParams,
  type RunStartResult,
  type RunStatus,
  type Usage,
} from "./protocol.ts";
import { assertScope, tenantPaths } from "./tenant.ts";

export type RunnerDeps = {
  peer: Peer;
  catalog: AgentCatalog;
  models: Models;
  dataDir: string;
  log: (msg: string) => void;
};

type ActiveRun = { runId: string; sessionKey?: string; session?: AgentSession; cancelled: boolean };

/**
 * Executes runs on pi AgentSessions. One AgentSession is built per run and disposed afterwards;
 * conversation state lives entirely in pi's session JSONL, so the runtime holds no tenant state
 * between runs and can be restarted at any time by the gateway.
 */
export class Runner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly busySessions = new Set<string>();

  constructor(private readonly deps: RunnerDeps) {}

  get activeCount(): number {
    return this.active.size;
  }

  async start(params: RunStartParams): Promise<RunStartResult> {
    const scope = assertScope(params);
    const runId = params.runId;
    const text = params.input?.text;
    if (typeof runId !== "string" || !runId) throw new RpcError(ErrorCodes.invalidParams, "invalid runId");
    if (typeof text !== "string" || !text.trim()) throw new RpcError(ErrorCodes.invalidParams, "input.text is required");
    if (this.active.has(runId)) throw new RpcError(ErrorCodes.conflict, "run already exists");

    const run: ActiveRun = { runId, cancelled: false };
    this.active.set(runId, run);
    let seq = 0;
    const emit = (event: RunEvent) => this.deps.peer.notify(Methods.runEvent, { runId, seq: seq++, event });

    let session: AgentSession;
    try {
      const agent = await this.deps.catalog.get(scope.agentId).catch((error: Error) => {
        throw new RpcError(ErrorCodes.notFound, `agent ${scope.agentId}: ${error.message}`);
      });
      const paths = tenantPaths(this.deps.dataDir, scope);
      await mkdir(paths.agentHome, { recursive: true });
      const sessionManager = await openSession(paths, params.sessionId);

      const sessionKey = `${paths.sessionDir}:${sessionManager.getSessionId()}`;
      if (this.busySessions.has(sessionKey)) throw new RpcError(ErrorCodes.conflict, "session is busy");
      this.busySessions.add(sessionKey);
      run.sessionKey = sessionKey;

      const workspaceInstructions = existsSync(paths.workspaceInstructions)
        ? await readFile(paths.workspaceInstructions, "utf8")
        : "";
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: agent.manifest.memory?.compaction ?? true },
        retry: { enabled: true, maxRetries: 2 },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: paths.agentHome,
        agentDir: paths.agentHome,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        additionalSkillPaths: agent.skillsDir ? [agent.skillsDir] : [],
        noPromptTemplates: true,
        noThemes: true,
        // pi context files, supplied explicitly: walking up from cwd would cross tenant boundaries.
        noContextFiles: true,
        agentsFilesOverride: () => ({
          agentsFiles: workspaceInstructions.trim()
            ? [{ path: paths.workspaceInstructions, content: workspaceInstructions }]
            : [],
        }),
        systemPromptOverride: () => agent.systemPrompt,
        extensionFactories: [
          governanceExtension({
            runId,
            peer: this.deps.peer,
            cwd: paths.agentHome,
            readRoots: [paths.agentHome, agent.dir],
            writeRoots: [paths.agentHome],
          }),
        ],
      });
      await resourceLoader.reload();
      const extensionErrors = resourceLoader.getExtensions().errors;
      if (extensionErrors.length) {
        // Without the governance hook tools would run unchecked: fail closed.
        throw new Error(`governance extension failed: ${extensionErrors.map((e) => e.error).join("; ")}`);
      }

      const { model, thinkingLevel } = this.deps.models.resolve(agent.manifest);
      const customTools = agent.toolsFactory?.({
        tenant: scope.tenant,
        agentId: scope.agentId,
        agentDir: agent.dir,
        agentHome: paths.agentHome,
      });
      ({ session } = await createAgentSession({
        cwd: paths.agentHome,
        agentDir: paths.agentHome,
        authStorage: this.deps.models.authStorage,
        modelRegistry: this.deps.models.registry,
        model,
        thinkingLevel,
        tools: agent.manifest.tools ?? [],
        customTools,
        resourceLoader,
        sessionManager,
        settingsManager,
      }));
      run.session = session;
    } catch (error) {
      this.finish(run);
      throw error;
    }

    const sessionId = session.sessionId;
    emit({
      type: "run_started",
      sessionId,
      agentId: scope.agentId,
      model: session.model ? Models.label(session.model) : undefined,
    });
    void this.execute(run, session, text, emit);
    return { sessionId };
  }

  async cancel(runId: string): Promise<{ cancelled: boolean }> {
    const run = this.active.get(runId);
    if (!run) return { cancelled: false };
    run.cancelled = true;
    await run.session?.abort();
    return { cancelled: true };
  }

  /** Abort everything; used on shutdown. */
  async cancelAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.cancel(id)));
  }

  private async execute(run: ActiveRun, session: AgentSession, text: string, emit: (e: RunEvent) => void) {
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
    let lastStop: { reason: string; error?: string } | undefined;
    const unsubscribe = session.subscribe((event) => {
      const mapped = mapEvent(event, usage);
      if (event.type === "message_end" && event.message.role === "assistant") {
        lastStop = { reason: event.message.stopReason, error: event.message.errorMessage };
      }
      if (mapped) emit(mapped);
    });

    let status: RunStatus = "completed";
    let error: string | undefined;
    try {
      if (!run.cancelled) await session.prompt(text, { source: "rpc" });
      if (run.cancelled || lastStop?.reason === "aborted") status = "cancelled";
      else if (lastStop?.reason === "error") {
        status = "failed";
        error = lastStop.error ?? "model error";
      }
    } catch (err) {
      status = run.cancelled ? "cancelled" : "failed";
      error = run.cancelled ? undefined : err instanceof Error ? err.message : String(err);
    } finally {
      unsubscribe();
      emit({ type: "run_finished", status, error, usage });
      this.finish(run);
      try {
        session.dispose();
      } catch (err) {
        this.deps.log(`dispose ${run.runId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private finish(run: ActiveRun) {
    this.active.delete(run.runId);
    if (run.sessionKey) this.busySessions.delete(run.sessionKey);
  }
}

function mapEvent(event: AgentSessionEvent, usage: Usage): RunEvent | undefined {
  switch (event.type) {
    case "message_update": {
      const inner = event.assistantMessageEvent;
      if (inner.type === "text_delta") return { type: "text_delta", delta: inner.delta };
      if (inner.type === "thinking_delta") return { type: "thinking_delta", delta: inner.delta };
      return undefined;
    }
    case "tool_execution_start":
      return { type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
    case "tool_execution_end":
      return {
        type: "tool_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        result: textOf((event.result as { content?: unknown } | undefined)?.content ?? event.result),
      };
    case "message_end": {
      if (event.message.role !== "assistant") return undefined;
      const u = event.message.usage;
      const messageUsage: Usage = {
        // pi reports input excluding cache categories; prompt tokens = input + cache read + cache write.
        inputTokens: u.input + u.cacheRead + u.cacheWrite,
        outputTokens: u.output,
        cacheReadTokens: u.cacheRead,
        cacheWriteTokens: u.cacheWrite,
        totalTokens: u.totalTokens,
      };
      for (const key of Object.keys(usage) as (keyof Usage)[]) usage[key] += messageUsage[key];
      return {
        type: "message_end",
        text: textOf(event.message.content),
        stopReason: event.message.stopReason,
        usage: messageUsage,
        error: event.message.errorMessage,
      };
    }
    case "compaction_start":
      return { type: "compaction", phase: "start" };
    case "compaction_end":
      return { type: "compaction", phase: "end" };
    default:
      return undefined;
  }
}
