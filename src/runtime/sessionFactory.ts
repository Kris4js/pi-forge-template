import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import { JsonMemoryStore, LayeredMemoryStore } from "../memory/store.js";
import { JsonSummaryStore } from "../memory/summaryStore.js";
import { createMemory } from "../extensions/memory.js";
import { createTools } from "../extensions/tools.js";
import { AgentRuntimeConfig } from "./config.js";
import {
  ensureWorkspaceDirs,
  resolveWorkspacePaths,
  type WorkspaceOptions,
  type WorkspacePaths,
} from "./workspace.js";

export type RuntimeOptions = WorkspaceOptions & {
  cwd?: string;
  agentDir?: string;
  sessionDir?: string;
  envFilePath?: string;
  projectRoot?: string;
  extensions?: ExtensionFactory[];
};

export async function createMinipiRuntime(
  options: RuntimeOptions = {},
  config = new AgentRuntimeConfig({ envFilePath: options.envFilePath }),
): Promise<{
  runtime: AgentSessionRuntime;
  store: LayeredMemoryStore;
  summaryStore: JsonSummaryStore;
  workspace: WorkspacePaths;
  config: AgentRuntimeConfig;
}> {
  const workspace = resolveWorkspacePaths(options);
  await ensureWorkspaceDirs(workspace);
  const cwd = options.cwd ?? workspace.cwd;
  const agentDir = options.agentDir ?? workspace.agentDir;
  const sessionDir = options.sessionDir ?? workspace.sessionDir;
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const skillPaths = resolveSkillPaths(projectRoot, workspace.workspaceDir);
  const workspaceAgents = await readWorkspaceAgents(workspace.workspaceDir);
  const settingsManager = SettingsManager.inMemory();
  const userStore = new JsonMemoryStore(workspace.userMemoryFile, {
    workspace: workspace.workspace,
    userId: workspace.userId,
    visibility: "user",
  });
  const workspaceStore = new JsonMemoryStore(workspace.workspaceMemoryFile, {
    workspace: workspace.workspace,
    userId: "*",
    visibility: "workspace",
  });
  const store = new LayeredMemoryStore(
    { workspace: workspace.workspace, userId: workspace.userId },
    userStore,
    workspaceStore,
  );
  const summaryStore = new JsonSummaryStore(workspace.summaryFile);
  const extensionFactories: ExtensionFactory[] = [
    createMemory({ store, summaryStore }),
    createTools({ store }),
    ...(options.extensions ?? []),
  ];

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
        additionalSkillPaths: skillPaths,
        extensionFactories,
        systemPromptOverride: () =>
          [
            "You are Pi Agent Service, a minimal agent runtime built on pi-core.",
            `Tenant identity: workspace=${workspace.workspace}, userId=${workspace.userId}.`,
            "Memory visibility rules: session is current conversation only; user is this user across sessions; workspace is stable shared rules/knowledge only.",
            "Use memory when it helps, but never infer or expose another user's memory.",
            "Use tools only when they materially improve the answer.",
            "Be concise and grounded in available context.",
            workspaceAgents
              ? `\nWorkspace shared AGENTS.md rules:\n${workspaceAgents}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
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

  await bindRuntimeSession(runtime);
  await config.applyToRuntime(runtime);
  return { runtime, store, summaryStore, workspace, config };
}

export async function bindRuntimeSession(
  runtime: AgentSessionRuntime,
): Promise<void> {
  await runtime.session.bindExtensions({});
}

// Resolve skill paths from workspace and project root. Skills are workspace-shared, not user-private.
function resolveSkillPaths(
  projectRoot: string,
  workspaceDir: string,
): string[] {
  const workspaceSkillsDir = join(workspaceDir, "skills");
  const projectSkillsDir = join(projectRoot, ".pi", "skills");
  return [workspaceSkillsDir, projectSkillsDir].filter((path) =>
    existsSync(path),
  );
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
