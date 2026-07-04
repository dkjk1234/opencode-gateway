import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { calculateCredits, estimateTokens, getModel, hasModel, listModels, providerModelConfig } from "./models.mjs"
import { GatewayState } from "./state.mjs"
import { boundedOutputTokens, callOpenAICompatibleChat, resolveChatUpstream } from "./upstream.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const host = process.env.YOURSERVICE_GATEWAY_HOST || "127.0.0.1"
const port = Number(process.env.YOURSERVICE_GATEWAY_PORT || 8788)
const publicBaseUrl = (process.env.YOURSERVICE_PUBLIC_BASE_URL || `http://${host}:${port}`).replace(/\/$/, "")
const statePath = process.env.YOURSERVICE_DATA_PATH || path.resolve(__dirname, "..", ".data", "gateway-state.json")
const seedTokens = process.env.YOURSERVICE_DEV_TOKENS || "dev-token:100000"
const allowAnonDev = process.env.YOURSERVICE_ALLOW_ANON_DEV === "true"
const allowDevApproval = process.env.YOURSERVICE_ALLOW_DEV_APPROVAL === "true"
const adminToken = process.env.YOURSERVICE_ADMIN_TOKEN || ""
const maxAdminCreditGrant = positiveIntegerFromEnv(process.env.YOURSERVICE_MAX_CREDIT_GRANT, 1_000_000)
const maxBodyBytes = positiveIntegerFromEnv(process.env.YOURSERVICE_MAX_BODY_BYTES, 1_000_000)
const rateLimitDisabled = process.env.YOURSERVICE_RATE_LIMIT_DISABLED === "true"
const rateLimitPerMinute = positiveIntegerFromEnv(process.env.YOURSERVICE_RATE_LIMIT_PER_MINUTE, 120)

const store = await GatewayState.open(statePath, seedTokens)
const rateLimitBuckets = new Map()
const accountLocks = new Map()

function sendJson(res, status, body, headers = {}) {
  const payload = status === 204 ? "" : JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, idempotency-key, x-org-id",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    ...headers,
  })
  res.end(payload)
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  })
  res.end(html)
}

function sendError(res, status, code, message, extra = {}) {
  sendJson(res, status, {
    error: {
      code,
      message,
      type: "yourservice_gateway_error",
      ...extra,
    },
  })
}

function extractBearer(req) {
  const authorization = req.headers.authorization || ""
  const match = /^Bearer\s+(.+)$/i.exec(authorization)
  return match?.[1]?.trim()
}

function safeTokenEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ""))
  const rightBuffer = Buffer.from(String(right || ""))
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function authenticateAdmin(req) {
  const token = extractBearer(req)
  return Boolean(adminToken && token && safeTokenEquals(token, adminToken))
}

function authenticate(req) {
  const token = extractBearer(req)
  const account = store.authenticate(token)
  if (account) return account
  if (allowAnonDev) return store.authenticate("dev-token")
  return null
}

function checkRateLimit(req, account) {
  if (rateLimitDisabled || !rateLimitPerMinute) return null
  const now = Date.now()
  const windowMs = 60_000
  const key = account ? `${account.userID}:${account.tokenFingerprint || "token"}` : clientAddress(req)
  const bucket = rateLimitBuckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs })
    pruneRateLimitBuckets(now)
    return null
  }
  bucket.count += 1
  if (bucket.count <= rateLimitPerMinute) return null
  return {
    limit: rateLimitPerMinute,
    resetSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  }
}

function clientAddress(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0]?.trim()
  return forwarded || req.socket.remoteAddress || "unknown"
}

function pruneRateLimitBuckets(now) {
  if (rateLimitBuckets.size < 1000) return
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) rateLimitBuckets.delete(key)
  }
}

async function withAccountLock(account, fn) {
  const key = `${account.userID}:${account.orgID}`
  const previous = accountLocks.get(key) || Promise.resolve()
  let release
  const current = new Promise((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => current)
  accountLocks.set(key, tail)
  await previous.catch(() => undefined)
  try {
    return await fn()
  } finally {
    release()
    if (accountLocks.get(key) === tail) accountLocks.delete(key)
  }
}

function normalizeIdempotencyKey(value) {
  const key = String(value || "").trim()
  if (!key) return { key: null }
  if (key.length > 128) return { error: "Idempotency-Key may not exceed 128 characters." }
  return { key }
}

function scopedIdempotencyKey(account, key) {
  if (!key) return null
  return `${account.userID}:${account.orgID}:${key}`
}

function requestFingerprint(body) {
  return createHash("sha256").update(stableJson(body)).digest("hex")
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function positiveIntegerFromEnv(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

async function readBody(req, { maxBytes = maxBodyBytes } = {}) {
  const contentLength = Number(req.headers["content-length"] || 0)
  if (contentLength > maxBytes) throwHttpError(413, "payload_too_large", `Request body may not exceed ${maxBytes} bytes.`)

  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throwHttpError(413, "payload_too_large", `Request body may not exceed ${maxBytes} bytes.`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

async function readJson(req) {
  const text = await readBody(req)
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throwHttpError(400, "invalid_json", "Invalid JSON body")
  }
}

async function readForm(req) {
  const text = await readBody(req)
  return Object.fromEntries(new URLSearchParams(text))
}

function throwHttpError(statusCode, code, message, extra = {}) {
  const err = new Error(message)
  err.statusCode = statusCode
  err.code = code
  Object.assign(err, extra)
  throw err
}

function readErrorCode(error, fallback = "invalid_request") {
  return error?.code || fallback
}

function messagesText(messages) {
  if (!Array.isArray(messages)) return ""
  return messages
    .map((message) => {
      const content = message?.content
      if (Array.isArray(content)) {
        return content.map((part) => part?.text || part?.content || "").join("\n")
      }
      return typeof content === "string" ? content : JSON.stringify(content ?? "")
    })
    .join("\n")
}

function validateChatRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throwHttpError(400, "invalid_request", "Chat completion body must be a JSON object.")
  }
  if (typeof body.model !== "string" || !body.model.trim()) {
    throwHttpError(400, "invalid_model", "model is required and must be a string.")
  }
  if (!hasModel(body.model)) {
    throwHttpError(400, "unknown_model", `Unknown YourService model '${body.model}'.`)
  }
  const model = getModel(body.model)
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throwHttpError(400, "invalid_stream", "stream must be a boolean when provided.")
  }
  validateOutputTokenField(body, "max_tokens", model)
  validateOutputTokenField(body, "max_completion_tokens", model)
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throwHttpError(400, "invalid_messages", "messages must be a non-empty array.")
  }
  for (const [index, message] of body.messages.entries()) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throwHttpError(400, "invalid_messages", `messages[${index}] must be an object.`)
    }
    if (message.role !== undefined && typeof message.role !== "string") {
      throwHttpError(400, "invalid_messages", `messages[${index}].role must be a string when provided.`)
    }
    if (message.content === undefined || message.content === null) {
      throwHttpError(400, "invalid_messages", `messages[${index}].content is required.`)
    }
    if (!isValidMessageContent(message.content)) {
      throwHttpError(400, "invalid_messages", `messages[${index}].content must be a string or an array of text parts.`)
    }
  }
}

function validateOutputTokenField(body, field, model) {
  if (body[field] === undefined) return
  const value = Number(body[field])
  if (!Number.isSafeInteger(value) || value <= 0) {
    throwHttpError(400, "invalid_output_tokens", `${field} must be a positive safe integer.`)
  }
  if (value > model.defaultOutputTokens) {
    throwHttpError(400, "output_limit_exceeded", `${field} may not exceed ${model.defaultOutputTokens} for ${model.id}.`, {
      output_limit: model.defaultOutputTokens,
    })
  }
}

function isValidMessageContent(content) {
  if (typeof content === "string") return true
  if (!Array.isArray(content)) return false
  return content.every((part) => {
    if (typeof part === "string") return true
    if (!part || typeof part !== "object" || Array.isArray(part)) return false
    return part.text === undefined || typeof part.text === "string"
  })
}

function enforceContextLimit(model, inputTokens, outputTokens = 0) {
  const totalTokens = inputTokens + outputTokens
  if (totalTokens <= model.contextTokens) return
  throwHttpError(400, "context_length_exceeded", `Request is ${totalTokens} estimated tokens, above the ${model.contextTokens} token limit for ${model.id}.`, {
    input_tokens: inputTokens,
    reserved_output_tokens: outputTokens,
    context_limit: model.contextTokens,
  })
}

function mockCompletion({ model, messages, requestId }) {
  const prompt = messagesText(messages)
  const preview = prompt.replace(/\s+/g, " ").trim().slice(0, 180) || "empty prompt"
  const modelLabel = model.displayName || model.id
  return `[${modelLabel}] YourService gateway mock response for request ${requestId}. Prompt preview: ${preview}`
}

function createUsage(inputTokens, outputTokens) {
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  }
}

function completionResponse({ requestId, created, model, content, usage, credits, balance, upstreamPayload }) {
  const response = {
    id: requestId,
    object: "chat.completion",
    created,
    model: model.id,
    choices: normalizeChoices({ content, upstreamPayload }),
    usage,
    yourservice: {
      credits_charged: credits,
      credits_remaining: balance,
    },
  }
  if (upstreamPayload?.system_fingerprint) response.system_fingerprint = upstreamPayload.system_fingerprint
  return response
}

function normalizeChoices({ content, upstreamPayload }) {
  if (Array.isArray(upstreamPayload?.choices) && upstreamPayload.choices.length > 0) {
    return upstreamPayload.choices.map((choice, index) => ({
      ...choice,
      index,
      message: choice.message || { role: "assistant", content },
    }))
  }
  return [
    {
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    },
  ]
}

function streamCompletion(res, { requestId, created, model, content, usage, credits }) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-yourservice-request-id": requestId,
    "x-yourservice-credits-charged": String(credits),
    "access-control-allow-origin": "*",
  })

  const words = content.split(/(\s+)/).filter(Boolean)
  for (const word of words) {
    const chunk = {
      id: requestId,
      object: "chat.completion.chunk",
      created,
      model: model.id,
      choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
    }
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }

  res.write(
    `data: ${JSON.stringify({
      id: requestId,
      object: "chat.completion.chunk",
      created,
      model: model.id,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage,
    })}\n\n`,
  )
  res.write("data: [DONE]\n\n")
  res.end()
}

async function handleChatCompletions(req, res, account) {
  let body
  try {
    body = await readJson(req)
  } catch (error) {
    return sendError(res, error.statusCode || 400, readErrorCode(error, "invalid_json"), error.message)
  }

  try {
    validateChatRequest(body)
  } catch (error) {
    return sendError(res, error.statusCode || 400, readErrorCode(error), error.message, {
      input_tokens: error.input_tokens,
      reserved_output_tokens: error.reserved_output_tokens,
      context_limit: error.context_limit,
      output_limit: error.output_limit,
    })
  }

  return withAccountLock(account, () => processChatCompletions(req, res, account, body))
}

async function processChatCompletions(req, res, account, body) {
  const normalizedIdempotency = normalizeIdempotencyKey(req.headers["idempotency-key"])
  if (normalizedIdempotency.error) {
    return sendError(res, 400, "invalid_idempotency_key", normalizedIdempotency.error)
  }
  const idempotencyKey = normalizedIdempotency.key
  const scopedKey = scopedIdempotencyKey(account, idempotencyKey)
  const fingerprint = requestFingerprint(body)
  const existing = store.getRequest(scopedKey)
  if (existing) {
    if (existing.requestFingerprint && existing.requestFingerprint !== fingerprint) {
      return sendError(res, 409, "idempotency_conflict", "Idempotency-Key was already used for a different request body.")
    }
    if (body.stream) return streamCompletion(res, existing.stream)
    return sendJson(res, 200, existing.response, {
      "x-yourservice-request-id": existing.response.id,
      "x-yourservice-idempotent-replay": "true",
      "x-yourservice-credits-charged": "0",
    })
  }

  const requestId = `req_${randomUUID()}`
  const model = getModel(body.model)
  const inputTokens = estimateTokens(messagesText(body.messages))
  const reservedOutputTokens = boundedOutputTokens(body, model)
  try {
    enforceContextLimit(model, inputTokens, reservedOutputTokens)
  } catch (error) {
    return sendError(res, error.statusCode || 400, readErrorCode(error), error.message, {
      input_tokens: error.input_tokens,
      reserved_output_tokens: error.reserved_output_tokens,
      context_limit: error.context_limit,
    })
  }
  const reservedCredits = calculateCredits(model, inputTokens, reservedOutputTokens)

  if (account.user.balance < reservedCredits) {
    return sendError(res, 402, "insufficient_credits", "Not enough credits for this request.", {
      required_credits: reservedCredits,
      current_credits: account.user.balance,
    })
  }

  let generated
  try {
    generated = await createChatCompletion({ body, model, requestId, inputTokens, reservedCredits })
  } catch (error) {
    return sendError(res, error.statusCode || 502, error.code || "upstream_error", error.message, {
      upstream_status: error.upstreamStatus,
    })
  }

  const credits = generated.credits
  const request = {
    requestId,
    idempotencyKey,
    model: model.id,
    upstream: generated.upstream,
    upstreamModel: generated.upstreamModel,
    inputTokens: generated.inputTokens,
    outputTokens: generated.outputTokens,
    credits,
  }
  try {
    store.debit(account, credits, request)
  } catch (error) {
    return sendError(res, error.statusCode || 402, readErrorCode(error, "insufficient_credits"), error.message, {
      required_credits: error.required_credits,
      current_credits: error.current_credits,
    })
  }

  const created = Math.floor(Date.now() / 1000)
  const response = completionResponse({
    requestId,
    created,
    model,
    content: generated.content,
    usage: generated.usage,
    credits,
    balance: account.user.balance,
    upstreamPayload: generated.upstreamPayload,
  })
  const stream = { requestId, created, model, content: generated.content, usage: generated.usage, credits }
  store.putRequest(scopedKey, { response, stream, requestFingerprint: fingerprint })
  await store.save()

  if (body.stream) return streamCompletion(res, stream)

  sendJson(res, 200, response, {
    "x-yourservice-request-id": requestId,
    "x-yourservice-credits-charged": String(credits),
  })
}

async function createChatCompletion({ body, model, requestId, inputTokens, reservedCredits }) {
  const upstream = resolveChatUpstream(model)
  if (upstream.mode === "mock") {
    const content = mockCompletion({ model, messages: body.messages, requestId })
    const outputTokens = estimateTokens(content)
    const usage = createUsage(inputTokens, outputTokens)
    return {
      upstream: "mock",
      upstreamModel: model.upstream,
      content,
      inputTokens,
      outputTokens,
      usage,
      credits: Math.min(reservedCredits, calculateCredits(model, inputTokens, outputTokens)),
    }
  }

  const { payload, content } = await callOpenAICompatibleChat(upstream, body, model, requestId)
  const usage = normalizeUsage(payload.usage, inputTokens, content)
  const outputTokens = usage.completion_tokens
  return {
    upstream: upstream.mode,
    upstreamModel: upstream.model,
    upstreamPayload: payload,
    content,
    inputTokens: usage.prompt_tokens,
    outputTokens,
    usage,
    credits: Math.min(reservedCredits, calculateCredits(model, usage.prompt_tokens, outputTokens)),
  }
}

function normalizeUsage(upstreamUsage, fallbackInputTokens, content) {
  const promptTokens = Number(upstreamUsage?.prompt_tokens)
  const completionTokens = Number(upstreamUsage?.completion_tokens)
  const inputTokens = Number.isSafeInteger(promptTokens) && promptTokens > 0 ? promptTokens : fallbackInputTokens
  const outputTokens =
    Number.isSafeInteger(completionTokens) && completionTokens > 0 ? completionTokens : estimateTokens(content)
  return createUsage(inputTokens, outputTokens)
}

async function handleAdminCreditGrant(req, res) {
  let body
  try {
    body = await readJson(req)
  } catch (error) {
    return sendError(res, error.statusCode || 400, readErrorCode(error, "invalid_json"), error.message)
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return sendError(res, 400, "invalid_json", "Admin credit grant body must be a JSON object.")
  }

  const credits = Number(body.credits ?? body.amount)
  if (!Number.isSafeInteger(credits) || credits <= 0) {
    return sendError(res, 400, "invalid_credit_amount", "credits must be a positive safe integer.")
  }
  if (credits > maxAdminCreditGrant) {
    return sendError(res, 400, "credit_grant_too_large", `credits may not exceed ${maxAdminCreditGrant}.`, {
      max_credits: maxAdminCreditGrant,
    })
  }

  const idempotencyKey = String(req.headers["idempotency-key"] || body.idempotency_key || "").trim()
  if (!idempotencyKey) {
    return sendError(res, 400, "idempotency_key_required", "Admin credit grants require an Idempotency-Key header.")
  }

  const targetToken = typeof body.token === "string" ? body.token.trim() : ""
  const targetUserID = typeof body.user_id === "string" ? body.user_id.trim() : ""
  const account = targetToken ? store.accountForToken(targetToken) : store.accountForUserID(targetUserID)
  if (!account) {
    return sendError(res, 404, "account_not_found", "Grant target not found. Supply an existing token or user_id.")
  }

  const reason = (String(body.reason || "admin credit grant").replace(/\s+/g, " ").trim() || "admin credit grant").slice(
    0,
    280,
  )
  let grant
  try {
    grant = store.grantCredits(account, credits, {
      actor: "admin",
      reason,
      idempotencyKey,
    })
  } catch (error) {
    return sendError(res, error.statusCode || 400, "credit_grant_failed", error.message)
  }

  await store.save()
  return sendJson(
    res,
    grant.replayed ? 200 : 201,
    {
      object: "credit_grant",
      replayed: grant.replayed,
      user_id: account.userID,
      org_id: account.orgID,
      credits: grant.row.amount,
      balance: account.user.balance,
      ledger_id: grant.row.id,
      reason: grant.row.reason,
    },
    {
      "x-yourservice-ledger-id": grant.row.id,
      "x-yourservice-idempotent-replay": String(grant.replayed),
    },
  )
}

function remoteConfig(account) {
  const gatewayUrl = `${publicBaseUrl}/v1`
  return {
    config: {
      enabled_providers: ["yourservice"],
      model: "yourservice/pro",
      small_model: "yourservice/fast",
      provider: {
        yourservice: {
          npm: "@ai-sdk/openai-compatible",
          name: "YourService",
          api: gatewayUrl,
          env: ["OPENCODE_CONSOLE_TOKEN"],
          options: {
            baseURL: gatewayUrl,
            headers: {
              "x-yourservice-org-id": account.orgID,
            },
          },
          models: providerModelConfig(),
        },
      },
    },
  }
}

async function handleDeviceCode(req, res) {
  let body
  try {
    body = await readJson(req)
  } catch (error) {
    return sendError(res, error.statusCode || 400, readErrorCode(error, "invalid_json"), error.message)
  }
  const device = store.createDeviceCode({ clientID: body.client_id || body.client || "opencode-cli" })
  if (process.env.YOURSERVICE_AUTO_APPROVE_DEVICE === "true" && allowDevApproval) {
    store.approveDeviceCode(device.userCode, "dev-token")
  }
  await store.save()
  sendJson(res, 200, {
    device_code: device.deviceCode,
    user_code: device.userCode,
    verification_uri_complete: `/activate?user_code=${encodeURIComponent(device.userCode)}`,
    verification_uri: `${publicBaseUrl}/activate`,
    expires_in: Math.floor((device.expiresAt - Date.now()) / 1000),
    interval: device.interval,
  })
}

async function handleDeviceToken(req, res) {
  let body
  try {
    body = await readJson(req)
  } catch (error) {
    return sendError(res, error.statusCode || 400, readErrorCode(error, "invalid_json"), error.message)
  }

  if (body.grant_type === "refresh_token") {
    const refreshed = store.refresh(body.refresh_token)
    if (!refreshed) return sendJson(res, 200, { error: "invalid_grant", error_description: "Invalid refresh token." })
    await store.save()
    return sendJson(res, 200, refreshed)
  }

  const result = store.pollDeviceCode(body.device_code)
  await store.save()
  return sendJson(res, 200, result)
}

async function handleApprove(req, res, url) {
  const contentType = req.headers["content-type"] || ""
  const body = contentType.includes("application/json") ? await readJson(req) : await readForm(req)
  const userCode = body.user_code || url.searchParams.get("user_code")
  const token = body.token || (allowDevApproval ? "dev-token" : "")
  if (!token) return sendError(res, 401, "approval_token_required", "A valid account token is required to approve this device code.")
  const device = store.approveDeviceCode(userCode, token)
  if (!device) return sendError(res, 404, "device_code_not_found", "Device code not found, expired, denied, or the approval token is invalid.")
  await store.save()
  if (contentType.includes("application/json")) return sendJson(res, 200, { ok: true, user_code: device.userCode })
  return sendHtml(res, 200, `<h1>Approved</h1><p>You can return to OpenCode.</p>`)
}

async function handleLogout(req, res, account) {
  let body = {}
  try {
    body = await readJson(req)
  } catch (error) {
    return sendError(res, error.statusCode || 400, readErrorCode(error, "invalid_json"), error.message)
  }
  const accessToken = extractBearer(req)
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token.trim() : ""
  const revoked = {
    access: store.revokeAccessToken(accessToken),
    refresh: refreshToken ? store.revokeRefreshToken(refreshToken) : false,
  }
  await store.save()
  return sendJson(res, 200, { ok: true, user_id: account.userID, revoked })
}

async function handleTokenRevoke(req, res) {
  let body
  try {
    body = await readJson(req)
  } catch (error) {
    return sendError(res, error.statusCode || 400, readErrorCode(error, "invalid_json"), error.message)
  }
  const account = authenticate(req)
  if (!account && !authenticateAdmin(req)) {
    return sendError(res, 401, "unauthorized", "Missing or invalid bearer token.")
  }
  const token = typeof body.token === "string" ? body.token.trim() : ""
  if (!token) return sendError(res, 400, "token_required", "token is required.")
  const revoked = store.revokeToken(token)
  await store.save()
  return sendJson(res, 200, { ok: true, revoked })
}

function activationPage(url) {
  const userCode = url.searchParams.get("user_code") || ""
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>YourService device login</title></head>
<body style="font-family: system-ui; max-width: 680px; margin: 48px auto; line-height: 1.5;">
<h1>YourService device login</h1>
<p>Approve OpenCode access for code <strong>${escapeHtml(userCode)}</strong>.</p>
<form method="post" action="/activate?user_code=${encodeURIComponent(userCode)}">
  <input type="hidden" name="user_code" value="${escapeHtml(userCode)}" />
  <label>Account token <input name="token" value="" placeholder="dev-token" style="width: 280px" /></label>
  <button type="submit">Approve</button>
</form>
<p style="color:#666">This is a local development approval page. Production should require real login.</p>
</body></html>`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`)

    if (req.method === "OPTIONS") return sendJson(res, 204, {})

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "yourservice-opencode-gateway",
        time: new Date().toISOString(),
        state: statePath,
      })
    }

    if (req.method === "POST" && url.pathname === "/auth/device/code") return handleDeviceCode(req, res)
    if (req.method === "POST" && url.pathname === "/auth/device/token") return handleDeviceToken(req, res)
    if (req.method === "POST" && url.pathname === "/auth/logout") {
      const account = authenticate(req)
      if (!account) return sendError(res, 401, "unauthorized", "Missing or invalid bearer token.")
      return handleLogout(req, res, account)
    }
    if (req.method === "POST" && url.pathname === "/auth/revoke") return handleTokenRevoke(req, res)
    if (req.method === "GET" && url.pathname === "/activate") return sendHtml(res, 200, activationPage(url))
    if (req.method === "POST" && url.pathname === "/activate") return handleApprove(req, res, url)
    if (req.method === "POST" && url.pathname === "/auth/device/approve") return handleApprove(req, res, url)

    if (url.pathname.startsWith("/admin/")) {
      if (!adminToken) return sendError(res, 404, "not_found", "Admin API is disabled.")
      if (!authenticateAdmin(req)) return sendError(res, 401, "unauthorized", "Missing or invalid admin bearer token.")
      if (req.method === "POST" && url.pathname === "/admin/credits/grant") return handleAdminCreditGrant(req, res)
    }

    if (url.pathname === "/api/user" || url.pathname === "/api/orgs" || url.pathname === "/api/config") {
      const account = authenticate(req)
      if (!account) return sendError(res, 401, "unauthorized", "Missing or invalid bearer token.")
      if (req.method === "GET" && url.pathname === "/api/user") {
        return sendJson(res, 200, { id: account.user.id, email: account.user.email })
      }
      if (req.method === "GET" && url.pathname === "/api/orgs") {
        return sendJson(res, 200, [{ id: account.org.id, name: account.org.name }])
      }
      if (req.method === "GET" && url.pathname === "/api/config") {
        return sendJson(res, 200, remoteConfig(account))
      }
    }

    if (url.pathname.startsWith("/v1/")) {
      const account = authenticate(req)
      if (!account) return sendError(res, 401, "unauthorized", "Missing or invalid bearer token.")
      const limited = checkRateLimit(req, account)
      if (limited) {
        return sendError(res, 429, "rate_limited", "Too many requests. Please retry later.", {
          limit: limited.limit,
          reset_seconds: limited.resetSeconds,
        })
      }

      if (req.method === "GET" && url.pathname === "/v1/models") return sendJson(res, 200, { object: "list", data: listModels() })

      if (req.method === "GET" && url.pathname === "/v1/credits") {
        return sendJson(res, 200, {
          object: "credit_balance",
          user_id: account.userID,
          org_id: account.orgID,
          credits: account.user.balance,
        })
      }

      if (req.method === "GET" && url.pathname === "/v1/usage") {
        return sendJson(res, 200, { object: "list", data: store.ledgerFor(account.userID) })
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") return handleChatCompletions(req, res, account)
    }

    sendError(res, 404, "not_found", `No route for ${req.method} ${url.pathname}`)
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      return sendError(res, error.statusCode, readErrorCode(error), error.message)
    }
    console.error(error)
    sendError(res, 500, "internal_error", error?.message || "Internal error")
  }
})

server.listen(port, host, () => {
  console.log(`YourService OpenCode gateway listening on http://${host}:${port}`)
  console.log(`State file: ${statePath}`)
})

