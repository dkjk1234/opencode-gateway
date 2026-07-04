const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
const DEFAULT_TIMEOUT_MS = 120_000

export class UpstreamConfigurationError extends Error {
  constructor(message) {
    super(message)
    this.name = "UpstreamConfigurationError"
    this.statusCode = 500
    this.code = "upstream_configuration_error"
  }
}

export class UpstreamRequestError extends Error {
  constructor(message, { status, payload } = {}) {
    super(message)
    this.name = "UpstreamRequestError"
    this.statusCode = 502
    this.code = "upstream_request_failed"
    this.upstreamStatus = status
    this.payload = payload
  }
}

export function upstreamMode() {
  return String(process.env.YOURSERVICE_UPSTREAM_MODE || (process.env.UPSTREAM_OPENAI_API_KEY ? "openai" : "mock"))
    .trim()
    .toLowerCase()
}

export function resolveChatUpstream(model) {
  const mode = upstreamMode()
  if (!mode || mode === "mock") return { mode: "mock" }
  if (mode !== "openai" && mode !== "openai-compatible") {
    throw new UpstreamConfigurationError(
      `Unsupported YOURSERVICE_UPSTREAM_MODE '${mode}'. Use 'mock' or 'openai'.`,
    )
  }

  const apiKey = process.env.UPSTREAM_OPENAI_API_KEY?.trim()
  if (!apiKey) throw new UpstreamConfigurationError("UPSTREAM_OPENAI_API_KEY is required when upstream mode is openai.")

  const upstreamModel = process.env[model.upstreamModelEnv]?.trim() || process.env.UPSTREAM_OPENAI_MODEL?.trim()
  if (!upstreamModel) {
    throw new UpstreamConfigurationError(
      `${model.upstreamModelEnv} or UPSTREAM_OPENAI_MODEL is required for YourService model '${model.id}'.`,
    )
  }

  return {
    mode: "openai",
    baseURL: trimTrailingSlashes(process.env.UPSTREAM_OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL),
    apiKey,
    organization: process.env.UPSTREAM_OPENAI_ORG_ID?.trim() || undefined,
    project: process.env.UPSTREAM_OPENAI_PROJECT_ID?.trim() || undefined,
    model: upstreamModel,
    timeoutMs: positiveInteger(process.env.UPSTREAM_OPENAI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  }
}

export function boundedOutputTokens(body, model) {
  const configured = Number(body?.max_completion_tokens ?? body?.max_tokens ?? model.defaultOutputTokens ?? 8192)
  if (!Number.isSafeInteger(configured) || configured <= 0) return model.defaultOutputTokens ?? 8192
  return Math.min(configured, model.defaultOutputTokens ?? configured)
}

export async function callOpenAICompatibleChat(upstream, body, model, requestId) {
  const endpoint = `${upstream.baseURL}/chat/completions`
  const upstreamBody = normalizeUpstreamBody(body, upstream, model)
  const headers = {
    authorization: `Bearer ${upstream.apiKey}`,
    "content-type": "application/json",
    "x-yourservice-request-id": requestId,
  }
  if (upstream.organization) headers["openai-organization"] = upstream.organization
  if (upstream.project) headers["openai-project"] = upstream.project

  let response
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(upstream.timeoutMs),
    })
  } catch (error) {
    throw new UpstreamRequestError(`Failed to reach upstream provider: ${error.message}`)
  }

  const text = await response.text()
  const payload = parseJsonPayload(text)
  if (!response.ok) {
    throw new UpstreamRequestError(upstreamErrorMessage(payload, response.status), {
      status: response.status,
      payload: sanitizeUpstreamPayload(payload),
    })
  }
  if (!payload || typeof payload !== "object") {
    throw new UpstreamRequestError("Upstream provider returned a non-JSON chat completion response.", {
      status: response.status,
      payload: text.slice(0, 500),
    })
  }

  return {
    payload,
    content: extractAssistantContent(payload),
  }
}

function normalizeUpstreamBody(body, upstream, model) {
  const next = { ...(body || {}) }
  next.model = upstream.model
  next.stream = false
  delete next.stream_options

  if (next.max_tokens === undefined && next.max_completion_tokens === undefined) {
    next.max_tokens = boundedOutputTokens(next, model)
  }

  return next
}

function extractAssistantContent(payload) {
  const content = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.delta?.content ?? ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        return part?.text || part?.content || ""
      })
      .join("")
  }
  return JSON.stringify(content ?? "")
}

function parseJsonPayload(text) {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function upstreamErrorMessage(payload, status) {
  if (payload?.error?.message) return `Upstream provider error (${status}): ${payload.error.message}`
  if (typeof payload === "string" && payload.trim()) return `Upstream provider error (${status}): ${payload.slice(0, 240)}`
  return `Upstream provider error (${status}).`
}

function sanitizeUpstreamPayload(payload) {
  if (!payload || typeof payload !== "object") return payload
  const clone = structuredClone(payload)
  if (clone.request?.headers?.authorization) clone.request.headers.authorization = "[redacted]"
  return clone
}

function trimTrailingSlashes(value) {
  return String(value || "").replace(/\/+$/, "")
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}
