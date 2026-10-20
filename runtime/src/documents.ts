import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("../../packages/documents/parse.py", import.meta.url));
const localPython = fileURLToPath(new URL("../../.venv/bin/python", import.meta.url));

/** One bounded, isolated conversion at a time per process; no shell or inherited API keys. */
let busy = false;
export async function parseDocument(path: string, timeoutMs = 20_000): Promise<string> {
  if (busy) throw new Error("文档解析正忙，请稍后重试");
  busy = true;
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(process.env.FORGE_DOCUMENT_PYTHON || (existsSync(localPython) ? localPython : "python3"), [worker, path], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", PYTHONIOENCODING: "utf-8", OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let output = "";
      let failure: Error | undefined;
      const fail = (message: string) => { failure ??= new Error(message); child.kill("SIGKILL"); };
      const timer = setTimeout(() => fail("文档解析超时，请拆分文件"), timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (Buffer.byteLength(output) > 1024 * 1024) fail("文档解析输出过大，请拆分文件");
      });
      child.on("error", () => { clearTimeout(timer); reject(new Error("无法启动文档解析器，请安装 Python 文档依赖")); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failure) return reject(failure);
        try {
          const result = JSON.parse(output) as { text?: string; error?: string };
          if (code !== 0 || result.error || typeof result.text !== "string") return reject(new Error(result.error || "文档解析失败，请检查 Python 依赖"));
          resolve(result.text);
        } catch { reject(new Error("文档解析失败，请检查 Python 依赖或文件内容")); }
      });
    });
  } finally { busy = false; }
}
