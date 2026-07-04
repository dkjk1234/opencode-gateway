# YourService OpenCode Gateway MVP

A small Node.js OpenAI-compatible gateway scaffold for the branded OpenCode Desktop plan.

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

`/v1/chat/completions` supports OpenAI-style non-streaming and SSE streaming responses. By default it uses a deterministic mock model response and a JSON-file-backed development ledger so the desktop/plugin integration can be tested without provider keys. Set `YOURSERVICE_UPSTREAM_MODE=openai` plus the `UPSTREAM_OPENAI_*` variables to forward requests to an OpenAI-compatible upstream while keeping provider keys server-side. Set `YOURSERVICE_UPSTREAM_MODE=codex-responses` when the upstream is a Codex/OpenAI Responses-compatible `/v1/responses` proxy such as the existing `llms.ai.kr/chatgpt/v1` service.

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
| `YOURSERVICE_BASE_PATH` | Optional path prefix when publishing under a shared domain, e.g. `/opencode-gateway`. |
| `YOURSERVICE_DATA_PATH` | JSON ledger path when `YOURSERVICE_STATE_BACKEND=json`. |
| `YOURSERVICE_STATE_BACKEND` | `json` for local development, `postgres` for deployed persistence. |
| `DATABASE_URL` | PostgreSQL connection string when `YOURSERVICE_STATE_BACKEND=postgres`. |
| `YOURSERVICE_DEV_TOKENS` | Temporary token/credit seed list for MVP testing. Replace with real auth-issued accounts later. |
| `YOURSERVICE_ADMIN_TOKEN` | Server-side admin token for manual credit grants. Keep secret. |
| `YOURSERVICE_UPSTREAM_MODE` | `mock` for local validation, `openai` for `/chat/completions`, or `codex-responses` for a streaming `/responses` upstream. |
| `UPSTREAM_OPENAI_API_KEY` | Provider key stored only on the server. |
| `UPSTREAM_OPENAI_FAST_MODEL` / `UPSTREAM_OPENAI_PRO_MODEL` | Provider model IDs mapped behind YourService `fast` / `pro`. |

`render.yaml` is included as a first deploy blueprint. After connecting the GitHub repo to Render, set the `sync: false` secrets in the Render dashboard, then run the production smoke script against the issued URL.

`vercel.json` and `api/gateway.mjs` are also included for preview deployments through Vercel's Node serverless runtime. Vercel is useful for quick HTTPS smoke tests, but production credit accounting should still use `YOURSERVICE_STATE_BACKEND=postgres`; otherwise the serverless `/tmp` JSON file is only warm-instance local state.

## Production auth, billing, and DB integration

The gateway now has real integration seams for the three server-side systems the desktop app should never own directly:

- OAuth/OIDC device approval: when `YOURSERVICE_OAUTH_CLIENT_ID` plus either `YOURSERVICE_OAUTH_ISSUER` or explicit endpoint URLs are configured, `/activate` shows a `Continue with OAuth login` link. The callback upserts the external identity, creates/updates the user/org, approves the OpenCode device code, and lets OpenCode poll `/auth/device/token` for a YourService token.
- Stripe credit webhooks: `POST /webhooks/stripe` verifies the Stripe `v1` webhook signature with `YOURSERVICE_STRIPE_WEBHOOK_SECRET`, idempotently records the event, and credits the target account when supported events include metadata such as `yourservice_user_id` or `yourservice_token` plus `yourservice_credits`.
- PostgreSQL state backend: set `YOURSERVICE_STATE_BACKEND=postgres` plus `DATABASE_URL` to persist the gateway state in the `gateway_state` JSONB snapshot table. `C:\Users\USER\Documents\GitHub\CodexShare\opencode-gateway\schema\postgres.sql` also defines the target normalized durable tables for users, orgs, identities, tokens, device codes, OAuth states, idempotency keys, billing events, and the credit ledger.

Example Postgres env:

```powershell
$env:YOURSERVICE_STATE_BACKEND = "postgres"
$env:DATABASE_URL = "postgres://yourservice_gateway:...@host:5432/yourservice_opencode_gateway"
$env:YOURSERVICE_POSTGRES_AUTO_MIGRATE = "true"
node src/server.mjs
```

Example OAuth/OIDC env:

```powershell
$env:YOURSERVICE_PUBLIC_BASE_URL = "https://your-gateway.example.com"
$env:YOURSERVICE_OAUTH_ISSUER = "https://accounts.example.com"
$env:YOURSERVICE_OAUTH_CLIENT_ID = "..."
$env:YOURSERVICE_OAUTH_CLIENT_SECRET = "..."
$env:YOURSERVICE_OAUTH_REDIRECT_URI = "https://your-gateway.example.com/auth/oauth/callback"
```

Example Stripe Checkout metadata to grant credits:

```json
{
  "yourservice_user_id": "usr_...",
  "yourservice_credits": "5000",
  "reason": "starter pack"
}
```

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

For a Codex-native Responses proxy such as the existing VPS `llms.ai.kr/chatgpt/v1` service:

```powershell
$env:YOURSERVICE_UPSTREAM_MODE = "codex-responses"
$env:UPSTREAM_OPENAI_BASE_URL = "https://llms.ai.kr/chatgpt/v1"
$env:UPSTREAM_OPENAI_API_KEY = "dummy"
$env:UPSTREAM_OPENAI_FAST_MODEL = "gpt-5.3-codex-spark"
$env:UPSTREAM_OPENAI_PRO_MODEL = "gpt-5.5"
node src/server.mjs
```

The upstream call is intentionally centralized in `C:\Users\USER\Documents\GitHub\CodexShare\opencode-gateway\src\upstream.mjs`. The desktop app only receives a YourService token; provider API keys stay on the server. In `openai` mode the gateway reserves credits from the requested max output before sending the provider request, forwards the request as non-streaming, normalizes the response back to YourService model IDs, and debits the actual estimated usage capped by the reservation. In `codex-responses` mode the gateway converts Chat Completions messages into Responses input items, consumes the upstream SSE stream server-side, normalizes it back to Chat Completions, then applies the same credit debit path. Streaming clients still receive SSE from the gateway, but the current MVP streams the completed upstream content rather than doing true provider streaming passthrough.

## MVP hardening now included

The gateway is still not a final billing system, but it now includes several production-MVP guardrails:

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

By default the gateway persists account state to `YOURSERVICE_DATA_PATH` (default `.data/gateway-state.json`). Saves are queued and written through a same-directory temp file before an atomic rename, which avoids partially written JSON if the process exits during a write. For deployed services, set `YOURSERVICE_STATE_BACKEND=postgres` and `DATABASE_URL`; the server auto-creates the `gateway_state` table unless `YOURSERVICE_POSTGRES_AUTO_MIGRATE=false`. Startup token seeding also creates or reconciles a ledger credit row so `/v1/usage` can explain the current balance instead of only showing later debits.

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

To verify the actual OpenCode account path against this gateway, run the E2E harness with a local OpenCode checkout:

```powershell
.\scripts\opencode-account-e2e.ps1 `
  -OpenCodeRepo "C:\Users\USER\AppData\Local\Temp\opencode-service-design"
```

That harness starts a temporary gateway, runs `opencode console login` through the device-code flow with auto-approval enabled for the throwaway process, verifies `console orgs`, verifies that `debug config` merged the remote YourService provider config, and finally runs `opencode run --model yourservice/fast` against the mock gateway. It uses isolated `XDG_*`, `OPENCODE_TEST_HOME`, and `OPENCODE_DB` paths under `%TEMP%` so it does not touch the user's real OpenCode credentials.

## Next production steps

1. Replace the Postgres JSONB snapshot backend with row-level writes to the normalized tables in `schema/postgres.sql` before high-concurrency multi-instance deployment.
2. Add explicit reserve/commit/release rows for true provider streaming and mid-stream failure refunds.
3. Upgrade `src/upstream.mjs` from gateway-buffered upstream calls to true streaming passthrough and add more provider-specific adapters where needed.
4. Replace the local approval page with real user login.
5. Add durable rate limits, structured audit logs, and billing/webhook integration.
