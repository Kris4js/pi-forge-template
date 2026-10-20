import { validateAttachments } from "../attachments.ts";
import type { Attachment } from "../protocol.ts";

export function imageConfig() {
  const models = [...new Set((process.env.PI_IMAGE_MODEL_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean))];
  const defaultModel = process.env.PI_IMAGE_MODEL_ID?.trim() || models[0] || "";
  if (defaultModel && !models.includes(defaultModel)) models.unshift(defaultModel);
  return { models, defaultModel, url: process.env.PI_IMAGE_URL?.trim() || "https://openrouter.ai/api/v1/images", key: process.env.PI_IMAGE_API_KEY?.trim() || "" };
}

export type GenerateImageParams = { prompt: string; count?: number; aspectRatio?: string };

/** OpenRouter's dedicated Image API. Never retry a paid request automatically. */
export async function generateImages(model: string, params: GenerateImageParams, references: Attachment[], signal?: AbortSignal): Promise<Attachment[]> {
  const config = imageConfig();
  if (!config.key) throw new Error("请配置 PI_IMAGE_API_KEY");
  if (!config.models.includes(model)) throw new Error("图片模型未在环境变量中注册");
  if (!params.prompt?.trim() || params.prompt.length > 16000) throw new Error("图片提示词需为 1～16000 字符");
  const count = params.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("单次最多生成 10 张图片；每轮可分批生成最多 30 张");
  if (params.aspectRatio && !["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4"].includes(params.aspectRatio)) throw new Error("不支持的图片比例");
  const url = new URL(config.url);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("图片接口必须使用 HTTPS");
  const timeout = AbortSignal.timeout(240_000);
  const res = await fetch(url, {
    method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: params.prompt, n: count, output_format: "png", stream: false,
      ...(params.aspectRatio ? { aspect_ratio: params.aspectRatio } : {}),
      ...(references.length ? { input_references: references.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } })) } : {}),
    }),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`图片接口返回 HTTP ${res.status}；请检查模型权限、额度及参数。未自动重试。`);
  }
  // Bound streamed body bytes before parsing Base64; upstream Content-Length is not trusted.
  const reader = res.body?.getReader();
  if (!reader) throw new Error("图片接口返回空响应");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64 * 1024 * 1024) throw new Error("图片响应超过 64 MiB，请减少图片数量或分辨率");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  let body: { data?: Array<{ b64_json?: string; media_type?: string }> };
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("图片接口返回无效 JSON"); }
  if (!Array.isArray(body.data) || !body.data.length || body.data.length > count) throw new Error("图片接口未返回有效图片数量");
  return validateAttachments(body.data.map((image, index) => {
    if (typeof image.b64_json !== "string") throw new Error("图片接口未返回 Base64 图片");
    const bytes = Buffer.from(image.b64_json, "base64");
    const detected = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png" : bytes[0] === 255 && bytes[1] === 216 ? "image/jpeg" : bytes.toString("ascii",0,4) === "RIFF" ? "image/webp" : "";
    const mimeType = image.media_type ?? detected;
    if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) throw new Error("仅支持 PNG/JPEG/WebP 图片结果");
    return { name: `generated-${index + 1}.${mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : "webp"}`, mimeType, data: image.b64_json };
  }));
}
