# YourService OpenCode Gateway MVP

A tiny dependency-free OpenAI-compatible gateway scaffold for the branded OpenCode Desktop plan.

It is intentionally server-side: user auth, credit accounting, model routing, and upstream provider keys live here, not in the desktop app.

## Endpoints

- `GET /health`
- `POST /auth/device/code` / `POST /auth/device/token` / `POST /auth/device/approve`
- `POST /auth/logout` / `POST /auth/revoke`
- `GET /activate` local development approval page
- `GET /api/user` / `GET /api/orgs` / `GET /api/config` OpenCode console-compatible account/config endpoints
- `GET /v1/models`
- `GET /v1/credits`
- `GET /v1/usage`
- `POST /v1/chat/completions`
- `POST /admin/credits/grant` optional local admin credit grant endpoint, disabled unless `YOURSERVICE_ADMIN_TOKEN` is set

`/v1/chat/completions` supports OpenAI-style non-streaming and SSE streaming responses. By default it uses a deterministic mock model response and a JSON-file-backed development ledger so the desktop/plugin integration can be tested without provider keys. Set `YOURSERVICE_UPSTREAM_MODE=openai` plus the `UPSTREAM_OPENAI_*` variables to forward requests to an OpenAI-compatible upstream while keeping provider keys server-side.

## Quick start

```powershell
cd C:\Users\USER\Documents\GitHub\CodexShare\opencode-gateway
$env:YOURSERVICE_DEV_TOKENS = "dev-token:100000"
node src/server.mjs
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8788/health
```

List models:

```powershell
Invoke-RestMethod http://127.0.0.1:8788/v1/models -Headers @{ Authorization = "Bearer dev-token" }
```

Chat completion:

```powershell
$body = @{
  model = "fast"
  messages = @(@{ role = "user"; content = "hello" })
} | ConvertTo-Json -Depth 8

Invoke-RestMethod http://127.0.0.1:8788/v1/chat/completions `
  -Method POST `
  -Headers @{ Authorization = "Bearer dev-token"; "Content-Type" = "application/json" } `
  -Body $body
```

## Deployable server build

The gateway now includes a container entrypoint and production smoke script so the same server can run on a real host while keeping upstream provider keys off the desktop client.

Build and run locally with Docker:

```powershell
cd C:\Users\USER\Documents\GitHub\CodexShare\opencode-gateway
docker build -t yourservice-opencode-gateway .
docker run --rm -p 8788:8788 `
  -e YOURSERVICE_DEV_TOKENS="dev-token:100000" `
  -e YOURSERVICE_ADMIN_TOKEN="replace-with-local-admin-secret" `
  -e YOURSERVICE_UPSTREAM_MODE="mock" `
  yourservice-opencode-gateway
```

Production-ish smoke test against any deployed URL:

```powershell
.\scripts\prod-smoke.ps1 -BaseUrl "https://your-gateway.example.com" -Token "dev-token"
```

Common real-host environment variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | Platform-injected port. If set, it overrides `YOURSERVICE_GATEWAY_PORT`. |
| `YOURSERVICE_GATEWAY_HOST` | Use `0.0.0.0` in containers/cloud hosts. |
| `YOURSERVICE_PUBLIC_BASE_URL` | Public HTTPS URL used in device auth verification links. |
| `YOURSERVICE_DATA_PATH` | JSON ledger path. Use a mounted volume until the DB adapter replaces it. |
| `YOURSERVICE_DEV_TOKENS` | Temporary token/credit seed list for MVP testing. Replace with real auth-issued accounts later. |
| `YOURSERVICE_ADMIN_TOKEN` | Server-side admin token for manual credit grants. Keep secret. |
| `YOURSERVICE_UPSTREAM_MODE` | `mock` for local validation or `openai` for OpenAI-compatible provider proxying. |
| `UPSTREAM_OPENAI_API_KEY` | Provider key stored only on the server. |
| `UPSTREAM_OPENAI_FAST_MODEL` / `UPSTREAM_OPENAI_PRO_MODEL` | Provider model IDs mapped behind YourService `fast` / `pro`. |

`render.yaml` is included as a first deploy blueprint. After connecting the GitHub repo to Render, set the `sync: false` secrets in the Render dashboard, then run the production smoke script against the issued URL.

## Real upstream proxy mode

Mock mode is the default and is what the smoke test uses. For a real MVP, keep OpenCode pointed at this gateway and let the gateway call the provider:

```powershell
$env:YOURSERVICE_UPSTREAM_MODE = "openai"
$env:UPSTREAM_OPENAI_API_KEY = "sk-..."
$env:UPSTREAM_OPENAI_BASE_URL = "https://api.openai.com/v1"
$env:UPSTREAM_OPENAI_FAST_MODEL = "gpt-4.1-mini"
$env:UPSTREAM_OPENAI_PRO_MODEL = "gpt-4.1"
node src/server.mjs
```

The upstream call is intentionally centralized in `C:\Users\USER\Documents\GitHub\CodexShare\opencode-gateway\src\upstream.mjs`. The desktop app only receives a YourService token; provider API keys stay on the server. In openai mode the gateway reserves credits from the requested max output before sending the provider request, forwards the request as non-streaming, normalizes the response back to YourService model IDs, and debits the actual estimated usage capped by the reservation. Streaming clients still receive SSE from the gateway, but the current MVP streams the completed upstream content rather than doing true provider streaming passthrough.

## MVP hardening now included

The dependency-free gateway is still not a final billing system, but it now includes several production-MVP guardrails:

- bounded request body reads via `YOURSERVICE_MAX_BODY_BYTES`,
- chat request validation before provider spend or credit debit,
- unknown model rejection instead of silently falling back to `pro`,
- per-account serialized chat handling to avoid local JSON-ledger overspend,
- scoped idempotency keys with request-body conflict detection,
- idempotency response TTLs,
- debit guard that refuses negative balances,
- basic in-memory rate limiting via `YOURSERVICE_RATE_LIMIT_PER_MINUTE`,
- refresh-token rotation,
- `/auth/logout` and `/auth/revoke`,
- safer device approval that no longer falls back to `dev-token` unless `YOURSERVICE_ALLOW_DEV_APPROVAL=true` is explicitly set.

## Credit ledger safety

The gateway persists account state to `YOURSERVICE_DATA_PATH` (default `.data/gateway-state.json`). Saves are queued and written through a same-directory temp file before an atomic rename, which avoids partially written JSON if the process exits during a write. Startup token seeding also creates or reconciles a ledger credit row so `/v1/usage` can explain the current balance instead of only showing later debits.

For local operations without an external billing service, an admin can grant credits to an existing dev/API token. The endpoint is disabled unless `YOURSERVICE_ADMIN_TOKEN` is configured, requires a separate admin bearer token, caps each grant with `YOURSERVICE_MAX_CREDIT_GRANT`, and requires an `Idempotency-Key` header so retries do not double-credit an account.

```powershell
$env:YOURSERVICE_ADMIN_TOKEN = "replace-with-local-admin-secret"
node src/server.mjs

$grant = @{
  token = "dev-token"
  credits = 5000
  reason = "manual local top-up"
} | ConvertTo-Json

Invoke-RestMethod http://127.0.0.1:8788/admin/credits/grant `
  -Method POST `
  -Headers @{
    Authorization = "Bearer replace-with-local-admin-secret"
    "Content-Type" = "application/json"
    "Idempotency-Key" = "topup-2026-07-04-dev-token"
  } `
  -Body $grant
```

## OpenCode provider config

For local testing, point OpenCode at this gateway:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "yourservice": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "YourService Local Gateway",
      "options": {
        "baseURL": "http://127.0.0.1:8788/v1"
      },
      "models": {
        "fast": { "name": "Fast" },
        "pro": { "name": "Pro" }
      }
    }
  },
  "model": "yourservice/pro",
  "small_model": "yourservice/fast"
}
```

Store `dev-token` as the provider credential while testing.

## Smoke tests

```powershell
cd C:\Users\USER\Documents\GitHub\CodexShare\opencode-gateway
npm run check
npm run test:upstream
./scripts/smoke-test.ps1
```

The PowerShell smoke test covers health, models, bad device approval rejection, device-code approval, `/api/user`, `/api/orgs`, `/api/config`, admin credit grant idempotency, chat validation failures, request body size limits, chat completions, idempotency replay/conflict behavior, refresh token rotation, logout revocation, and credit debit/ledger rows. `npm run test:upstream` starts a fake local OpenAI-compatible server and verifies that `src/upstream.mjs` forwards requests without requiring a real provider key.

## Next production steps

1. Replace the JSON development state file with a database-backed ledger before multi-process deployment.
2. Add explicit reserve/commit/release rows for true provider streaming and mid-stream failure refunds.
3. Upgrade `src/upstream.mjs` from non-streaming OpenAI-compatible forwarding to true streaming passthrough and provider-specific adapters where needed.
4. Replace the local approval page with real user login.
5. Add durable rate limits, structured audit logs, and billing/webhook integration.
