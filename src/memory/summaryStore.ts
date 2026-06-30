import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../types.js";
import { extractKeywords } from "./store.js";

export type SummaryRecord = {
  id: string;
  sessionId: string;
  turnStart: number;
  turnEnd: number;
  turnCount: number;
  text: string;
  keywords: string[];
  createdAt: number;
  lastUsedAt: number;
  promotedToMemoryId?: string;
  promotedAt?: number;
};

export type ConversationTurn = {
  user: string;
  assistant?: string;
};

export class JsonSummaryStore {
  constructor(private readonly filePath: string) {}

  async list(): Promise<SummaryRecord[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      if (!raw.trim()) return [];
      const parsed = JSON.parse(raw) as SummaryRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw error;
    }
  }

  async saveAll(records: SummaryRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(records, null, 2), "utf8");
  }

  async add(input: { sessionId: string; turnStart: number; turnEnd: number; turnCount: number; text: string }): Promise<SummaryRecord> {
    const records = await this.list();
    const now = Date.now();
    const record: SummaryRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      turnStart: input.turnStart,
      turnEnd: input.turnEnd,
      turnCount: input.turnCount,
      text: input.text.trim(),
      keywords: extractKeywords(input.text),
      createdAt: now,
      lastUsedAt: now,
    };
    records.push(record);
    await this.saveAll(records);
    return record;
  }

  async markPromoted(ids: string[], memoryId: string): Promise<void> {
    if (ids.length === 0) return;
    const records = await this.list();
    const idSet = new Set(ids);
    const now = Date.now();
    for (const record of records) {
      if (idSet.has(record.id)) {
        record.promotedToMemoryId = memoryId;
        record.promotedAt = now;
        record.lastUsedAt = now;
      }
    }
    await this.saveAll(records);
  }

  async touch(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const records = await this.list();
    const idSet = new Set(ids);
    const now = Date.now();
    for (const record of records) {
      if (idSet.has(record.id)) record.lastUsedAt = now;
    }
    await this.saveAll(records);
  }

  async listBySession(sessionId: string): Promise<SummaryRecord[]> {
    const records = await this.list();
    return records
      .filter((item) => item.sessionId === sessionId)
      .sort((a, b) => a.turnStart - b.turnStart || a.createdAt - b.createdAt);
  }

  async listUnpromotedBySession(sessionId: string): Promise<SummaryRecord[]> {
    const records = await this.listBySession(sessionId);
    return records.filter((item) => !item.promotedToMemoryId);
  }

  async search(sessionId: string, query: string, limit = 3): Promise<SummaryRecord[]> {
    const records = await this.list();
    const terms = extractKeywords(query);
    return records
      .map((item) => ({ item, score: scoreSummary(item, sessionId, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.item);
  }
}

function scoreSummary(record: SummaryRecord, sessionId: string, terms: string[]): number {
  const haystack = `${record.text} ${record.keywords.join(" ")}`.toLowerCase();
  const hits = terms.length === 0 ? 0 : terms.filter((term) => haystack.includes(term)).length;
  const sameSessionBoost = record.sessionId === sessionId ? 2 : 0;
  const ageDays = (Date.now() - record.lastUsedAt) / (1000 * 60 * 60 * 24);
  const recencyBoost = Math.max(0, 1.5 - ageDays / 14);
  if (terms.length === 0) return sameSessionBoost + recencyBoost;
  return hits * 8 + sameSessionBoost + recencyBoost;
}

export function buildSevenTurnSummary(turns: ConversationTurn[], turnStart: number, turnEnd: number): string {
  const messages: ChatMessage[] = turns.flatMap((turn) => [
    { role: "user" as const, text: turn.user },
    ...(turn.assistant ? [{ role: "assistant" as const, text: turn.assistant }] : []),
  ]);
  const durable = extractDurableLines(messages);
  const userGoals = dedupe(turns.map((turn) => compactLine(turn.user)).filter(Boolean)).slice(0, 5);
  const outcome = compactLine(turns.at(-1)?.assistant ?? "");

  const lines = [`轮次 ${turnStart}-${turnEnd} 摘要`];
  if (durable.length > 0) lines.push(`稳定信息：${durable.join("；")}`);
  if (userGoals.length > 0) lines.push(`用户重点：${userGoals.map((item) => truncate(item, 120)).join("；")}`);
  if (outcome) lines.push(`最近结果：${truncate(outcome, 160)}`);
  return lines.join("\n");
}

export function buildMemoryFromSummaries(summaries: SummaryRecord[]): string {
  const durable = dedupe(summaries.flatMap((summary) => summary.text.split(/\r?\n/).filter((line) => line.startsWith("稳定信息："))));
  const topics = dedupe(summaries.map((summary) => summary.text.replace(/\s+/g, " ").trim())).slice(0, 7);
  const lines = ["长期记忆摘要"];
  if (durable.length > 0) lines.push(...durable.map((line) => line.replace(/^稳定信息：/, "- ")));
  lines.push(...topics.map((item) => `- ${truncate(item, 220)}`));
  return lines.join("\n");
}

function extractDurableLines(messages: ChatMessage[]): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = message.text;
    for (const pattern of [/我叫([^。！!\n]+)/g, /我的名字是([^。！!\n]+)/g]) {
      for (const match of text.matchAll(pattern)) lines.push(`用户姓名：${compactLine(match[1] ?? "")}`);
    }
    for (const pattern of [/我喜欢([^。！!\n]+)/g, /我偏好([^。！!\n]+)/g, /请用([^。！!\n]+)/g]) {
      for (const match of text.matchAll(pattern)) lines.push(`偏好：${compactLine(match[0] ?? "")}`);
    }
    for (const pattern of [/待办是([^。！!\n]+)/g, /稍后要([^。！!\n]+)/g, /帮我记得([^。！!\n]+)/g, /下次继续([^。！!\n]+)/g]) {
      for (const match of text.matchAll(pattern)) lines.push(`任务：${compactLine(match[0] ?? "")}`);
    }
  }
  return dedupe(lines.filter((line) => !line.endsWith("：")));
}

function compactLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}
