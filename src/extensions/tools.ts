import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { extractKeywords, LayeredMemoryStore } from "../memory/store.js";
import type { MemoryKind, MemoryVisibility } from "../types.js";

export type CreateToolsOptions = {
  store: LayeredMemoryStore;
};

export function createTools(options: CreateToolsOptions) {
  const { store } = options;

  return function tools(pi: ExtensionAPI) {
    pi.registerTool({
      name: "memory_save",
      label: "Memory Save",
      description: "Save a stable memory with session or user visibility",
      promptSnippet: "Save stable preferences, facts, or pending tasks into scoped memory",
      promptGuidelines: [
        "Use this tool only for information likely to matter in later turns.",
        "Default to user visibility for stable preferences/facts and session visibility for temporary tasks.",
        "Do not write workspace visibility from normal chat tools.",
      ],
      parameters: Type.Object({
        kind: StringEnum(["fact", "preference", "task"] as const),
        text: Type.String({ description: "Memory text to save" }),
        visibility: Type.Optional(StringEnum(["session", "user"] as const)),
        confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Confidence that this is stable and useful" })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = ctx.sessionManager.getSessionId();
        const kind = params.kind as MemoryKind;
        const visibility = resolveSaveVisibility(kind, params.visibility as MemoryVisibility | undefined);
        const record = await store.add({
          sessionId,
          kind,
          text: params.text,
          visibility,
          confidence: typeof params.confidence === "number" ? params.confidence : defaultConfidence(kind, visibility),
          keywords: extractKeywords(params.text),
          source: "agent",
        });

        return {
          content: [{ type: "text", text: `Saved ${record.visibility} ${record.kind} memory: ${record.text}` }],
          details: record,
        };
      },
    });

    pi.registerTool({
      name: "memory_search",
      label: "Memory Search",
      description: "Search scoped memory relevant to the current question",
      promptSnippet: "Search session, user, and workspace memory by keyword overlap",
      promptGuidelines: [
        "Use this before answering when the user asks about earlier preferences, facts, or unfinished tasks.",
        "The search is tenant-safe and never returns other users' memories.",
      ],
      parameters: Type.Object({
        query: Type.String({ description: "What to search for" }),
        visibility: Type.Optional(StringEnum(["session", "user", "workspace", "all"] as const)),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = ctx.sessionManager.getSessionId();
        const visibility = (params.visibility ?? "all") as MemoryVisibility | "all";
        const items = await store.search(sessionId, params.query, 7, visibility);
        await store.touch(items.map((item) => item.id));

        const text =
          items.length > 0
            ? items.map((item) => `- [${item.visibility}/${item.kind}; c=${item.confidence}] ${item.text}`).join("\n")
            : "No relevant memory found";

        return {
          content: [{ type: "text", text }],
          details: { items },
        };
      },
    });

    pi.registerCommand("memories", {
      description: "Print saved memory visible to the current tenant/session",
      handler: async (_args, ctx) => {
        const items = await store.listBySession(ctx.sessionManager.getSessionId(), 50);
        const text = items.length > 0
          ? items.map((item) => `[${item.visibility}/${item.kind}; c=${item.confidence}] ${item.text}`).join("\n")
          : "No saved memory";
        if (ctx.hasUI) ctx.ui.notify(text, "info");
        else console.log(text);
      },
    });
  };
}

function resolveSaveVisibility(kind: MemoryKind, visibility: MemoryVisibility | undefined): MemoryVisibility {
  if (visibility === "session" || visibility === "user") return visibility;
  if (kind === "task") return "session";
  return "user";
}

function defaultConfidence(kind: MemoryKind, visibility: MemoryVisibility): number {
  if (visibility === "session") return 0.6;
  if (kind === "preference") return 0.85;
  return 0.75;
}
