import { join, resolve } from "node:path";
import { ErrorCodes, type SessionScope, type Tenant } from "./protocol.ts";
import { RpcError } from "./ipc/peer.ts";

/**
 * Tenant segments are canonicalized by the gateway (gateway/internal/tenant). The runtime re-checks
 * them strictly and refuses anything that is not already canonical, so a path can never escape the
 * tenant root even if the gateway is bypassed.
 */
const SEGMENT = /^[A-Za-z0-9_@][A-Za-z0-9_.@-]{0,127}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function assertSegment(value: unknown, field: string): string {
  if (typeof value !== "string" || !SEGMENT.test(value) || value.includes("..")) {
    throw new RpcError(ErrorCodes.invalidParams, `invalid ${field}`);
  }
  return value;
}

export function assertAgentId(value: unknown): string {
  if (typeof value !== "string" || !AGENT_ID.test(value)) {
    throw new RpcError(ErrorCodes.invalidParams, "invalid agentId");
  }
  return value;
}

export function assertTenant(value: unknown): Tenant {
  const tenant = (value ?? {}) as Partial<Tenant>;
  return { workspace: assertSegment(tenant.workspace, "workspace"), userId: assertSegment(tenant.userId, "userId") };
}

export function assertScope(params: Partial<SessionScope>): SessionScope {
  return { tenant: assertTenant(params.tenant), agentId: assertAgentId(params.agentId) };
}

export type TenantPaths = {
  /** <data>/workspaces/<ws> */
  workspaceDir: string;
  /** <data>/workspaces/<ws>/AGENTS.md — workspace-wide instructions shared by every user and agent. */
  workspaceInstructions: string;
  /** <data>/workspaces/<ws>/users/<user>/agents/<agent> — cwd of the agent's tools. */
  agentHome: string;
  /** pi SessionManager JSONL files. */
  sessionDir: string;
};

export function tenantPaths(dataDir: string, scope: SessionScope): TenantPaths {
  const workspaceDir = join(resolve(dataDir), "workspaces", scope.tenant.workspace);
  const agentHome = join(workspaceDir, "users", scope.tenant.userId, "agents", scope.agentId);
  return {
    workspaceDir,
    workspaceInstructions: join(workspaceDir, "AGENTS.md"),
    agentHome,
    sessionDir: join(agentHome, "sessions"),
  };
}
