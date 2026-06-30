import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_USER_ID,
  normalizeTenantSegment,
  resolveTenantIdentity,
} from "./tenant.js";

const projectRootDir = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const defaultWorkspaceRootDir = resolve(
  process.env.MINIPI_WORKSPACES_DIR ?? join(projectRootDir, ".workspaces"),
);

export type WorkspaceOptions = {
  rootDir?: string;
  workspace?: string;
  userId?: string;
};

export type WorkspacePaths = {
  rootDir: string;
  workspace: string;
  userId: string;
  workspaceDir: string;
  userDir: string;
  sharedDir: string;
  agentDir: string;
  sessionDir: string;
  memoryFile: string;
  userMemoryFile: string;
  workspaceMemoryFile: string;
  summaryFile: string;
  cwd: string;
};

export function resolveWorkspacePaths(options: WorkspaceOptions = {}): WorkspacePaths {
  const rootDir = resolve(options.rootDir ?? defaultWorkspaceRootDir);
  const tenant = resolveTenantIdentity(
    {
      workspace: options.workspace ?? "default",
      userId: options.userId ?? DEFAULT_USER_ID,
    },
    { requireUserId: false },
  );
  const workspace = tenant.workspace;
  const userId = tenant.userId;
  const workspaceDir = join(rootDir, workspace);
  const userDir = join(workspaceDir, "users", userId);
  const sharedDir = join(workspaceDir, "shared");
  const agentDir = workspaceDir;
  const sessionDir = join(userDir, "sessions");
  const userMemoryFile = join(userDir, "memory.json");
  const workspaceMemoryFile = join(sharedDir, "memory.json");
  const summaryFile = join(userDir, "summary.json");

  return {
    rootDir,
    workspace,
    userId,
    workspaceDir,
    userDir,
    sharedDir,
    agentDir,
    sessionDir,
    memoryFile: userMemoryFile,
    userMemoryFile,
    workspaceMemoryFile,
    summaryFile,
    cwd: userDir,
  };
}

export async function ensureWorkspaceDirs(paths: WorkspacePaths): Promise<void> {
  await mkdir(paths.sessionDir, { recursive: true });
  await mkdir(paths.sharedDir, { recursive: true });
  await mkdir(join(paths.workspaceDir, "skills"), { recursive: true });
}

export async function listWorkspaceNames(rootDir: string): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }
}

export function getDefaultWorkspaceRootDir(): string {
  return defaultWorkspaceRootDir;
}

export function normalizeWorkspaceName(input: string): string {
  return normalizeTenantSegment(input, "default", { lowerCase: true });
}

export function normalizeUserId(input: string | undefined): string {
  return normalizeTenantSegment(input, DEFAULT_USER_ID, { lowerCase: false });
}

