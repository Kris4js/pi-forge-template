import { resolve } from "node:path";
import { AgentCatalog } from "./agents/manifest.ts";
import { Peer, RpcError } from "./ipc/peer.ts";
import { deleteSession, getSession, listSessions } from "./memory/sessions.ts";
import { Models } from "./model/registry.ts";
import {
  ErrorCodes,
  Methods,
  PROTOCOL_VERSION,
  type HelloResult,
  type RunCancelParams,
  type RunStartParams,
  type SessionGetParams,
  type SessionScope,
} from "./protocol.ts";
import { Runner } from "./run.ts";
import { assertScope, tenantPaths } from "./tenant.ts";

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
  models = new Models();
} catch (error) {
  // Fatal configuration error: say why and exit non-zero so the gateway surfaces it.
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(78);
}
const catalog = new AgentCatalog(agentsDir);
const peer = new Peer(process.stdin, (line) => void writeProtocol(line), log);
const runner = new Runner({ peer, catalog, models, dataDir, log });

const scopePaths = (params: Partial<SessionScope>) => tenantPaths(dataDir, assertScope(params));
const requireSessionId = (params: Partial<SessionGetParams>) => {
  if (typeof params.sessionId !== "string") throw new RpcError(ErrorCodes.invalidParams, "sessionId is required");
  return params.sessionId;
};

peer.handle(Methods.hello, (): HelloResult => ({
  protocolVersion: PROTOCOL_VERSION,
  runtime: "pi-forge-runtime",
  model: models.describeDefault(),
}));
peer.handle(Methods.runStart, (params: RunStartParams) => runner.start(params));
peer.handle(Methods.runCancel, (params: RunCancelParams) => runner.cancel(params.runId));
peer.handle(Methods.sessionList, (params: SessionScope) => listSessions(scopePaths(params)));
peer.handle(Methods.sessionGet, (params: SessionGetParams) => getSession(scopePaths(params), requireSessionId(params)));
peer.handle(Methods.sessionDelete, async (params: SessionGetParams) => {
  await deleteSession(scopePaths(params), requireSessionId(params));
  return { deleted: true };
});

let stopping = false;
async function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  log(`shutting down (${reason}), active runs: ${runner.activeCount}`);
  await runner.cancelAll();
  process.exit(0);
}
// The gateway owns our lifecycle: when it closes stdin, we go.
process.stdin.on("end", () => void shutdown("stdin closed"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

log(`ready: agents=${agentsDir} data=${dataDir} model=${models.describeDefault()}`);
