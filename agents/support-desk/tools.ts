import { randomUUID } from "node:crypto";
import { appendFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentToolsFactory } from "../../runtime/src/agents/manifest.ts";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });

const tools: AgentToolsFactory = (ctx) => [
  defineTool({
    name: "search_kb",
    label: "Search knowledge base",
    description: "Keyword search over the support knowledge base. Returns matching passages with their source file.",
    parameters: Type.Object({ query: Type.String({ description: "Keywords, e.g. 退款 到账" }) }),
    async execute(_id, params) {
      const dir = join(ctx.agentDir, "knowledge");
      const terms = params.query.split(/\s+/).filter(Boolean);
      const hits: string[] = [];
      for (const file of (await readdir(dir)).filter((f) => f.endsWith(".md"))) {
        const lines = (await readFile(join(dir, file), "utf8")).split("\n");
        for (const line of lines) {
          if (terms.some((t) => line.includes(t))) hits.push(`[${file}] ${line.replace(/^[-#\s]+/, "")}`);
        }
      }
      return text(hits.length ? hits.slice(0, 12).join("\n") : "知识库中没有匹配内容。");
    },
  }),
  defineTool({
    name: "create_ticket",
    label: "Create support ticket",
    description: "Open a ticket for human follow-up. Side effect: requires approval by the gateway.",
    parameters: Type.Object({
      subject: Type.String(),
      detail: Type.String(),
      priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")])),
    }),
    async execute(_id, params) {
      const ticket = {
        id: `T-${randomUUID().slice(0, 8)}`,
        createdAt: new Date().toISOString(),
        user: ctx.tenant.userId,
        priority: params.priority ?? "normal",
        subject: params.subject,
        detail: params.detail,
      };
      // Demo persistence: one JSONL file in the user's agent home.
      await appendFile(join(ctx.userHome, "tickets.jsonl"), JSON.stringify(ticket) + "\n");
      return text(`工单已创建：${ticket.id}（优先级 ${ticket.priority}）`);
    },
  }),
];

export default tools;
