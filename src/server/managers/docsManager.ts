import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

export class DocsManager {
  private readonly openApiFile = fileURLToPath(new URL("../../../docs/openapi.yaml", import.meta.url));

  async handleOpenApi(res: ServerResponse): Promise<void> {
    const file = await readFile(this.openApiFile);
    res.writeHead(200, {
      "content-type": "text/yaml; charset=utf-8",
      "content-disposition": "inline; filename=\"openapi.yaml\"",
    });
    res.end(file);
  }

  handleDocs(res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pi Agent Service API Docs</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      body {
        margin: 0;
        background: #f7f8fa;
        font-family: "JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }
      .topbar { display: none; }
      .docs-header {
        padding: 18px 32px;
        color: #fff;
        background: linear-gradient(135deg, #111827, #2563eb);
        font-family: "JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }
      .swagger-ui,
      .swagger-ui .info .title,
      .swagger-ui .info p,
      .swagger-ui .opblock,
      .swagger-ui .opblock .opblock-summary-method,
      .swagger-ui .opblock .opblock-summary-path,
      .swagger-ui .opblock .opblock-summary-description,
      .swagger-ui .parameter__name,
      .swagger-ui .parameter__type,
      .swagger-ui table,
      .swagger-ui textarea,
      .swagger-ui input,
      .swagger-ui button,
      .swagger-ui select,
      .swagger-ui code,
      .swagger-ui pre,
      .swagger-ui .microlight {
        font-family: "JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
      }
      .docs-header h1 { margin: 0 0 6px; font-size: 22px; }
      .docs-header p { margin: 0; opacity: 0.86; }
      .docs-header a { color: #bfdbfe; }
      #swagger-ui { max-width: 1280px; margin: 0 auto; }
    </style>
  </head>
  <body>
    <header class="docs-header">
      <h1>MINIPI Runtime HTTP API</h1>
      <p>交互式 OpenAPI 文档。</p>
    </header>
    <main id="swagger-ui"></main>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "/openapi.yaml",
        dom_id: "#swagger-ui",
        deepLinking: true,
        persistAuthorization: true,
        displayRequestDuration: true,
      });
    </script>
  </body>
</html>`);
  }
}
