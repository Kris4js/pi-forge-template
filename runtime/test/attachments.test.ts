import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getImageAsset, registerImage } from "../src/image-assets.ts";
import { symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { saveAttachments, validateAttachments } from "../src/attachments.ts";

const text = { name: "notes.txt", mimeType: "text/plain", data: Buffer.from("产品资料").toString("base64") };
const png = { name: "product.png", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S0AAAAASUVORK5CYII=" };

test("attachment validation rejects traversal, disguised files, invalid base64 and size/count overflow", () => {
  assert.equal(validateAttachments(undefined).length, 0);
  assert.equal(validateAttachments([text, png]).length, 2);
  assert.equal(validateAttachments(Array(20).fill(png)).length, 20);
  assert.throws(() => validateAttachments([{ name: "fake.pdf", mimeType: "application/pdf", data: text.data }]));
  assert.throws(() => validateAttachments([{ name: "fake.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: text.data }]));
  for (const files of [
    [{ ...text, name: "../escape.txt" }],
    [{ ...png, data: text.data }],
    [{ ...text, data: "not base64!" }],
    [{ ...text, name: "page.html" }],
    [{ ...text, data: Buffer.from([255]).toString("base64") }],
    [{ ...text, data: Buffer.alloc(100_001, 65).toString("base64") }],
    Array(21).fill(text),
    [{ ...png, data: "A".repeat(68 * 1024 * 1024) }],
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


test("image assets survive reopening and reject wrong sessions and symlink escapes", async () => {
 const home = await mkdtemp(join(tmpdir(), "forge-assets-"));
 const outside = await mkdtemp(join(tmpdir(), "forge-outside-"));
 try {
  const saved = await saveAttachments(home, validateAttachments([png]), "s1");
  const asset = saved.assets[0]!;
  assert.equal((await getImageAsset(home, "s1", asset.id)).data, png.data);
  await assert.rejects(getImageAsset(home, "s2", asset.id), /image not found/);
  await assert.rejects(getImageAsset(home, "s1", "../escape"), /invalid image id/);
  const other = await saveAttachments(outside, validateAttachments([png]), "s1");
  await symlink(join(outside, "attachments"), join(home, "attachments", "escape"));
  const id = randomUUID();
  await registerImage(home, "s1", { ...asset, id }, `escape/${other.assets[0]!.id}.json`);
  await assert.rejects(getImageAsset(home, "s1", id), /image not found/);
 } finally { await rm(home, { recursive:true, force:true }); await rm(outside, { recursive:true, force:true }); }
});
