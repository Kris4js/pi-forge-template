import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentToolsFactory } from "../../runtime/src/agents/manifest.ts";

const DIMENSIONS = ["date", "channel", "category", "store"] as const;
type Row = Record<(typeof DIMENSIONS)[number], string> & { revenue: number; orders: number };

async function loadRows(agentDir: string): Promise<Row[]> {
  const [header, ...lines] = (await readFile(join(agentDir, "data", "sales.csv"), "utf8")).trim().split("\n");
  const cols = header!.split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    const row = Object.fromEntries(cols.map((c, i) => [c, cells[i]])) as Record<string, string>;
    return { ...row, revenue: Number(row.revenue), orders: Number(row.orders) } as Row;
  });
}

const tools: AgentToolsFactory = (ctx) => [
  defineTool({
    name: "query_sales",
    label: "Query sales",
    description:
      "Aggregate the demo sales dataset (2026-09-01..2026-09-14; dimensions: date, channel, category, store; " +
      "metrics: revenue, orders). Optionally compare a current period against a baseline period.",
    parameters: Type.Object({
      groupBy: Type.Array(Type.Union(DIMENSIONS.map((d) => Type.Literal(d))), { description: "Dimensions to group by" }),
      filters: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "e.g. {\"channel\":\"小程序\"}" })),
      period: Type.Optional(Type.Object({ from: Type.String(), to: Type.String() }, { description: "Inclusive ISO dates" })),
      baseline: Type.Optional(Type.Object({ from: Type.String(), to: Type.String() })),
    }),
    async execute(_id, params) {
      const rows = (await loadRows(ctx.agentDir)).filter((row) =>
        Object.entries(params.filters ?? {}).every(([k, v]) => row[k as keyof Row] === v),
      );
      const aggregate = (range?: { from: string; to: string }) => {
        const out = new Map<string, { revenue: number; orders: number }>();
        for (const row of rows) {
          if (range && (row.date < range.from || row.date > range.to)) continue;
          const key = params.groupBy.map((d) => row[d]).join(" / ") || "total";
          const acc = out.get(key) ?? { revenue: 0, orders: 0 };
          acc.revenue += row.revenue;
          acc.orders += row.orders;
          out.set(key, acc);
        }
        return out;
      };
      const current = aggregate(params.period);
      const base = params.baseline ? aggregate(params.baseline) : undefined;
      const totalDelta = base
        ? [...current.values()].reduce((s, v) => s + v.revenue, 0) - [...base.values()].reduce((s, v) => s + v.revenue, 0)
        : 0;
      const lines = [...current.entries()]
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .slice(0, 50)
        .map(([key, v]) => {
          if (!base) return `${key}\trevenue=${v.revenue}\torders=${v.orders}`;
          const before = base.get(key)?.revenue ?? 0;
          const delta = v.revenue - before;
          const pct = before ? ((delta / before) * 100).toFixed(1) : "n/a";
          const contribution = totalDelta ? ((delta / totalDelta) * 100).toFixed(1) : "n/a";
          return `${key}\trevenue=${v.revenue}\tbaseline=${before}\tchange=${pct}%\tcontribution=${contribution}%`;
        });
      return { content: [{ type: "text", text: lines.join("\n") || "no rows" }], details: {} };
    },
  }),
];

export default tools;
