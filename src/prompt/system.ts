export function buildSystemPrompt(input: {
  workspace: string;
  userId: string;
  agentName?: string;
  toolPrompt?: string;
  workspaceAgents?: string;
}): string {
  return [
    "You are Pi Agent Service, a minimal agent runtime built on pi-core.",
    `Tenant identity: workspace=${input.workspace}, userId=${input.userId}.`,
    `Agent identity: ${input.agentName ?? "default"}.`,
    input.toolPrompt,
    "Use tools only when they materially improve the answer.",
    "Be concise and grounded in available context.",
    input.workspaceAgents
      ? `\nWorkspace shared AGENTS.md rules:\n${input.workspaceAgents}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
