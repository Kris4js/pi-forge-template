import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryKind, MemoryRecord, MemorySource, MemoryVisibility, TenantIdentity } from "../types.js";

export type AddMemoryInput = {
  sessionId: string;
  kind: MemoryKind;
  text: string;
  keywords?: string[];
  source?: MemorySource;
  visibility?: MemoryVisibility;
  confidence?: number;
};

export type MemorySearchInput = {
  workspace: string;
  userId: string;
  sessionId: string;
  query: string;
  visibility?: MemoryVisibility | "all";
  limit?: number;
};

export class JsonMemoryStore {
  constructor(
    private readonly filePath: string,
    private readonly defaults: { workspace: string; userId: string; visibility?: MemoryVisibility } = {
      workspace: "default",
      userId: "anonymous",
    },
  ) {}

  async list(): Promise<MemoryRecord[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      if (!raw.trim()) return [];
      const parsed = JSON.parse(raw) as Array<Partial<MemoryRecord> & { source?: "agent" | "user" }>;
      return Array.isArray(parsed) ? parsed.map((item) => normalizeRecord(item, this.defaults)) : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw error;
    }
  }

  async saveAll(records: MemoryRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(records, null, 2), "utf8");
  }

  async add(input: AddMemoryInput): Promise<MemoryRecord> {
    const records = await this.list();
    const now = Date.now();
    const normalizedText = input.text.trim();
    const visibility = input.visibility ?? this.defaults.visibility ?? "user";
    const userId = visibility === "workspace" ? "*" : this.defaults.userId;
    const existing = records.find(
      (item) =>
        item.workspace === this.defaults.workspace &&
        item.userId === userId &&
        item.sessionId === input.sessionId &&
        item.visibility === visibility &&
        item.kind === input.kind &&
        item.text.toLowerCase() === normalizedText.toLowerCase(),
    );

    if (existing) {
      existing.lastUsedAt = now;
      existing.confidence = Math.max(existing.confidence ?? 0, input.confidence ?? existing.confidence ?? 0.8);
      existing.keywords = dedupeKeywords([...(existing.keywords ?? []), ...(input.keywords ?? extractKeywords(normalizedText))]);
      await this.saveAll(records);
      return existing;
    }

    const record: MemoryRecord = {
      id: randomUUID(),
      workspace: this.defaults.workspace,
      userId,
      sessionId: input.sessionId,
      visibility,
      kind: input.kind,
      text: normalizedText,
      keywords: dedupeKeywords(input.keywords ?? extractKeywords(normalizedText)),
      createdAt: now,
      lastUsedAt: now,
      source: input.source ?? "agent",
      confidence: normalizeConfidence(input.confidence),
    };

    records.push(record);
    await this.saveAll(records);
    return record;
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

  async listBySession(sessionId: string, limit = 50): Promise<MemoryRecord[]> {
    const records = await this.list();
    return records
      .filter((item) => item.sessionId === sessionId)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, limit);
  }

  async search(sessionId: string, query: string, limit = 5): Promise<MemoryRecord[]> {
    const records = await this.list();
    const terms = normalizeTerms(query);
    const identity = { workspace: this.defaults.workspace, userId: this.defaults.userId, sessionId };

    return records
      .filter((item) => canReadMemory(item, identity))
      .map((item) => ({ item, score: scoreMemory(item, sessionId, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.item);
  }
}

export class LayeredMemoryStore {
  constructor(
    private readonly identity: TenantIdentity,
    private readonly userStore: JsonMemoryStore,
    private readonly workspaceStore: JsonMemoryStore,
  ) {}

  async list(): Promise<MemoryRecord[]> {
    return [...await this.userStore.list(), ...await this.workspaceStore.list()]
      .filter((record) => canReadMemory(record, this.identity));
  }

  async add(input: AddMemoryInput): Promise<MemoryRecord> {
    const visibility = input.visibility ?? "user";
    if (visibility === "workspace") {
      return this.workspaceStore.add({ ...input, visibility });
    }
    return this.userStore.add({ ...input, visibility });
  }

  async touch(ids: string[]): Promise<void> {
    await Promise.all([this.userStore.touch(ids), this.workspaceStore.touch(ids)]);
  }

  async listBySession(sessionId: string, limit = 50): Promise<MemoryRecord[]> {
    const records = await this.list();
    return records
      .filter((item) => item.visibility !== "session" || item.sessionId === sessionId)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, limit);
  }

  async search(sessionId: string, query: string, limit = 5, visibility: MemoryVisibility | "all" = "all"): Promise<MemoryRecord[]> {
    const terms = normalizeTerms(query);
    const records = await this.list();
    return records
      .filter((item) => visibility === "all" || item.visibility === visibility)
      .filter((item) => canReadMemory(item, { ...this.identity, sessionId }))
      .map((item) => ({ item, score: scoreMemory(item, sessionId, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.item);
  }
}

function normalizeRecord(
  raw: Partial<MemoryRecord> & { source?: "agent" | "user" },
  defaults: { workspace: string; userId: string; visibility?: MemoryVisibility },
): MemoryRecord {
  const visibility = raw.visibility ?? defaults.visibility ?? "user";
  return {
    id: raw.id ?? randomUUID(),
    workspace: raw.workspace ?? defaults.workspace,
    userId: raw.userId ?? (visibility === "workspace" ? "*" : defaults.userId),
    sessionId: raw.sessionId ?? "unknown",
    visibility,
    kind: raw.kind ?? "fact",
    text: raw.text ?? "",
    keywords: raw.keywords ?? extractKeywords(raw.text ?? ""),
    createdAt: raw.createdAt ?? Date.now(),
    lastUsedAt: raw.lastUsedAt ?? raw.createdAt ?? Date.now(),
    source: raw.source ?? "agent",
    confidence: normalizeConfidence(raw.confidence),
  };
}

function canReadMemory(record: MemoryRecord, identity: TenantIdentity): boolean {
  if (record.workspace !== identity.workspace) return false;
  if (record.visibility === "workspace") return true;
  if (record.userId !== identity.userId) return false;
  if (record.visibility === "session") return record.sessionId === identity.sessionId;
  return record.visibility === "user";
}

function scoreMemory(record: MemoryRecord, sessionId: string, terms: string[]): number {
  const haystack = `${record.text} ${record.keywords.join(" ")}`.toLowerCase();
  const hits = terms.length === 0 ? 0 : terms.filter((term) => haystack.includes(term)).length;
  const visibilityBoost = record.visibility === "workspace" ? 1 : record.visibility === "user" ? 2 : 3;
  const sameSessionBoost = record.sessionId === sessionId ? 2 : 0;
  const confidenceBoost = Math.max(0, Math.min(1, record.confidence)) * 2;
  const ageDays = (Date.now() - record.lastUsedAt) / (1000 * 60 * 60 * 24);
  const recencyBoost = Math.max(0, 2 - ageDays / 14);
  if (terms.length === 0) return visibilityBoost + sameSessionBoost + confidenceBoost + recencyBoost;
  return hits * 10 + visibilityBoost + sameSessionBoost + confidenceBoost + recencyBoost;
}

export function extractKeywords(text: string): string[] {
  return dedupeKeywords(
    text
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2),
  );
}

function normalizeTerms(text: string): string[] {
  return extractKeywords(text);
}

function dedupeKeywords(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function normalizeConfidence(confidence: number | undefined): number {
  if (confidence === undefined || !Number.isFinite(confidence)) return 0.8;
  return Math.max(0, Math.min(1, confidence));
}
