import { createServer } from "node:http";
import { DocsManager } from "./managers/docsManager.js";
import { ProductLeadingAiOverviewManager } from "./managers/productLeadingAiOverviewManager.js";
import { RuntimeManager } from "./managers/runtimeManager.js";
import { ApiRouter } from "./routes/apiRouter.js";
import { HttpError, sendJson, setCorsHeaders } from "./utils/http.js";

// 默认请求路径
const port = Number(process.env.PORT ?? 7171);
const host = process.env.HOST ?? "0.0.0.0";

// 运行时缓存配置
/// 运行时缓存过期时间，单位毫秒
const runtimeIdleTtlMs = Number(process.env.MINIPI_RUNTIME_IDLE_TTL_MS ?? 15 * 60 * 1000);
/// 运行时缓存清理间隔，单位毫秒
const runtimeCleanupIntervalMs = Number(process.env.MINIPI_RUNTIME_CLEANUP_INTERVAL_MS ?? 60 * 1000);

const runtimeManager = new RuntimeManager({ idleTtlMs: runtimeIdleTtlMs });
const docsManager = new DocsManager();
const productLeadingAiOverviewManager = new ProductLeadingAiOverviewManager(runtimeManager);
const apiRouter = new ApiRouter({ runtimeManager, productLeadingAiOverviewManager });

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

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/docs")) {
      docsManager.handleDocs(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/openapi.yaml") {
      await docsManager.handleOpenApi(res);
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
  console.log(`OpenAPI docs: http://${displayHost}:${port}/docs`);
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
