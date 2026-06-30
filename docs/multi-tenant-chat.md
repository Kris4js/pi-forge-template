# Multi-tenant `/api/chat` implementation notes

## Completed behavior

| Layer | Storage | Visibility |
|---|---|---|
| session | `.workspaces/<workspace>/users/<userId>/sessions` and user `summary.json` | current `sessionId` only |
| user | `.workspaces/<workspace>/users/<userId>/memory.json` | same `workspace + userId` across sessions |
| workspace | `.workspaces/<workspace>/shared/memory.json`, `.workspaces/<workspace>/skills`, `.workspaces/<workspace>/AGENTS.md` | same workspace, shared and stable |

## Tenant identity

`workspace + userId + sessionId` is the runtime identity. Existing clients may omit `userId`; the server falls back to `anonymous`. Set this env var to reject missing `userId`:

```bash
MINIPI_REQUIRE_USER_ID=true
```

## Memory record key

```json
{
  "workspace": "product",
  "userId": "u_123",
  "sessionId": "s_456",
  "visibility": "user",
  "kind": "preference",
  "source": "user",
  "confidence": 0.92,
  "lastUsedAt": 1710000000000
}
```

Memory reads first enforce visibility filters, then rank by keyword/recency/confidence. Cross-user memory is not scored or returned.

## Runtime cache key

```txt
<workspace>:user:<userId>:session:<sessionId>
```

Active non-session runtimes use:

```txt
<workspace>:user:<userId>:active
```

## Migration

Legacy data is not moved destructively. The new layout starts under `users/<userId>`. Old files remain readable only if explicitly migrated. Conservative migration recommendation:

| Legacy path | New path |
|---|---|
| `.workspaces/<workspace>/sessions` | `.workspaces/<workspace>/users/anonymous/sessions` |
| `.workspaces/<workspace>/memory.json` | `.workspaces/<workspace>/users/anonymous/memory.json` |
| `.workspaces/<workspace>/summary.json` | `.workspaces/<workspace>/users/anonymous/summary.json` |

Use `anonymous` only for backward compatibility or historical imports.

## Risks

| Risk | Mitigation |
|---|---|
| spoofed `userId` in body | production should source userId from auth gateway/JWT/header and set `MINIPI_REQUIRE_USER_ID=true` |
| shared memory pollution | normal `memory_save` only permits `session` or `user`; workspace memory should be managed by admin flow |
| temporary context becoming durable memory | summary promotion only stores durable lines and confidence-gates them |
