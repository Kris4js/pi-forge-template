import { cp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAgentName, type WorkspacePaths } from "../workspace/paths.js";

const projectRootDir = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const bundledSkillsDir = join(projectRootDir, "src", "skills");

export type BootstrapAgentWorkspaceInput = {
  agentName?: string;
  workspace: WorkspacePaths;
  skillsSourceDir?: string;
};

export async function bootstrapAgentWorkspace(input: BootstrapAgentWorkspaceInput): Promise<void> {
  const agentName = normalizeAgentName(input.agentName);
  const sourceDir = join(input.skillsSourceDir ?? bundledSkillsDir, agentName);
  const targetDir = join(input.workspace.workspaceDir, ".pi", "skills");

  await rm(targetDir, { recursive: true, force: true });
  await cp(sourceDir, targetDir, { recursive: true, force: true, errorOnExist: false }).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  });
}
