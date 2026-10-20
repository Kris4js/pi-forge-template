import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { generateImages } from "../src/model/images.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S0AAAAASUVORK5CYII=";
test("OpenRouter image protocol: generation, references, model allowlist, errors and cancellation", async () => {
  const old = { ...process.env };
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    assert.equal(req.headers.authorization, "Bearer fake-image-key");
    if (body.prompt === "error") { res.writeHead(429).end("secret-provider-error"); return; }
    if (body.prompt === "bad") { res.end(JSON.stringify({ data: [{ b64_json: "invalid" }] })); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ b64_json: png, media_type: "image/png" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address() as { port: number };
    process.env.PI_IMAGE_URL = `http://127.0.0.1:${addr.port}/api/v1/images`;
    process.env.PI_IMAGE_API_KEY = "fake-image-key";
    process.env.PI_IMAGE_MODEL_ID = "test/image";
    const result = await generateImages("test/image", { prompt: "cup", aspectRatio: "3:4" }, []);
    assert.equal(result[0]!.data, png);
    assert.equal(requests[0].aspect_ratio, "3:4");
    assert.equal(requests[0].stream, false);
    await generateImages("test/image", { prompt: "edit" }, result);
    assert.equal(requests[1].input_references[0].image_url.url, `data:image/png;base64,${png}`);
    await assert.rejects(generateImages("unregistered", { prompt: "cup" }, []), /未在环境变量/);
    const before = requests.length;
    await assert.rejects(generateImages("test/image", { prompt: "error" }, []), /HTTP 429/);
    assert.equal(requests.length, before + 1);
    await assert.rejects(generateImages("test/image", { prompt: "bad" }, []));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(generateImages("test/image", { prompt: "cancel" }, [], controller.signal));
  } finally {
    for (const key of ["PI_IMAGE_URL", "PI_IMAGE_API_KEY", "PI_IMAGE_MODEL_ID"]) {
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
