import { constants } from "node:fs";
import { open, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { RpcError } from "./ipc/peer.ts";
import { ErrorCodes, type ImageAsset } from "./protocol.ts";

const ID = /^[0-9a-f-]{36}$/;
export const IMAGE_ENTRY = "forge.images";

/** Read only registered assets from this user's attachment directory, never arbitrary paths. */
export async function getImageAsset(userHome: string, sessionId: string, id: string) {
  if (!ID.test(id)) throw new RpcError(ErrorCodes.invalidParams, "invalid image id");
  try {
    const home = await realpath(userHome);
    const base = await realpath(join(home, "attachments"));
    if (relative(home, base) !== "attachments") throw new Error("invalid directory");
    const meta = JSON.parse(await readFile(join(base, `${id}.json`), "utf8")) as ImageAsset & { sessionId: string; file: string };
    if (meta.id !== id || meta.sessionId !== sessionId || !["image/png", "image/jpeg", "image/webp"].includes(meta.mimeType)) throw new Error("invalid asset");
    const path = await realpath(join(base, meta.file));
    const rel = relative(base, path);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("invalid path");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("invalid size");
      const data = await handle.readFile();
      return { name: meta.name, mimeType: meta.mimeType, data: data.toString("base64") };
    } finally { await handle.close(); }
  } catch {
    throw new RpcError(ErrorCodes.notFound, "image not found");
  }
}

export async function registerImage(userHome: string, sessionId: string, image: ImageAsset, file: string) {
  await writeFile(join(userHome, "attachments", `${image.id}.json`), JSON.stringify({ ...image, sessionId, file }), { flag: "wx", mode: 0o600 });
}
