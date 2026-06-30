import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveWorkspacePaths } from "../../index.js";
import { PRODUCT_AI_OVERVIEW_PROMPT } from "../../prompt/product/index.js";
import type { RuntimeManager } from "./runtimeManager.js";

export type ProductLeadingAiOverviewRequest = {
  workspace?: string;
  userId?: string;
  username?: string;
  user?: {
    id?: string;
    name?: string;
  };
  forceRefresh?: boolean;
  dt_type?: "月度" | "日度" | "自定义";
  dt?: string;
  dt_start?: string;
  dt_end?: string;
  tab_select?: string;
  channel_type?: string;
  channel_value?: string;
};

export type ProductLeadingAiOverviewData = {
  title: string;
  summary: string;
  bullets: string[];
  risks: string[];
  suggestions: string[];
  text: string;
  cached: boolean;
  cacheKey: string;
  generatedAt: string;
  expiresAt: string;
  userId: string;
  params: Required<Pick<ProductLeadingAiOverviewRequest, "dt_type" | "dt" | "dt_start" | "dt_end" | "tab_select" | "channel_type" | "channel_value">>;
};

export class ProductLeadingAiOverviewManager {
  constructor(private readonly runtimeManager: RuntimeManager) {}

  async getOverview(body: Record<string, unknown>): Promise<ProductLeadingAiOverviewData> {
    const request = this.normalizeRequest(body);
    const userId = this.resolveUserId(request);
    const params = this.normalizeParams(request);
    const cacheKey = this.makeCacheKey({ userId, params });
    const cacheFile = this.getCacheFile(userId, cacheKey);
    const now = Date.now();

    if (!request.forceRefresh) {
      const cached = await this.readCache(cacheFile, now);
      if (cached) {
        return {
          ...cached,
          cached: true,
        };
      }
    }

    const workspace = this.runtimeManager.normalizeWorkspaceKey(request.workspace || "product");
    const prompt = this.buildPrompt(params);
    const output = await this.runtimeManager.withRuntime(workspace, userId, undefined, async (runtime) => {
      return runtime.chatOnce({ prompt, userId, stream: false });
    });
    const parsed = this.parseText(output.text);
    const generatedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + this.getTtlMs(params.dt_type)).toISOString();
    const data: ProductLeadingAiOverviewData = {
      title: "AI 速览",
      summary: parsed.summary,
      bullets: parsed.bullets,
      risks: parsed.risks,
      suggestions: parsed.suggestions,
      text: output.text,
      cached: false,
      cacheKey,
      generatedAt,
      expiresAt,
      userId,
      params,
    };

    await this.writeCache(cacheFile, data);
    return data;
  }

  private normalizeRequest(body: Record<string, unknown>): ProductLeadingAiOverviewRequest {
    const user = typeof body.user === "object" && body.user !== null ? body.user as Record<string, unknown> : undefined;
    return {
      workspace: typeof body.workspace === "string" ? body.workspace : "product",
      userId: typeof body.userId === "string" ? body.userId : undefined,
      username: typeof body.username === "string" ? body.username : undefined,
      user: user
        ? {
            id: typeof user.id === "string" ? user.id : undefined,
            name: typeof user.name === "string" ? user.name : undefined,
          }
        : undefined,
      forceRefresh: body.forceRefresh === true,
      dt_type: this.isDtType(body.dt_type) ? body.dt_type : undefined,
      dt: typeof body.dt === "string" ? body.dt : undefined,
      dt_start: typeof body.dt_start === "string" ? body.dt_start : undefined,
      dt_end: typeof body.dt_end === "string" ? body.dt_end : undefined,
      tab_select: typeof body.tab_select === "string" ? body.tab_select : undefined,
      channel_type: typeof body.channel_type === "string" ? body.channel_type : undefined,
      channel_value: typeof body.channel_value === "string" ? body.channel_value : undefined,
    };
  }

  private isDtType(value: unknown): value is ProductLeadingAiOverviewRequest["dt_type"] {
    return value === "月度" || value === "日度" || value === "自定义";
  }

  private resolveUserId(request: ProductLeadingAiOverviewRequest): string {
    return this.sanitizeCacheSegment(request.user?.id || request.userId || request.username || request.user?.name || "anonymous");
  }

  private normalizeParams(request: ProductLeadingAiOverviewRequest): ProductLeadingAiOverviewData["params"] {
    const dtType = request.dt_type || "月度";
    return {
      dt_type: dtType,
      dt: dtType === "自定义" ? "" : request.dt || "",
      dt_start: dtType === "自定义" ? request.dt_start || "" : "",
      dt_end: dtType === "自定义" ? request.dt_end || "" : "",
      tab_select: request.tab_select || "营收结构",
      channel_type: request.channel_type || "品类",
      channel_value: request.channel_value || "",
    };
  }

  private makeCacheKey(input: { userId: string; params: ProductLeadingAiOverviewData["params"] }): string {
    return createHash("sha256")
      .update(JSON.stringify({ version: 2, ...input }))
      .digest("hex")
      .slice(0, 32);
  }

  private getCacheFile(userId: string, cacheKey: string): string {
    const workspace = resolveWorkspacePaths({ workspace: "product" });
    return join(workspace.workspaceDir, "cache", "product-leading-ai-overview", userId, `${cacheKey}.json`);
  }

  private async readCache(cacheFile: string, now: number): Promise<ProductLeadingAiOverviewData | undefined> {
    try {
      const parsed = JSON.parse(await readFile(cacheFile, "utf8")) as ProductLeadingAiOverviewData;
      const expiresAt = Date.parse(parsed.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt > now) return parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") console.warn(`Failed to read AI overview cache: ${cacheFile}`, error);
    }
    return undefined;
  }

  private async writeCache(cacheFile: string, data: ProductLeadingAiOverviewData): Promise<void> {
    await mkdir(join(cacheFile, ".."), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(data, null, 2), "utf8");
  }

  private getTtlMs(dtType: ProductLeadingAiOverviewData["params"]["dt_type"]): number {
    const override = Number(process.env.PRODUCT_LEADING_AI_CACHE_TTL_MS);
    if (Number.isFinite(override) && override > 0) return override;
    if (dtType === "月度") return 6 * 60 * 60 * 1000;
    return 30 * 60 * 1000;
  }

  private buildPrompt(params: ProductLeadingAiOverviewData["params"]): string {
    return PRODUCT_AI_OVERVIEW_PROMPT
      .replace("{{scope}}", JSON.stringify(params, null, 2))
      .replace("{{output_schema}}", JSON.stringify({
        summary: "不超过 60 字的总览结论",
        bullets: ["关键发现 1", "关键发现 2", "关键发现 3"],
        risks: ["风险或异常 1"],
        suggestions: ["建议动作 1", "建议动作 2"],
      }, null, 2));
  }

  private parseText(text: string): Pick<ProductLeadingAiOverviewData, "summary" | "bullets" | "risks" | "suggestions"> {
    const jsonText = this.extractJsonObject(text);
    if (jsonText) {
      try {
        const parsed = JSON.parse(jsonText) as Record<string, unknown>;
        return {
          summary: this.stringifyValue(parsed.summary) || "AI 速览已生成。",
          bullets: this.normalizeStringList(parsed.bullets).slice(0, 4),
          risks: this.normalizeStringList(parsed.risks).slice(0, 3),
          suggestions: this.normalizeStringList(parsed.suggestions).slice(0, 3),
        };
      } catch {
        // fall through to text parsing
      }
    }

    const lines = text
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*\d.、\s]+/, "").trim())
      .filter(Boolean);
    return {
      summary: lines[0] || "AI 速览暂无内容。",
      bullets: lines.slice(1, 5),
      risks: [],
      suggestions: [],
    };
  }

  private extractJsonObject(text: string): string | undefined {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
    const source = fenced || text;
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return undefined;
    return source.slice(start, end + 1);
  }

  private stringifyValue(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  private normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map((item) => this.stringifyValue(item)).filter(Boolean);
  }

  private sanitizeCacheSegment(value: string): string {
    return value.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "anonymous";
  }
}
