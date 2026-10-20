/*
 * Design tools adapted from vercel-labs/fx0 (lib/tools.ts), Apache-2.0 — see NOTICE.
 * The page lives in the session's artifact store; every successful publish is a new revision that the
 * runtime announces to the console (details.artifact) for the preview panel.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentToolsFactory } from "../../runtime/src/agents/manifest.ts";
import type { PublishResult } from "../../runtime/src/artifacts/store.ts";

const MAX_READ = 64 * 1024;

function published(result: PublishResult) {
  if (!result.ok) throw new Error(result.error);
  const kb = (result.bytes / 1024).toFixed(1);
  return {
    content: [
      {
        type: "text" as const,
        text: result.changed
          ? `Published revision ${result.revision} (${kb} KiB). The preview now shows it.`
          : `No change: the document is identical to revision ${result.revision}.`,
      },
    ],
    details: { artifact: { revision: result.revision, bytes: result.bytes } },
  };
}

const tools: AgentToolsFactory = (ctx) => [
  defineTool({
    name: "read_design",
    label: "Read design",
    description:
      "Read the current design HTML of this conversation. Returns nothing before the first publish. Use only when the exact current text is unknown.",
    parameters: Type.Object({}),
    async execute() {
      const current = await ctx.artifacts.get();
      const text = !current
        ? "No design has been published yet."
        : current.html.length > MAX_READ
          ? `Revision ${current.summary.revision} (truncated to the first ${MAX_READ} characters):\n${current.html.slice(0, MAX_READ)}`
          : `Revision ${current.summary.revision}:\n${current.html}`;
      return { content: [{ type: "text", text }], details: {} };
    },
  }),
  defineTool({
    name: "publish_design",
    label: "Publish design",
    description:
      "Publish one complete self-contained HTML document as the design. Inline CSS and JavaScript, Canvas, animation and event handlers work inside the sandboxed preview. Use once for the first design or for a broad rewrite; keep normal drafts under 12 KiB. It must include doctype, html, head and body; keep scripts inline; use only data: assets, local fragments or <a href=\"https://...\"> links; no HTML comments, external assets, forms, scripted navigation or nested frames. Use edit_design for localized follow-ups.",
    parameters: Type.Object({
      html: Type.String({ description: "The complete self-contained HTML document." }),
    }),
    async execute(_id, params) {
      return published(await ctx.artifacts.publish(params.html));
    },
  }),
  defineTool({
    name: "edit_design",
    label: "Edit design",
    description:
      "Apply one or more exact replacements to the current design and publish once, atomically, as one revision. Put every change a request needs into one call; edits apply in order and each old_string must match exactly once in the document as it stands after the edits before it.",
    parameters: Type.Object({
      edits: Type.Array(
        Type.Object({
          old_string: Type.String({ description: "Exact current HTML, CSS or JavaScript text to replace once." }),
          new_string: Type.String({ description: "Replacement text." }),
        }),
        { minItems: 1, maxItems: 20, description: "Replacements, applied in order." },
      ),
    }),
    async execute(_id, params) {
      return published(await ctx.artifacts.edit(params.edits.map((e) => ({ oldString: e.old_string, newString: e.new_string }))));
    },
  }),
];

export default tools;
