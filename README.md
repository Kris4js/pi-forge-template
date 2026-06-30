# Pi Agent Service

Reusable Pi-based agent runtime service copied from `wanjiale/bi-pi-agent` and renamed for use as the generic agent service in this repo.

## Install

```bash
npm install
```

## Run API Server

```bash
cp .env.example .env
npm run server
```

Default URL:

```bash
http://localhost:7171
http://localhost:7171/docs
```

## Docker

```bash
docker compose up -d --build pi-agent-service
```

The service stores workspace runtime state under `.workspaces`.

## HTTP API

```bash
GET  /api/state?workspace=demo
POST /api/chat
POST /api/session/new
POST /api/session/select
POST /api/model-config
```

`POST /api/chat` supports SSE by default:

```bash
curl -N -X POST http://localhost:7171/api/chat \
  -H 'content-type: application/json' \
  -d '{"workspace":"demo","prompt":"你好"}'
```

Set `stream=false` for JSON response:

```bash
curl -X POST http://localhost:7171/api/chat \
  -H 'content-type: application/json' \
  -d '{"workspace":"demo","prompt":"你好","stream":false}'
```

## Model Env

```bash
MINIPI_MODEL_PROVIDER=custom
MINIPI_MODEL_PROTOCOL=openai-completions
MINIPI_MODEL_BASE_URL=https://openrouter.ai/api/v1
MINIPI_MODEL_ID=deepseek/deepseek-chat
MINIPI_MODEL_API_KEY=...
```

Provider-specific keys like `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY` are also picked up automatically.
