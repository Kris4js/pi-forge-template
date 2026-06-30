# Multi-tenant Memory Verification

This document captures manual verification commands for `/api/chat` tenant isolation.

## Start server

```bash
npm run server
```

## Backward-compatible anonymous user

```bash
curl -s -X POST http://localhost:7171/api/chat \
  -H 'content-type: application/json' \
  -d '{"workspace":"demo","prompt":"你好","stream":false}'
```

Expected: response contains `output.userId = "anonymous"`.

## Strict userId requirement

```bash
MINIPI_REQUIRE_USER_ID=true npm run server
curl -i -X POST http://localhost:7171/api/chat \
  -H 'content-type: application/json' \
  -d '{"workspace":"demo","prompt":"你好","stream":false}'
```

Expected: `400` with `Missing required userId`.

## Cross-user session isolation

```bash
ALICE_SESSION=$(curl -s -X POST http://localhost:7171/api/session/new \
  -H 'content-type: application/json' \
  -d '{"workspace":"demo","userId":"alice"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).sessionId))')

curl -s -X POST http://localhost:7171/api/session/select \
  -H 'content-type: application/json' \
  -d "{\"workspace\":\"demo\",\"userId\":\"bob\",\"sessionId\":\"$ALICE_SESSION\"}"
```

Expected: Bob cannot select Alice's session because sessions live under `users/<userId>/sessions`.

## User memory across sessions

```bash
curl -s -X POST http://localhost:7171/api/chat \
  -H 'content-type: application/json' \
  -d '{"workspace":"demo","userId":"alice","prompt":"请记住我偏好中文回答","stream":false}'

curl -s -X POST http://localhost:7171/api/chat \
  -H 'content-type: application/json' \
  -d '{"workspace":"demo","userId":"alice","prompt":"我的回答偏好是什么？","stream":false}'
```

Expected: Alice can use her own user memory. Bob should not see it.
