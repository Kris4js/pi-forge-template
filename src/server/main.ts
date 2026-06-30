import { createServer } from "node:http";
import { RuntimeManager } from "./runtimes.js";
import { ApiRouter } from "./router.js";
import { HttpError, sendJson, setCorsHeaders } from "./http.js";

// 默认请求路径
const port = Number(process.env.PORT ?? 8090);
const host = process.env.HOST ?? "0.0.0.0";

// 运行时缓存配置
/// 运行时缓存过期时间，单位毫秒
const runtimeIdleTtlMs = Number(process.env.PI_RUNTIME_IDLE_TTL_MS ?? 15 * 60 * 1000);
/// 运行时缓存清理间隔，单位毫秒
const runtimeCleanupIntervalMs = Number(process.env.PI_RUNTIME_CLEANUP_INTERVAL_MS ?? 60 * 1000);

const runtimeManager = new RuntimeManager({ idleTtlMs: runtimeIdleTtlMs });
const apiRouter = new ApiRouter({ runtimeManager });

// 创建 HTTP 服务器
/// 跨域请求处理
/// API 请求分流
const server = createServer(async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `localhost:${port}`}`);

    if (url.pathname.startsWith("/api/")) {
      await apiRouter.handle(req, res, url);
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      sendJson(res, 200, { ok: true, service: "pi-agent-service" });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    sendJson(res, status, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown server error",
    });
  }
});

server.listen(port, host, () => {
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  console.log(`Pi Agent Service API server running at http://${displayHost}:${port}`);
  console.log(`Listening on ${host}:${port}`);
});

const cleanupTimer = setInterval(() => {
  void runtimeManager.cleanupIdleRuntimes();
}, runtimeCleanupIntervalMs);
cleanupTimer.unref?.();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    clearInterval(cleanupTimer);
    await runtimeManager.disposeAllRuntimes();
    process.exit(0);
  });
}
