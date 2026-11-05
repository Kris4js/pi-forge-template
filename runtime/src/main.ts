import { resolve } from "node:path";
import { getImageAsset } from "./image-assets.ts";
import { AgentCatalog } from "./agents/manifest.ts";
import { ArtifactStore } from "./artifacts/store.ts";
import { Peer, RpcError } from "./ipc/peer.ts";
import { deleteSession, getSession, getSessionInfo, listAllArtifacts, listSessions, sessionKey, updateSession } from "./memory/sessions.ts";
import { configureStorage, database } from "./memory/database.ts";
import { deleteProject, getProject, listProjects, saveProject, withUserLock } from "./memory/projects.ts";
import { Models } from "./model/registry.ts";
import {
  ErrorCodes,
  Methods,
  PROTOCOL_VERSION,
  type ArtifactDetail,
  type ArtifactGetParams,
  type HelloResult,
  type ProjectParams,
  type RunCancelParams,
  type RunStartParams,
  type SessionGetParams,
  type SessionUpdateParams,
  type TenantParams,
} from "./protocol.ts";
import { Runner } from "./run.ts";
import { assertTenant, tenantPaths } from "./tenant.ts";

// stdout carries the protocol only. Anything else that writes to it (SDK, tools, console.log)
// is redirected to stderr, which the gateway forwards to its log.
const writeProtocol = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
console.log = console.error;
const log = (msg: string) => process.stderr.write(`[runtime] ${msg}\n`);

try {
  process.loadEnvFile(process.env.FORGE_ENV_FILE ?? ".env");
} catch {
  // optional
}

const agentsDir = resolve(process.env.FORGE_AGENTS_DIR ?? "agents");
const dataDir = resolve(process.env.FORGE_DATA_DIR ?? ".data");
let models: Models;
try {
  models = await Models.create();
  await configureStorage(dataDir);
} catch (error) {
  // Fatal configuration error: say why and exit non-zero so the gateway surfaces it.
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(78);
}
const catalog = new AgentCatalog(agentsDir);
const peer = new Peer(process.stdin, (line) => void writeProtocol(line), log);
const runner = new Runner({ peer, catalog, models, dataDir, log });

const scopePaths = (params: { tenant?: TenantParams["tenant"] }) => tenantPaths(dataDir, assertTenant(params.tenant));
const requireSessionId = (params: { sessionId?: unknown }) => {
  if (typeof params.sessionId !== "string") throw new RpcError(ErrorCodes.invalidParams, "sessionId is required");
  return params.sessionId;
};

peer.handle(Methods.hello, (): HelloResult => ({
  protocolVersion: PROTOCOL_VERSION,
  runtime: "pi-forge-runtime",
  model: models.describeDefault(),
}));
peer.handle(Methods.imageGet, async (params: SessionGetParams & { id: string }) => {
  const paths = scopePaths(params);
  const sessionId = requireSessionId(params);
  await getSessionInfo(paths, sessionId);
  return getImageAsset(paths.userHome, sessionId, params.id);
});
peer.handle(Methods.modelsList, () => models.list());
peer.handle(Methods.runStart, (params: RunStartParams) => withUserLock(scopePaths(params), () => runner.start(params)));
peer.handle(Methods.runCancel, (params: RunCancelParams) => runner.cancel(params.runId));
peer.handle(Methods.projectList, (params: TenantParams) => listProjects(scopePaths(params)));
peer.handle(Methods.projectCreate, (params: ProjectParams) => withUserLock(scopePaths(params), () => saveProject(scopePaths(params), params, true)));
peer.handle(Methods.projectUpdate, (params: ProjectParams) => withUserLock(scopePaths(params), () => saveProject(scopePaths(params), params)));
peer.handle(Methods.projectDelete, (params: ProjectParams) => withUserLock(scopePaths(params), async () => {
  const paths = scopePaths(params);
  if (typeof params.projectId !== "string") throw new RpcError(ErrorCodes.invalidParams, "projectId is required");
  if (runner.isProjectBusy(sessionKey(paths, params.projectId))) throw new RpcError(ErrorCodes.conflict, "project has an active run");
  await deleteProject(paths, params.projectId);
  return { deleted: true };
}));
peer.handle(Methods.sessionList, async (params: TenantParams) => {
  const paths = scopePaths(params);
  if (params.projectId !== undefined) await getProject(paths, params.projectId);
  const sessions = await listSessions(paths);
  return params.projectId === undefined ? sessions : sessions.filter((s) => s.projectId === params.projectId);
});
peer.handle(Methods.sessionInfo, (params: SessionGetParams) => getSessionInfo(scopePaths(params), requireSessionId(params)));
peer.handle(Methods.sessionGet, (params: SessionGetParams) => getSession(scopePaths(params), requireSessionId(params)));
peer.handle(Methods.artifactList, (params: SessionGetParams) =>
  ArtifactStore.forSession(scopePaths(params), requireSessionId(params)).list(),
);
peer.handle(Methods.artifactListAll, (params: TenantParams) => listAllArtifacts(scopePaths(params)));
peer.handle(Methods.artifactGet, async (params: ArtifactGetParams): Promise<ArtifactDetail> => {
  const revision = params.revision === undefined ? undefined : Number(params.revision);
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) {
    throw new RpcError(ErrorCodes.invalidParams, "invalid revision");
  }
  const found = await ArtifactStore.forSession(scopePaths(params), requireSessionId(params)).get(revision);
  if (!found) throw new RpcError(ErrorCodes.notFound, "artifact not found");
  return { ...found.summary, html: found.html };
});
peer.handle(Methods.sessionUpdate, (params: SessionUpdateParams) => withUserLock(scopePaths(params), async () => {
  const paths = scopePaths(params);
  const { projectId } = params;
  if (projectId !== undefined && projectId !== null && typeof projectId !== "string") {
    throw new RpcError(ErrorCodes.invalidParams, "projectId must be a string or null");
  }
  // Under the user lock, so the project cannot be deleted between this check and the move.
  if (typeof projectId === "string") await getProject(paths, projectId);
  await updateSession(paths, requireSessionId(params), params, (key) => runner.isBusy(key));
  return { updated: true };
}));
peer.handle(Methods.sessionDelete, (params: SessionGetParams) => withUserLock(scopePaths(params), async () => {
  const paths = scopePaths(params);
  const id = requireSessionId(params);
  if (runner.isBusy(sessionKey(paths, id))) throw new RpcError(ErrorCodes.conflict, "session is busy");
  await deleteSession(paths, id);
  return { deleted: true };
}));

let stopping = false;
async function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  log(`shutting down (${reason}), active runs: ${runner.activeCount}`);
  await runner.cancelAll();
  await database?.close();
  process.exit(0);
}
// The gateway owns our lifecycle: when it closes stdin, we go.
process.stdin.on("end", () => void shutdown("stdin closed"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

log(`ready: agents=${agentsDir} data=${dataDir} model=${models.describeDefault()}`);
