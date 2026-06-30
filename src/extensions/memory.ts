import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { extractKeywords, LayeredMemoryStore } from "../memory/store.js";
import { buildMemoryFromSummaries, buildSevenTurnSummary, type ConversationTurn, JsonSummaryStore } from "../memory/summaryStore.js";

export type CreateMemoryOptions = {
  store: LayeredMemoryStore;
  summaryStore: JsonSummaryStore;
};

export function createMemory(options: CreateMemoryOptions) {
  const { store, summaryStore } = options;

  return function memory(pi: ExtensionAPI) {

    pi.on("before_agent_start", async (event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const memories = await store.search(sessionId, event.prompt, 7, "all");
      const summaries = await summaryStore.search(sessionId, event.prompt, 3);
      await store.touch(memories.map((item) => item.id));
      await summaryStore.touch(summaries.map((item) => item.id));

      const blocks: string[] = [];
      if (memories.length > 0) {
        const workspaceMemories = memories.filter((item) => item.visibility === "workspace");
        const userMemories = memories.filter((item) => item.visibility === "user");
        const sessionMemories = memories.filter((item) => item.visibility === "session");
        if (workspaceMemories.length > 0) blocks.push(`Workspace shared stable knowledge\n${workspaceMemories.map((item) => `- [${item.kind}; c=${item.confidence}] ${item.text}`).join("\n")}`);
        if (userMemories.length > 0) blocks.push(`User long-term memory\n${userMemories.map((item) => `- [${item.kind}; c=${item.confidence}] ${item.text}`).join("\n")}`);
        if (sessionMemories.length > 0) blocks.push(`Session-scoped memory\n${sessionMemories.map((item) => `- [${item.kind}; c=${item.confidence}] ${item.text}`).join("\n")}`);
      }
      if (summaries.length > 0) {
        blocks.push(`Conversation summaries (lower priority)\n${summaries.map((item) => `- ${item.text}`).join("\n")}`);
      }

      if (blocks.length === 0) return;

      return {
        message: {
          customType: "memory-context",
          content: blocks.join("\n\n"),
          display: false,
        },
      };
    });

    pi.on("agent_end", async (_event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const turns = branchToTurns(ctx.sessionManager.getBranch());
      if (turns.length === 0) return;

      const existingSummaries = await summaryStore.listBySession(sessionId);
      let summarizedTurns = existingSummaries.reduce((total, summary) => total + summary.turnCount, 0);
      while (turns.length - summarizedTurns >= 7) {
        const batch = turns.slice(summarizedTurns, summarizedTurns + 7);
        const turnStart = summarizedTurns + 1;
        const turnEnd = summarizedTurns + batch.length;
        await summaryStore.add({
          sessionId,
          turnStart,
          turnEnd,
          turnCount: batch.length,
          text: buildSevenTurnSummary(batch, turnStart, turnEnd),
        });
        summarizedTurns += batch.length;
      }

      const unpromotedSummaries = await summaryStore.listUnpromotedBySession(sessionId);
      for (let index = 0; index + 7 <= unpromotedSummaries.length; index += 7) {
        const batch = unpromotedSummaries.slice(index, index + 7);
        const text = buildMemoryFromSummaries(batch);
        const durableLines = extractDurableSummaryLines(text);
        if (durableLines.length === 0) continue;
        const durableText = ["长期稳定记忆", ...durableLines.map((line) => `- ${line}`)].join("\n");
        const record = await store.add({
          sessionId,
          kind: "fact",
          text: durableText,
          visibility: "user",
          confidence: 0.72,
          keywords: extractKeywords(durableText),
          source: "summary",
        });
        await summaryStore.markPromoted(batch.map((item) => item.id), record.id);
      }
    });
  };
}

function extractDurableSummaryLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("稳定信息：") || line.startsWith("- 用户姓名：") || line.startsWith("- 偏好："))
    .map((line) => line.replace(/^稳定信息：/, "").replace(/^-\s*/, "").trim())
    .filter(Boolean);
}

function branchToTurns(entries: unknown[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let pendingUser: string | undefined;

  for (const entry of entries as Array<{ type?: string; message?: { role?: string; content?: unknown } }>) {
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = flattenText(entry.message?.content);
    if (!text) continue;

    if (role === "user") {
      if (pendingUser) turns.push({ user: pendingUser });
      pendingUser = text;
      continue;
    }

    if (pendingUser) {
      turns.push({ user: pendingUser, assistant: text });
      pendingUser = undefined;
    }
  }

  if (pendingUser) turns.push({ user: pendingUser });
  return turns;
}

function flattenText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const block = item as { type?: string; text?: string };
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}
