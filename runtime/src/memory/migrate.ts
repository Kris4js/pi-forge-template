import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { configureStorage, database } from "./database.ts";
import type { SessionRecord } from "./managed-session.ts";
import type { Project } from "../protocol.ts";
import { assertSegment, tenantPaths } from "../tenant.ts";

try { process.loadEnvFile(process.env.FORGE_ENV_FILE ?? ".env"); } catch { /* optional */ }

async function directories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}
async function files(path: string): Promise<string[]> {
  return readdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

/** Run offline with the target database configured. Source JSONL and preferences remain untouched. */
async function migrate() {
  const dataDir = resolve(process.env.FORGE_DATA_DIR ?? ".data");
  if (!process.env.FORGE_STORAGE || process.env.FORGE_STORAGE === "file") throw new Error("Set FORGE_STORAGE to sqlite, mysql or pgsql before importing");
  await configureStorage(dataDir);
  let imported = 0;
  let skipped = 0;
  try {
    for (const workspace of await directories(join(dataDir, "workspaces"))) {
      assertSegment(workspace, "workspace");
      for (const userId of await directories(join(dataDir, "workspaces", workspace, "users"))) {
        assertSegment(userId, "userId");
        const paths = tenantPaths(dataDir, { workspace, userId });
        let pins: string[] = [];
        try {
          const value = JSON.parse(await readFile(paths.pinsFile, "utf8")) as { pinned?: string[] };
          if (Array.isArray(value.pinned)) pins = value.pinned;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        for (const name of await files(join(paths.userHome, "projects"))) {
          if (!name.endsWith(".json")) continue;
          const project = JSON.parse(await readFile(join(paths.userHome, "projects", name), "utf8")) as Project;
          assertSegment(project.id, "projectId");
          if (name !== `${project.id}.json`) throw new Error(`Project ID does not match filename: ${name}`);
          if (await database!.get(paths, "project", project.id)) { skipped++; continue; }
          await database!.put(paths, "project", project.id, project, 0);
          imported++;
        }
        for (const name of await files(paths.sessionDir)) {
          if (!name.endsWith(".jsonl")) continue;
          const path = join(paths.sessionDir, name);
          // Read the original entries without SessionManager.open(), which may rewrite old formats.
          const entries = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
          const header = entries.shift();
          if (header?.type !== "session" || header.version !== 3 || typeof header.id !== "string") {
            throw new Error(`Unsupported session format in ${path}; expected pi session v3`);
          }
          if (await database!.get(paths, "session", header.id)) { skipped++; continue; }
          // Preserve original entry IDs, ancestry and the last persisted leaf.
          const record: SessionRecord = { header, entries, leafId: entries.at(-1)?.id ?? null, pinned: pins.includes(header.id), updatedAt: entries.at(-1)?.timestamp ?? header.timestamp };
          await database!.put(paths, "session", header.id, record, 0);
          imported++;
        }
      }
    }
    console.log(`Imported ${imported} records; skipped ${skipped} existing records. Source files retained.`);
  } finally { await database!.close(); }
}

await migrate().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
