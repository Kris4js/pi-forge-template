# Pi Agent Service

Reusable Pi-based agent runtime service for use as the generic agent service.

## Install

```bash
npm install
```

This service depends on the maintained `@earendil-works/pi-coding-agent` package.

## Run API Server

```bash
cp .env.example .env
npm run server
```

Default URL:

```bash
http://localhost:8090
```

## Docker

```bash
docker compose up -d --build pi-agent-service
```

The service stores workspace runtime state under `.workspaces`.

## API

```bash
GET  /api/state?workspace=demo
POST /api/chat
POST /api/session/new
POST /api/session/select
```

`POST /api/chat` supports SSE by default:

```bash
curl -N -X POST http://localhost:8090/api/chat \
  -H 'content-type: application/json' \
  -d '{"workspace":"demo","prompt":"你好"}'
```

Set `stream=false` for JSON response:

```bash
curl -X POST http://localhost:8090/api/chat \
  -H 'content-type: application/json' \
  -d '{"workspace":"demo","prompt":"你好","stream":false}'
```

## Model Env

```bash
PI_MODEL_PROVIDER=custom
PI_MODEL_PROTOCOL=openai-completions
PI_MODEL_BASE_URL=https://openrouter.ai/api/v1
PI_MODEL_ID=deepseek/deepseek-chat
PI_MODEL_API_KEY=...
```

Provider-specific keys like `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY` are also picked up automatically.

The service reads `.env` from the project root by default, so runtime workspace directory changes do not hide model credentials.
