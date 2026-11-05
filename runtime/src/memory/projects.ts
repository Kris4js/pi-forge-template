import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RpcError } from "../ipc/peer.ts";
import { ErrorCodes, type Project, type ProjectParams } from "../protocol.ts";
import { assertSegment, type TenantPaths } from "../tenant.ts";
import { database } from "./database.ts";
import { listSessions } from "./sessions.ts";

const writes = new Map<string, Promise<unknown>>();
/** Serialize mutations and run setup for each user, including project deletion vs. starting a run. */
export async function withUserLock<T>(paths: TenantPaths, action: () => Promise<T>): Promise<T> {
  const key = paths.sessionDir;
  const previous = writes.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  writes.set(key, next);
  try { return await next; } finally { if (writes.get(key) === next) writes.delete(key); }
}

function projectFile(paths: TenantPaths, id: string) {
  return join(paths.userHome, "projects", `${assertSegment(id, "projectId")}.json`);
}

export async function getProject(paths: TenantPaths, id: string): Promise<Project> {
  const path = projectFile(paths, id);
  if (database) {
    const stored = await database.get<Project>(paths, "project", id);
    if (!stored) throw new RpcError(ErrorCodes.notFound, "project not found");
    return stored.value;
  }
  try { return JSON.parse(await readFile(path, "utf8")) as Project; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RpcError(ErrorCodes.notFound, "project not found");
    throw error;
  }
}

export async function listProjects(paths: TenantPaths): Promise<Project[]> {
  let projects: Project[];
  if (database) projects = await database.list<Project>(paths, "project");
  else {
    const files = await readdir(join(paths.userHome, "projects")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    projects = await Promise.all(files.filter((f) => f.endsWith(".json")).map((f) => getProject(paths, f.slice(0, -5))));
  }
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export async function saveProject(paths: TenantPaths, params: ProjectParams, create = false): Promise<Project> {
  const id = create ? randomUUID() : assertSegment(params.projectId, "projectId");
  const current = create ? undefined : await getProject(paths, id);
  if (!create && params.name === undefined && params.instructions === undefined) throw new RpcError(ErrorCodes.invalidParams, "name or instructions is required");
  const name = params.name === undefined ? current?.name : typeof params.name === "string" ? params.name.replace(/[\r\n]+/g, " ").trim() : "";
  const instructions = params.instructions === undefined ? current?.instructions ?? "" : params.instructions;
  if (!name || name.length > 80) throw new RpcError(ErrorCodes.invalidParams, "name must be 1..80 characters");
  if (typeof instructions !== "string" || instructions.length > 20000) throw new RpcError(ErrorCodes.invalidParams, "instructions must be at most 20000 characters");
  const now = new Date().toISOString();
  const project: Project = { id, name, instructions, createdAt: current?.createdAt ?? now, updatedAt: now };
  if (database) {
    const stored = create ? undefined : await database.get<Project>(paths, "project", id);
    await database.put(paths, "project", id, project, stored?.version ?? 0);
  } else {
    await mkdir(join(paths.userHome, "projects"), { recursive: true });
    const file = projectFile(paths, id);
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(project), "utf8");
    await rename(tmp, file);
  }
  return project;
}

export async function deleteProject(paths: TenantPaths, id: string): Promise<void> {
  await getProject(paths, id);
  if ((await listSessions(paths)).some((s) => s.projectId === id)) throw new RpcError(ErrorCodes.conflict, "project contains conversations");
  if (database) {
    const stored = await database.get<Project>(paths, "project", id);
    if (!stored) throw new RpcError(ErrorCodes.notFound, "project not found");
    await database.remove(paths, "project", id, stored.version);
  } else await rm(projectFile(paths, id));
}
