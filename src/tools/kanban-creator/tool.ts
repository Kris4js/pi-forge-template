import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

type ToolCallBody = {
  taskId?: string;
  sessionId?: string;
  arguments?: Record<string, unknown>;
};

const projectRootDir = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const baseUrl = readEnvValue("KANBAN_TOOL_BASE_URL")?.replace(/\/+$/, "");
const apiKey = readEnvValue("KANBAN_TOOL_API_KEY") ?? "";

export function getKanbanCreatorTools(agentName: string) {
  if (agentName !== "kanban-creator" || !baseUrl) return [];
  return [semanticListCatalogTool(), dataMaterializeWidgetTool(), qualityApplyReportQualityGateTool()];
}

export function getKanbanCreatorToolPrompt(agentName: string): string | undefined {
  if (agentName !== "kanban-creator" || !baseUrl) return undefined;
  return [
    "Available kanban tools:",
    "- semantic_listCatalog: List kanban semantic datasets, metrics, and dimensions.",
    "- data_materializeWidget: Materialize one dashboard_spec widget with semantic-layer data; never pass raw SQL.",
    "- quality_applyReportQualityGate: Apply the report quality gate and remove empty widgets, raw IDs, and fake anomalies.",
  ].join("\n");
}

function semanticListCatalogTool() {
  return defineTool({
    name: "semantic_listCatalog",
    label: "List Semantic Catalog",
    description: "返回 kanban 后端当前可用的语义数据集、指标和维度。",
    promptSnippet: "List kanban semantic datasets, metrics, and dimensions.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.String()),
      sessionId: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => callKanbanTool("semantic.listCatalog", params),
  });
}

function dataMaterializeWidgetTool() {
  return defineTool({
    name: "data_materializeWidget",
    label: "Materialize Report Widget",
    description: "基于语义层为单个 dashboard_spec widget 装载数据。不要传自由 SQL。",
    promptSnippet: "Materialize one dashboard_spec widget with kanban semantic-layer data; never pass raw SQL.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.String()),
      sessionId: Type.Optional(Type.String()),
      widget: Type.Any(),
      filters: Type.Optional(Type.Record(Type.String(), Type.Any())),
    }),
    execute: async (_toolCallId, params) => callKanbanTool("data.materializeWidget", params),
  });
}

function qualityApplyReportQualityGateTool() {
  return defineTool({
    name: "quality_applyReportQualityGate",
    label: "Apply Report Quality Gate",
    description: "清理空组件、裸 ID、假异常，并补充质量缺口说明。",
    promptSnippet: "Apply the kanban report quality gate and remove empty widgets, raw IDs, and fake anomalies.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.String()),
      sessionId: Type.Optional(Type.String()),
      report: Type.Any(),
    }),
    execute: async (_toolCallId, params) => callKanbanTool("quality.applyReportQualityGate", params),
  });
}

function readEnvValue(name: string): string | undefined {
  const runtimeValue = process.env[name]?.trim();
  if (runtimeValue) return runtimeValue;
  try {
    const env = readFileSync(resolve(projectRootDir, ".env"), "utf8");
    const line = env.split(/\r?\n/).find((item) => item.trim().startsWith(`${name}=`));
    return line?.slice(line.indexOf("=") + 1).trim().replace(/^['\"]|['\"]$/g, "") || undefined;
  } catch {
    return undefined;
  }
}

async function callKanbanTool(toolName: string, params: Record<string, unknown>) {
  const { taskId, sessionId, ...args } = params;
  const body: ToolCallBody = {
    taskId: typeof taskId === "string" ? taskId : undefined,
    sessionId: typeof sessionId === "string" ? sessionId : undefined,
    arguments: args,
  };
  const response = await fetch(`${baseUrl}/${encodeURIComponent(toolName)}/call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "X-Tool-Api-Key": apiKey } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json?.data?.ok === false || json?.ok === false) {
    const message =
      json?.data?.error?.message ?? json?.error?.message ?? json?.message ?? `Kanban tool ${toolName} failed`;
    throw new Error(String(message));
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(json?.data?.result ?? json?.result ?? json) }],
    details: json,
  };
}
