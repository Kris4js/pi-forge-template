import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentCatalog, AgentManifest } from "./agents/manifest.ts";
import { saveAttachments, validateAttachments } from "./attachments.ts";
import type { ImageContent } from "@earendil-works/pi-ai";
import { ArtifactStore } from "./artifacts/store.ts";
import { governanceExtension } from "./governance.ts";
import { RpcError, type Peer } from "./ipc/peer.ts";
import { bindAgent, openSession, sessionAgent, sessionKey as keyOf, textOf } from "./memory/sessions.ts";
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

  /** Whether a run currently holds this session (see memory/sessions.ts sessionKey). */
  isBusy(sessionKey: string): boolean {
    return this.busySessions.has(sessionKey);
  }

  async start(params: RunStartParams): Promise<RunStartResult> {
    const scope = assertScope(params);
    const runId = params.runId;
    let text = params.input?.text;
    const attachments = validateAttachments(params.input?.attachments);
    if (typeof text === "string" && !text.trim() && attachments.length) text = "请查看所附文件。";
    if (typeof runId !== "string" || !runId) throw new RpcError(ErrorCodes.invalidParams, "invalid runId");
    if (typeof text !== "string" || !text.trim()) throw new RpcError(ErrorCodes.invalidParams, "input.text is required");
    if (this.active.has(runId)) throw new RpcError(ErrorCodes.conflict, "run already exists");

    const run: ActiveRun = { runId, cancelled: false };
    this.active.set(runId, run);
    let seq = 0;
    const emit = (event: RunEvent) => this.deps.peer.notify(Methods.runEvent, { runId, seq: seq++, event });

    let session: AgentSession;
    let images: ImageContent[] = [];
    let preview: AgentManifest["preview"];
    try {
      const agent = await this.deps.catalog.get(scope.agentId).catch((error: Error) => {
        throw new RpcError(ErrorCodes.notFound, `agent ${scope.agentId}: ${error.message}`);
      });
      preview = agent.manifest.preview;
      const paths = tenantPaths(this.deps.dataDir, scope.tenant);
      await mkdir(paths.userHome, { recursive: true });
      const sessionManager = await openSession(paths, params.sessionId);
      // A session keeps the agent it was started with; sessions themselves are not split by agent.
      const bound = sessionAgent(sessionManager);
      if (bound && bound !== scope.agentId) {
        throw new RpcError(ErrorCodes.conflict, `session belongs to agent ${bound}`, { agentId: bound });
      }
      if (!bound) bindAgent(sessionManager, scope.agentId);

      const sessionKey = keyOf(paths, sessionManager.getSessionId());
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
        cwd: paths.userHome,
        agentDir: paths.userHome,
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
            cwd: paths.userHome,
            readRoots: [paths.userHome, agent.dir],
            writeRoots: [paths.userHome],
          }),
        ],
      });
      await resourceLoader.reload();
      const extensionErrors = resourceLoader.getExtensions().errors;
      if (extensionErrors.length) {
        // Without the governance hook tools would run unchecked: fail closed.
        throw new Error(`governance extension failed: ${extensionErrors.map((e) => e.error).join("; ")}`);
      }

      const { model, thinkingLevel } = this.deps.models.resolve(agent.manifest, {
        model: params.model,
        thinkingLevel: params.thinkingLevel,
      });
      const customTools = agent.toolsFactory?.({
        tenant: scope.tenant,
        agentId: scope.agentId,
        agentDir: agent.dir,
        userHome: paths.userHome,
        sessionId: sessionManager.getSessionId(),
        artifacts: ArtifactStore.forSession(paths, sessionManager.getSessionId()),
      });
      ({ session } = await createAgentSession({
        cwd: paths.userHome,
        agentDir: paths.userHome,
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
      if (attachments.some((file) => file.mimeType.startsWith("image/")) && !session.model?.input.includes("image")) {
        throw new RpcError(ErrorCodes.invalidParams, "当前模型不支持图片，请切换视觉模型");
      }
      const saved = await saveAttachments(paths.userHome, attachments);
      text += saved.text;
      images = saved.images;
    } catch (error) {
      run.session?.dispose();
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
    void this.execute(run, session, text, emit, preview, images);
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

  private async execute(
    run: ActiveRun,
    session: AgentSession,
    text: string,
    emit: (e: RunEvent) => void,
    preview: AgentManifest["preview"],
    images: ImageContent[],
  ) {
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
    const drafts = new Map<string, string>();
    let lastStop: { reason: string; error?: string } | undefined;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        lastStop = { reason: event.message.stopReason, error: event.message.errorMessage };
      }
      const draft = preview && draftEvent(event, preview, drafts);
      if (draft) emit(draft);
      for (const mapped of mapEvent(event, usage)) emit(mapped);
    });

    let status: RunStatus = "completed";
    let error: string | undefined;
    try {
      if (!run.cancelled) await session.prompt(text, { source: "rpc", images });
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

/**
 * While the preview tool's call streams, pi parses its arguments incrementally; forward the growth of
 * the preview argument (fx0's live design draft). A value that is not an extension restarts at offset 0.
 */
function draftEvent(
  event: AgentSessionEvent,
  preview: NonNullable<AgentManifest["preview"]>,
  drafts: Map<string, string>,
): RunEvent | undefined {
  if (event.type !== "message_update" || event.assistantMessageEvent.type !== "toolcall_delta") return undefined;
  const inner = event.assistantMessageEvent;
  const block = inner.partial.content[inner.contentIndex];
  if (block?.type !== "toolCall" || block.name !== preview.tool || !block.id) return undefined;
  const value = (block.arguments as Record<string, unknown> | undefined)?.[preview.argument];
  if (typeof value !== "string") return undefined;
  const previous = drafts.get(block.id) ?? "";
  if (value === previous) return undefined;
  drafts.set(block.id, value);
  return value.startsWith(previous)
    ? { type: "artifact_draft", toolCallId: block.id, offset: previous.length, delta: value.slice(previous.length) }
    : { type: "artifact_draft", toolCallId: block.id, offset: 0, delta: value };
}

function mapEvent(event: AgentSessionEvent, usage: Usage): RunEvent[] {
  switch (event.type) {
    case "message_update": {
      const inner = event.assistantMessageEvent;
      if (inner.type === "text_delta") return [{ type: "text_delta", delta: inner.delta }];
      if (inner.type === "thinking_delta") return [{ type: "thinking_delta", delta: inner.delta }];
      return [];
    }
    case "tool_execution_start":
      return [{ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }];
    case "tool_execution_end": {
      const result = event.result as { content?: unknown; details?: { artifact?: { revision?: unknown; bytes?: unknown } } } | undefined;
      const out: RunEvent[] = [
        {
          type: "tool_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          result: textOf(result?.content ?? event.result),
        },
      ];
      const artifact = result?.details?.artifact;
      if (!event.isError && typeof artifact?.revision === "number") {
        out.push({ type: "artifact", toolCallId: event.toolCallId, revision: artifact.revision, bytes: Number(artifact.bytes) || 0 });
      }
      return out;
    }
    case "message_end": {
      if (event.message.role !== "assistant") return [];
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
      return [
        {
          type: "message_end",
          text: textOf(event.message.content),
          stopReason: event.message.stopReason,
          usage: messageUsage,
          error: event.message.errorMessage,
        },
      ];
    }
    case "compaction_start":
      return [{ type: "compaction", phase: "start" }];
    case "compaction_end":
      return [{ type: "compaction", phase: "end" }];
    default:
      return [];
  }
}
