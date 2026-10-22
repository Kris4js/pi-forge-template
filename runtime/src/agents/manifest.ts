import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { GenerateImageParams } from "../model/images.ts";
import type { Attachment, ImageAsset } from "../protocol.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { Tenant } from "../protocol.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * agents/<id>/agent.json. The gateway reads the same file for metadata and `policy`;
 * the runtime uses everything else. See agents/README.md.
 */
export type AgentManifest = {
  id: string;
  name: string;
  description?: string;
  /** System prompt file, relative to the agent dir. Default: prompt.md */
  prompt?: string;
  model?: { provider?: string; id?: string; thinkingLevel?: ThinkingLevel };
  /** Tool allowlist: pi built-ins (read, ls, grep, find, bash, edit, write) and names from tools.ts. */
  tools?: string[];
  /** Module exporting custom tools, relative to the agent dir. Default: tools.ts when present. */
  toolsModule?: string;
  /** pi skills directory, relative to the agent dir. Default: skills/ when present. */
  skills?: string;
  memory?: {
    /** pi auto-compaction of the session JSONL. Default true. */
    compaction?: boolean;
  };
  /**
   * Live preview while a tool call streams: the runtime forwards this string argument of this tool
   * as artifact_draft events, e.g. { "tool": "publish_design", "argument": "html" }.
   */
  preview?: { tool: string; argument: string };
  /** Enforced by the gateway; listed here for completeness. */
  policy?: Record<string, unknown>;
  starters?: string[];
};

/** What an agent's tools.ts receives. Everything is already scoped to one tenant. */
export type AgentToolContext = {
  tenant: Tenant;
  agentId: string;
  /** Agent definition directory (read-only assets such as knowledge files). */
  agentDir: string;
  /** The user's writable directory, shared by all of the user's agents. */
  userHome: string;
  /** The pi session this run belongs to. */
  sessionId: string;
  /** Versioned HTML artifacts of this session. Return `details: { artifact: { revision, bytes } }` from a tool that publishes. */
  artifacts: ArtifactStore;
  /** Persist generated PNG/JPEG/WebP bytes; return details: { images } from the tool. */
  generateImages: (params: GenerateImageParams & { referenceIds?: string[] }, signal?: AbortSignal) => Promise<Attachment[]>;
  publishImages: (images: Attachment[]) => Promise<ImageAsset[]>;
};

export type AgentToolsFactory = (ctx: AgentToolContext) => ToolDefinition<any, any, any>[];

export type AgentDefinition = {
  manifest: AgentManifest;
  dir: string;
  systemPrompt: string;
  skillsDir?: string;
  toolsFactory?: AgentToolsFactory;
};

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export async function loadAgent(agentsDir: string, id: string): Promise<AgentDefinition> {
  if (!ID.test(id)) throw new Error(`invalid agent id: ${id}`);
  const dir = join(agentsDir, id);
  const manifest = JSON.parse(await readFile(join(dir, "agent.json"), "utf8")) as AgentManifest;
  if (manifest.id !== id) throw new Error(`agent.json id "${manifest.id}" does not match directory "${id}"`);

  const promptFile = join(dir, manifest.prompt ?? "prompt.md");
  const systemPrompt = (await readFile(promptFile, "utf8")).trim();

  const skillsDir = join(dir, manifest.skills ?? "skills");
  const toolsPath = join(dir, manifest.toolsModule ?? "tools.ts");
  let toolsFactory: AgentToolsFactory | undefined;
  if (existsSync(toolsPath)) {
    const mod = (await import(toolsPath)) as { default?: AgentToolsFactory };
    if (typeof mod.default !== "function") throw new Error(`${toolsPath} must default-export a tools factory`);
    toolsFactory = mod.default;
  } else if (manifest.toolsModule) {
    throw new Error(`toolsModule not found: ${toolsPath}`);
  }

  return {
    manifest: withDefaultTools(manifest),
    dir,
    systemPrompt,
    skillsDir: existsSync(skillsDir) ? skillsDir : undefined,
    toolsFactory,
  };
}

/**
 * Runtime tools every agent gets without listing them in agent.json; the gateway adds the same set
 * (gateway/internal/agents/registry.go). An agent opts out with policy.tools.<name> = "deny".
 */
export const DEFAULT_TOOLS = ["ask_user"] as const;

function withDefaultTools(manifest: AgentManifest): AgentManifest {
  const listed = manifest.tools ?? [];
  const decisions = (manifest.policy as { tools?: Record<string, unknown> } | undefined)?.tools ?? {};
  const added = DEFAULT_TOOLS.filter((tool) => !listed.includes(tool) && decisions[tool] !== "deny");
  return added.length ? { ...manifest, tools: [...listed, ...added] } : manifest;
}

/** Agent definitions are immutable for the lifetime of the process; restart the runtime to reload. */
export class AgentCatalog {
  private readonly cache = new Map<string, Promise<AgentDefinition>>();

  constructor(readonly agentsDir: string) {}

  get(id: string): Promise<AgentDefinition> {
    let entry = this.cache.get(id);
    if (!entry) {
      entry = loadAgent(this.agentsDir, id);
      entry.catch(() => this.cache.delete(id));
      this.cache.set(id, entry);
    }
    return entry;
  }
}
