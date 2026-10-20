import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Peer } from "./ipc/peer.ts";
import { Methods, type ToolAuthorizeParams, type ToolAuthorizeResult } from "./protocol.ts";

export type GovernanceOptions = {
  runId: string;
  peer: Peer;
  /** cwd that relative tool paths resolve against. */
  cwd: string;
  /** Roots the file-reading built-ins may touch (agent home + agent definition dir). */
  readRoots: string[];
  /** Roots the file-writing built-ins may touch (agent home only). */
  writeRoots: string[];
};

const READ_TOOLS = new Set(["read", "ls", "grep", "find"]);
const WRITE_TOOLS = new Set(["edit", "write"]);

/**
 * Every tool call passes two gates before pi executes it:
 *  1. a local filesystem sandbox for pi's built-in file tools (paths are a runtime concern), then
 *  2. the gateway's policy decision over IPC (allow / deny, possibly after human approval).
 * Any error blocks the call: pi treats a throwing tool_call handler as a block.
 */
export function governanceExtension(options: GovernanceOptions): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      const sandboxError = checkSandbox(event.toolName, event.input, options);
      if (sandboxError) return { block: true, reason: sandboxError };

      const params: ToolAuthorizeParams = {
        runId: options.runId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
      };
      const result = await options.peer.request<ToolAuthorizeResult>(Methods.toolAuthorize, params, ctx.signal);
      if (result?.decision === "allow") return undefined;
      return { block: true, reason: result?.reason || "denied by gateway policy" };
    });
  };
}

function checkSandbox(toolName: string, input: unknown, options: GovernanceOptions): string | undefined {
  const roots = READ_TOOLS.has(toolName) ? options.readRoots : WRITE_TOOLS.has(toolName) ? options.writeRoots : null;
  if (!roots) return undefined;
  const raw = (input as { path?: unknown } | undefined)?.path;
  const target = resolve(options.cwd, typeof raw === "string" && raw ? raw : ".");
  const inside = roots.some((root) => {
    const rel = relative(resolve(root), target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  return inside ? undefined : `path outside sandbox: ${typeof raw === "string" ? raw : "."}`;
}
