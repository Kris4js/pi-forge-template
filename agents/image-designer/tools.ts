import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentToolsFactory } from "../../runtime/src/agents/manifest.ts";

const RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4"];

const tools: AgentToolsFactory = (ctx) => [defineTool({
  name: "generate_images",
  label: "生成 / 编辑图片",
  description: "使用用户选定的图片模型生成图片。images 中每一项是一屏/一张独立设计（各自的 prompt、比例和参考图），整组只需一次审批并并行生成；referenceIds 指定本会话已有图片以编辑或组合。付费操作，单次合计最多10张、每轮累计最多30张；更多图片分批调用，失败不要自动重试。",
  parameters: Type.Object({
    images: Type.Array(Type.Object({
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 40, pattern: "^[^/\\\\\\x00-\\x1f]+$", description: "简短文件名，如「首屏」" })),
      prompt: Type.String({ minLength: 1, maxLength: 16000 }),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "同一提示词的备选张数" })),
      aspectRatio: Type.Optional(Type.Union(RATIOS.map((ratio) => Type.Literal(ratio)))),
      referenceIds: Type.Optional(Type.Array(Type.String({ minLength: 36, maxLength: 36 }), { maxItems: 20 })),
    }), { minItems: 1, maxItems: 10 }),
  }),
  async execute(_id, params, signal) {
    if (params.images.reduce((sum, image) => sum + (image.count ?? 1), 0) > 10) throw new Error("单次合计最多 10 张图片；更多请分批调用");
    // Screens are independent paid requests: run them together and keep whatever succeeded.
    const results = await Promise.allSettled(params.images.map(async ({ name, ...image }, index) => {
      const files = await ctx.generateImages(image, signal);
      const stem = `${String(index + 1).padStart(2, "0")}-${name ?? "image"}`;
      return files.map((file, n) => ({ ...file, name: `${stem}${files.length > 1 ? `-${n + 1}` : ""}.${file.name.split(".").at(-1)}` }));
    }));
    signal?.throwIfAborted();
    const failures = results.flatMap((result, index) => result.status === "rejected" ? [`第 ${index + 1} 项失败：${(result.reason as Error).message}`] : []);
    const files = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (!files.length) throw new Error(failures.join("\n"));
    const images = await ctx.publishImages(files);
    const text = [`已生成 ${images.length} 张图片。图片资产 ID：${JSON.stringify(images)}`, ...failures, failures.length ? "失败项未自动重试。" : ""].filter(Boolean).join("\n");
    return { content: [{ type: "text", text }], details: { images } };
  },
})];
export default tools;
