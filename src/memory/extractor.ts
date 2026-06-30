import type { ChatMessage, MemoryKind } from "../types.js";

export type ExtractedMemory = {
  kind: MemoryKind;
  text: string;
  source: "agent" | "user";
};

const preferencePatterns = [
  /我喜欢([^。！!\n]+)/g,
  /我偏好([^。！!\n]+)/g,
  /请用([^。！!\n]+)/g,
  /记住([^。！!\n]+)/g,
];

const factPatterns = [
  /我是([^。！!\n]+)/g,
  /我的名字是([^。！!\n]+)/g,
  /我在做([^。！!\n]+)/g,
  /项目是([^。！!\n]+)/g,
];

const taskPatterns = [
  /待办是([^。！!\n]+)/g,
  /稍后要([^。！!\n]+)/g,
  /帮我记得([^。！!\n]+)/g,
  /下次继续([^。！!\n]+)/g,
];

export function extractMemories(messages: ChatMessage[]): ExtractedMemory[] {
  const results: ExtractedMemory[] = [];

  for (const message of messages) {
    if (message.role !== "user") continue;
    results.push(...matchPatterns(message.text, preferencePatterns, "preference"));
    results.push(...matchPatterns(message.text, factPatterns, "fact"));
    results.push(...matchPatterns(message.text, taskPatterns, "task"));
  }

  return dedupe(results);
}

export function buildRollingSummary(previousSummary: string, messages: ChatMessage[], maxChars = 1200): string {
  const fragments = messages
    .map((message) => `${message.role === "user" ? "用户" : "助手"} ${compactLine(message.text)}`)
    .filter(Boolean);

  const next = [previousSummary.trim(), ...fragments].filter(Boolean).join("\n");
  return next.length <= maxChars ? next : next.slice(next.length - maxChars);
}

function compactLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function matchPatterns(text: string, patterns: RegExp[], kind: MemoryKind): ExtractedMemory[] {
  const list: ExtractedMemory[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0]?.trim();
      if (!value) continue;
      list.push({ kind, text: value, source: "user" });
    }
  }
  return list;
}

function dedupe(items: ExtractedMemory[]): ExtractedMemory[] {
  const map = new Map<string, ExtractedMemory>();
  for (const item of items) {
    map.set(`${item.kind}:${item.text.toLowerCase()}`, item);
  }
  return [...map.values()];
}
