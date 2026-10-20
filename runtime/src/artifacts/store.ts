import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RpcError } from "../ipc/peer.ts";
import { ErrorCodes, type ArtifactSummary } from "../protocol.ts";
import type { TenantPaths } from "../tenant.ts";
import { validateArtifactHtml } from "./validate.ts";

export type PublishResult =
  | { ok: true; revision: number; bytes: number; changed: boolean }
  | { ok: false; reason: "invalid" | "missing" | "match"; error: string };

type Index = { revisions: ArtifactSummary[] };

const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * Versioned single-file HTML artifacts of one pi session:
 * <userHome>/artifacts/<sessionId>/{index.json, v1.html, v2.html, ...}.
 * Every publish is validated and becomes a new revision; publishing the current document again is a no-op.
 */
export class ArtifactStore {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(readonly dir: string) {}

  static forSession(paths: TenantPaths, sessionId: string): ArtifactStore {
    if (!SESSION_ID.test(sessionId)) throw new RpcError(ErrorCodes.invalidParams, "invalid sessionId");
    return new ArtifactStore(join(paths.userHome, "artifacts", sessionId));
  }

  async list(): Promise<ArtifactSummary[]> {
    return (await this.index()).revisions;
  }

  async get(revision?: number): Promise<{ summary: ArtifactSummary; html: string } | null> {
    const revisions = await this.list();
    const summary = revision === undefined ? revisions.at(-1) : revisions.find((r) => r.revision === revision);
    if (!summary) return null;
    return { summary, html: await readFile(join(this.dir, `v${summary.revision}.html`), "utf8") };
  }

  publish(html: string): Promise<PublishResult> {
    return this.exclusive(async () => {
      const validation = validateArtifactHtml(html);
      if (!validation.ok) return { ok: false, reason: "invalid", error: validation.error };
      const index = await this.index();
      const latest = index.revisions.at(-1);
      if (latest && (await readFile(join(this.dir, `v${latest.revision}.html`), "utf8")) === validation.html) {
        return { ok: true, revision: latest.revision, bytes: latest.bytes, changed: false };
      }
      const revision = (latest?.revision ?? 0) + 1;
      await mkdir(this.dir, { recursive: true });
      await writeFile(join(this.dir, `v${revision}.html`), validation.html, "utf8");
      index.revisions.push({ revision, bytes: validation.bytes, createdAt: new Date().toISOString() });
      await this.writeIndex(index);
      return { ok: true, revision, bytes: validation.bytes, changed: true };
    });
  }

  /** All replacements apply to an in-memory copy, then publish once; any failed match publishes nothing. */
  async edit(edits: Array<{ oldString: string; newString: string }>): Promise<PublishResult> {
    if (!edits.length || edits.length > 20) return { ok: false, reason: "invalid", error: "edits must contain 1 to 20 replacements" };
    const current = await this.get();
    if (!current) return { ok: false, reason: "missing", error: "no design has been published yet" };
    let html = current.html;
    for (const [index, { oldString, newString }] of edits.entries()) {
      if (typeof oldString !== "string" || !oldString || typeof newString !== "string") {
        return { ok: false, reason: "invalid", error: `edit ${index + 1}: old_string must be a non-empty string and new_string a string` };
      }
      const matches = html.split(oldString).length - 1;
      if (matches !== 1) {
        return {
          ok: false,
          reason: "match",
          error: `edit ${index + 1}: old_string matched ${matches} times; it must match exactly once (nothing was published)`,
        };
      }
      html = html.replace(oldString, () => newString);
    }
    return this.publish(html);
  }

  async remove(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  private async index(): Promise<Index> {
    const file = join(this.dir, "index.json");
    if (!existsSync(file)) return { revisions: [] };
    return JSON.parse(await readFile(file, "utf8")) as Index;
  }

  private async writeIndex(index: Index): Promise<void> {
    const tmp = join(this.dir, "index.json.tmp");
    await writeFile(tmp, JSON.stringify(index, null, 2), "utf8");
    await rename(tmp, join(this.dir, "index.json"));
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }
}
