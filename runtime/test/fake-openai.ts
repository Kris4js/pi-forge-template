import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Test double for an OpenAI-compatible /chat/completions endpoint (streaming only). The runtime talks
 * to it through the normal custom-provider path, so tests exercise the real model plumbing.
 *
 * Script: a user message `!tool {json}` yields a call to that tool; a turn ending in tool results
 * yields a text summary of them; anything else is echoed back.
 */
type ChatMessage = { role: string; content?: unknown; tool_call_id?: string; name?: string };

export async function startFakeOpenAI(options: { chunkDelayMs?: number; onRequest?: (body: { model: string; messages: ChatMessage[] }) => void } = {}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const pause = () => (options.chunkDelayMs ? new Promise((r) => setTimeout(r, options.chunkDelayMs)) : undefined);
  let calls = 0;
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/images") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => { const body = JSON.parse(raw); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: Array.from({ length: body.n ?? 1 }, () => ({ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S0AAAAASUVORK5CYII=", media_type: "image/png" })) })); });
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      const body = JSON.parse(raw) as { model: string; messages: ChatMessage[] };
      options.onRequest?.(body);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const id = `chatcmpl-${++calls}`;
      const chunk = (delta: unknown, finish: string | null = null, extra: object = {}) =>
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`,
        );
      const usage = { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 };

      const reply = respond(body.messages);
      if (reply.tool) {
        chunk({
          role: "assistant",
          tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: reply.tool.name, arguments: "" } }],
        });
        // Arguments arrive in pieces, as from a real model, so incremental parsing is exercised.
        for (const piece of JSON.stringify(reply.tool.args).match(/[\s\S]{1,40}/g) ?? []) {
          chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] });
          await pause();
        }
        chunk({}, "tool_calls");
      } else {
        chunk({ role: "assistant", content: "" });
        for (const piece of reply.text!.match(/.{1,8}/gsu) ?? []) chunk({ content: piece });
        chunk({}, "stop");
      }
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function respond(messages: ChatMessage[]): { text?: string; tool?: { name: string; args: unknown } } {
  const budgetStart = messages.findLastIndex((m) => m.role === "user" && text(m.content).includes("!image-budget"));
  if (budgetStart >= 0 && messages.slice(budgetStart).filter((m) => m.role === "tool").length < 4) {
    return { tool: { name: "generate_images", args: { images: [{ prompt: "budget test", count: 10 }] } } };
  }
  const last = messages.at(-1);
  if (last?.role === "tool") {
    const results = messages
      .slice(messages.findLastIndex((m) => m.role !== "tool") + 1)
      .map((m) => text(m.content))
      .join("\n");
    return { text: `工具已返回：${results}` };
  }
  const prompt = last?.role === "user" ? text(last.content).trim() : "";
  const command = /^!([a-zA-Z0-9_-]+)\s*(\{[\s\S]*\})?$/.exec(prompt);
  if (command) return { tool: { name: command[1]!, args: command[2] ? JSON.parse(command[2]) : {} } };
  return { text: `收到：${prompt}` };
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p: { text?: string }) => p.text ?? "").join("");
  return "";
}
