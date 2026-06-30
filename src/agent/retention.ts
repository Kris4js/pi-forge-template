import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { estimateTokens, getLatestCompactionEntry, type AgentSessionRuntime } from "@mariozechner/pi-coding-agent";

export type RetentionPolicy = {
  tokenThresholdRatio?: number;
  summaryMaxAgeDays?: number;
};

export type RetentionCheckResult = {
  compacted: boolean;
  reason?: "tokens" | "age";
  estimatedTokens: number;
  contextWindow?: number;
};

export type RetentionInspection = {
  estimatedTokens: number;
  contextWindow?: number;
  percent?: number;
  shouldCompact: boolean;
  reason?: "tokens" | "age";
  lastCompactionAt?: number;
  tokenThresholdRatio: number;
  summaryMaxAgeDays: number;
};

export async function enforceRetentionPolicy(
  runtime: AgentSessionRuntime,
  policy: RetentionPolicy,
  metadataFile: string,
): Promise<RetentionCheckResult> {
  const inspection = await inspectRetentionPolicy(runtime, policy, metadataFile);
  if (!inspection.shouldCompact) {
    return {
      compacted: false,
      estimatedTokens: inspection.estimatedTokens,
      contextWindow: inspection.contextWindow,
    };
  }

  const session = runtime.session;
  const reason: "tokens" | "age" = inspection.reason ?? "age";
  await session.compact(
    reason === "tokens"
      ? "Summarize aggressively. Preserve user preferences, facts, unfinished tasks, and current objective."
      : "Refresh the summary for a long-lived workspace. Preserve durable context and pending work.",
  );

  await saveMetadata(metadataFile, { lastCompactionAt: Date.now() });
  return { compacted: true, reason, estimatedTokens: inspection.estimatedTokens, contextWindow: inspection.contextWindow };
}

export async function inspectRetentionPolicy(
  runtime: AgentSessionRuntime,
  policy: RetentionPolicy,
  metadataFile: string,
): Promise<RetentionInspection> {
  const tokenThresholdRatio = policy.tokenThresholdRatio ?? 0.9;
  const summaryMaxAgeDays = policy.summaryMaxAgeDays ?? 7;
  const session = runtime.session;
  if (!session.model) {
    return {
      estimatedTokens: 0,
      shouldCompact: false,
      tokenThresholdRatio,
      summaryMaxAgeDays,
    };
  }

  const estimatedTokens = estimateSessionTokens(session.messages);
  const contextWindow = session.model.contextWindow;
  const metadata = await loadMetadata(metadataFile);
  const latestCompaction = getLatestCompactionEntry(session.sessionManager.getEntries());
  const lastCompactionAt = latestCompaction ? Date.parse(latestCompaction.timestamp) : metadata.lastCompactionAt;
  const now = Date.now();
  const tokenOverflow = Boolean(contextWindow && estimatedTokens / contextWindow >= tokenThresholdRatio);
  const expired = lastCompactionAt === undefined ? false : now - lastCompactionAt >= summaryMaxAgeDays * 24 * 60 * 60 * 1000;
  const shouldCompact = tokenOverflow || expired;
  const reason = tokenOverflow ? "tokens" : expired ? "age" : undefined;

  return {
    estimatedTokens,
    contextWindow,
    percent: contextWindow ? estimatedTokens / contextWindow : undefined,
    shouldCompact,
    reason,
    lastCompactionAt,
    tokenThresholdRatio,
    summaryMaxAgeDays,
  };
}

function estimateSessionTokens(messages: Parameters<typeof estimateTokens>[0][]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

type RetentionMetadata = {
  lastCompactionAt?: number;
};

async function loadMetadata(filePath: string): Promise<RetentionMetadata> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as RetentionMetadata;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw error;
  }
}

async function saveMetadata(filePath: string, metadata: RetentionMetadata): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(metadata, null, 2), "utf8");
}

export function getRetentionMetadataFile(agentDir: string): string {
  return join(agentDir, "retention.json");
}
