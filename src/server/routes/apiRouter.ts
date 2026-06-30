import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveTenantIdentity } from "../../runtime/tenant.js";
import { PRODUCT_ASSISTANT_PROMPT } from "../../prompt/product/index.js";
import type { ProductLeadingAiOverviewManager } from "../managers/productLeadingAiOverviewManager.js";
import type { RuntimeManager, RuntimeModelOverride } from "../managers/runtimeManager.js";
import { HttpError, readJson, requireString, sendJson, sendSseHeaders, writeSse } from "../utils/http.js";

export type ApiRouterOptions = {
  runtimeManager: RuntimeManager;
  productLeadingAiOverviewManager: ProductLeadingAiOverviewManager;
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

    if (req.method === "POST" && url.pathname === "/api/product-leading/ai-overview") {
      const body = await readJson(req);
      const data = await this.options.productLeadingAiOverviewManager.getOverview(body);
      sendJson(res, 200, { ok: true, data });
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

    if (req.method === "POST" && url.pathname === "/api/model-config") {
      const body = await readJson(req);
      const tenant = this.resolveApiTenant({
        workspace: String(body.workspace ?? "demo"),
        userId: typeof body.userId === "string" ? body.userId : undefined,
      });
      const workspace = tenant.workspace;
      const override: RuntimeModelOverride = {
        provider: String(body.provider ?? ""),
        modelId: String(body.modelId ?? ""),
        thinkingLevel: body.thinkingLevel ? String(body.thinkingLevel) as RuntimeModelOverride["thinkingLevel"] : undefined,
        apiKey: body.apiKey ? String(body.apiKey) : undefined,
      };
      await this.options.runtimeManager.setModelOverride(workspace, override);
      await this.options.runtimeManager.withRuntime(workspace, tenant.userId, undefined, async (runtime) => {
        const snapshot = await runtime.getSnapshot();
        sendJson(res, 200, { ok: true, snapshot });
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
    const prompt = this.resolveChatPrompt(body);
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

  private resolveChatPrompt(body: Record<string, unknown>): string {
    const prompt = requireString(body.prompt, "prompt");
    if (body.promptType !== "product-assistant") return prompt;

    return PRODUCT_ASSISTANT_PROMPT
      .replace("{{scope}}", this.buildProductAssistantScope(body.pageContext))
      .replace("{{context}}", this.buildProductAssistantContext(body.pageContext))
      .replace("{{question}}", prompt);
  }

  private buildProductAssistantScope(pageContext: unknown): string {
    const context = this.isRecord(pageContext) ? pageContext : {};
    const filters = this.isRecord(context.filters) ? context.filters : {};
    const aiParams = this.isRecord(context.aiParams) ? context.aiParams : {};

    return [
      `dt_type：${this.text(aiParams.dt_type) || this.text(filters.dateTypeText)}`,
      `dt：${this.text(aiParams.dt)}`,
      `dt_start：${this.text(aiParams.dt_start)}`,
      `dt_end：${this.text(aiParams.dt_end)}`,
      `结构标签：${this.text(aiParams.tab_select) || this.text(filters.tabSelect) || "营收结构"}`,
      `维度：${this.text(aiParams.channel_type) || this.text(filters.channelType) || "品类"}`,
      `当前选中项：${this.text(aiParams.channel_value) || this.text(filters.channelValue) || "全部"}`,
    ].join("\n");
  }

  private buildProductAssistantContext(pageContext: unknown): string {
    if (!this.isRecord(pageContext) || !this.isRecord(pageContext.aiOverview)) return "暂无。";
    const aiOverview = pageContext.aiOverview;
    const lines = [
      this.text(aiOverview.summary),
      ...this.textList(aiOverview.bullets),
      ...this.textList(aiOverview.risks).map((item) => `风险：${item}`),
      ...this.textList(aiOverview.suggestions).map((item) => `建议：${item}`),
      !this.text(aiOverview.summary) ? this.text(aiOverview.text) : "",
    ].filter(Boolean);

    return lines.length ? lines.join("\n") : "暂无。";
  }

  private text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  private textList(value: unknown): string[] {
    return Array.isArray(value) ? value.map((item) => this.text(item)).filter(Boolean) : [];
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private resolveApiTenant(input: { workspace?: string; userId?: string }) {
    try {
      return resolveTenantIdentity(input);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "Invalid tenant identity");
    }
  }
}
