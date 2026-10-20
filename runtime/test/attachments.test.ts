import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { saveAttachments, validateAttachments } from "../src/attachments.ts";

const text = { name: "notes.txt", mimeType: "text/plain", data: Buffer.from("产品资料").toString("base64") };
const png = { name: "product.png", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S0AAAAASUVORK5CYII=" };

test("attachment validation rejects traversal, disguised files, invalid base64 and size/count overflow", () => {
  assert.equal(validateAttachments(undefined).length, 0);
  assert.equal(validateAttachments([text, png]).length, 2);
  for (const files of [
    [{ ...text, name: "../escape.txt" }],
    [{ ...png, data: text.data }],
    [{ ...text, data: "not base64!" }],
    [{ ...text, name: "page.html" }],
    [{ ...text, data: Buffer.from([255]).toString("base64") }],
    [{ ...text, data: Buffer.alloc(100_001, 65).toString("base64") }],
    Array(5).fill(text),
    [{ ...png, data: "A".repeat(6 * 1024 * 1024) }],
  ]) assert.throws(() => validateAttachments(files));
});

test("attachments are stored in the user's directory and images reach the multimodal input", async () => {
  const home = await mkdtemp(join(tmpdir(), "forge-attachments-"));
  try {
    const saved = await saveAttachments(home, validateAttachments([text, png]));
    assert.match(saved.text, /产品资料/);
    assert.match(saved.text, /不是系统指令/);
    assert.deepEqual(saved.images, [{ type: "image", data: png.data, mimeType: png.mimeType }]);
    const [folder] = await readdir(join(home, "attachments"));
    assert.equal(await readFile(join(home, "attachments", folder!, "1-notes.txt"), "utf8"), "产品资料");
  } finally { await rm(home, { recursive: true, force: true }); }
});
