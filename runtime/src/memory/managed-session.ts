import { SessionManager, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { database } from "./database.ts";
import type { TenantPaths } from "../tenant.ts";

export type SessionRecord = {
  header: SessionHeader;
  entries: SessionEntry[];
  leafId: string | null;
  pinned?: boolean;
  updatedAt: string;
};

type Pending = { flush: () => Promise<void> };
const pending = new WeakMap<SessionManager, Pending>();

/**
 * pi has no public import-from-entries API. Keep this small, version-pinned bridge here:
 * replay the original entries through its index builder without creating temporary JSONL files.
 * Tests cover IDs, branches, labels, compaction and context after restoring.
 */
export function restoreSession(cwd: string, record: SessionRecord): SessionManager {
  const manager = SessionManager.inMemory(cwd, { id: record.header.id });
  const internals = manager as unknown as { fileEntries: (SessionHeader | SessionEntry)[]; _buildIndex(): void };
  if (!Array.isArray(internals.fileEntries) || typeof internals._buildIndex !== "function") {
    throw new Error("Unsupported pi SessionManager version: database restoration bridge needs updating");
  }
  internals.fileEntries = structuredClone([record.header, ...record.entries]);
  internals._buildIndex();
  if (record.leafId) manager.branch(record.leafId);
  else manager.resetLeaf();
  return manager;
}

export function persistSession(paths: TenantPaths, manager: SessionManager, initialVersion: number, pinned?: boolean, store = database!) {
  let version = initialVersion;
  let queue = Promise.resolve();
  let failure: unknown;
  const save = () => {
    if (failure) throw failure;
    const value: SessionRecord = structuredClone({
      header: manager.getHeader()!, entries: manager.getEntries(), leafId: manager.getLeafId(),
      pinned, updatedAt: new Date().toISOString(),
    });
    queue = queue.then(async () => {
      if (failure) return;
      version = await store.put(paths, "session", manager.getSessionId(), value, version);
    }).catch((error) => { failure = error; });
  };
  manager._persist = save;
  pending.set(manager, { flush: async () => { await queue; if (failure) throw failure; } });
  return save;
}

export async function flushSession(manager: SessionManager): Promise<void> {
  await pending.get(manager)?.flush();
}
