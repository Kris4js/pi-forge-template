import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveTenantIdentity } from "../workspace/tenant.js";
import type { RuntimeManager } from "./runtimes.js";
import { HttpError, readJson, requireString, sendJson, sendSseHeaders, writeSse } from "./http.js";

export type ApiRouterOptions = {
  runtimeManager: RuntimeManager;
};

export class ApiRouter {
  constructor(private readonly options: ApiRouterOptions) {}

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method === "GET" && url.pathname === "/api/state") {
      const tenant = this.resolveApiTenant({
        workspace: url.searchParams.get("workspace") ?? "demo",
        userId: url.searchParams.get("userId") ?? undefined,
      });
      await this.options.runtimeManager.withRuntime(tenant.workspace, tenant.userId, undefined, async (runtime) => {
        const snapshot = await runtime.getSnapshot();
        const workspaces = await runtime.listWorkspaces();
        const modelCatalog = await runtime.getModelCatalog();
        sendJson(res, 200, { ok: true, snapshot, workspaces, modelCatalog });
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      await this.handleChat(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/session/select") {
      const body = await readJson(req);
      const tenant = this.resolveApiTenant({
        workspace: String(body.workspace ?? "demo"),
        userId: typeof body.userId === "string" ? body.userId : undefined,
      });
      await this.options.runtimeManager.withRuntime(tenant.workspace, tenant.userId, undefined, async (runtime) => {
        await runtime.selectSession(String(body.sessionId ?? ""));
        const snapshot = await runtime.getSnapshot();
        sendJson(res, 200, { ok: true, snapshot });
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/session/new") {
      const body = await readJson(req);
      const tenant = this.resolveApiTenant({
        workspace: String(body.workspace ?? "demo"),
        userId: typeof body.userId === "string" ? body.userId : undefined,
      });
      await this.options.runtimeManager.withNewSessionRuntime(tenant.workspace, tenant.userId, async (runtime, sessionId) => {
        const snapshot = await runtime.getSnapshot();
        sendJson(res, 200, { ok: true, sessionId, snapshot });
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  }

  private async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const tenant = this.resolveApiTenant({
      workspace: String(body.workspace ?? "demo"),
      userId: typeof body.userId === "string" ? body.userId : undefined,
    });
    const workspace = tenant.workspace;
    const userId = tenant.userId;
    const prompt = requireString(body.prompt, "prompt");
    const sessionId = body.sessionId ? String(body.sessionId) : undefined;
    const includeSnapshot = body.includeSnapshot === true;

    if (body.stream === false) {
      const result = await this.options.runtimeManager.runChatRequest({
        workspace,
        userId,
        prompt,
        sessionId,
        stream: false,
      });
      const payload: Record<string, unknown> = { ok: true, output: result.output };
      if (result.recoveredSession) payload.recoveredSession = true;
      if (result.previousSessionId) payload.previousSessionId = result.previousSessionId;
      if (includeSnapshot) {
        await this.options.runtimeManager.withRuntime(workspace, userId, result.output.sessionId, async (runtime) => {
          payload.snapshot = await runtime.getSnapshot();
        });
      }
      sendJson(res, 200, payload);
      return;
    }

    sendSseHeaders(res);
    writeSse(res, "start", { ok: true });
    try {
      const result = await this.options.runtimeManager.runChatRequest({
        workspace,
        userId,
        prompt,
        sessionId,
        stream: true,
        onTextDelta: (delta) => writeSse(res, "delta", { delta }),
        onToolEvent: (event) => writeSse(res, event.type, event),
      });
      const payload: Record<string, unknown> = { ok: true, output: result.output };
      if (result.recoveredSession) payload.recoveredSession = true;
      if (result.previousSessionId) payload.previousSessionId = result.previousSessionId;
      if (includeSnapshot) {
        await this.options.runtimeManager.withRuntime(workspace, userId, result.output.sessionId, async (runtime) => {
          payload.snapshot = await runtime.getSnapshot();
        });
      }
      writeSse(res, "done", payload);
    } catch (error) {
      writeSse(res, "error", {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown server error",
      });
    } finally {
      res.end();
    }
  }

  private resolveApiTenant(input: { workspace?: string; userId?: string }) {
    try {
      return resolveTenantIdentity(input);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "Invalid tenant identity");
    }
  }
}
