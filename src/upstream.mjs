const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
const DEFAULT_TIMEOUT_MS = 120_000
const TEXT_DECODER = new TextDecoder()

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
  if (mode === "codex" || mode === "codex-responses" || mode === "responses" || mode === "openai-responses") {
    const upstreamModel = process.env[model.upstreamModelEnv]?.trim() || process.env.UPSTREAM_OPENAI_MODEL?.trim()
    if (!upstreamModel) {
      throw new UpstreamConfigurationError(
        `${model.upstreamModelEnv} or UPSTREAM_OPENAI_MODEL is required for YourService model '${model.id}'.`,
      )
    }

    return {
      mode: "responses",
      baseURL: trimTrailingSlashes(process.env.UPSTREAM_OPENAI_BASE_URL || process.env.UPSTREAM_RESPONSES_BASE_URL || DEFAULT_OPENAI_BASE_URL),
      apiKey: process.env.UPSTREAM_OPENAI_API_KEY?.trim() || process.env.UPSTREAM_RESPONSES_API_KEY?.trim() || "dummy",
      model: upstreamModel,
      timeoutMs: positiveInteger(process.env.UPSTREAM_OPENAI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    }
  }

  if (mode !== "openai" && mode !== "openai-compatible") {
    throw new UpstreamConfigurationError(
      `Unsupported YOURSERVICE_UPSTREAM_MODE '${mode}'. Use 'mock', 'openai', or 'codex-responses'.`,
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
  if (upstream.mode === "responses") return callResponsesCompatibleChat(upstream, body, model, requestId)

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

async function callResponsesCompatibleChat(upstream, body, model, requestId) {
  const endpoint = `${upstream.baseURL}/responses`
  const upstreamBody = normalizeResponsesBody(body, upstream)
  const headers = {
    authorization: `Bearer ${upstream.apiKey}`,
    accept: "text/event-stream",
    "content-type": "application/json",
    "x-yourservice-request-id": requestId,
  }

  let response
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(upstream.timeoutMs),
    })
  } catch (error) {
    throw new UpstreamRequestError(`Failed to reach responses upstream provider: ${error.message}`)
  }

  if (!response.ok) {
    const text = await response.text()
    const payload = parseJsonPayload(text)
    throw new UpstreamRequestError(upstreamErrorMessage(payload, response.status), {
      status: response.status,
      payload: sanitizeUpstreamPayload(payload),
    })
  }

  const { content, finalResponse, events } = await readResponsesEventStream(response)
  const usage = normalizeResponsesUsage(finalResponse?.usage, body, content)
  const payload = {
    id: finalResponse?.id || requestId,
    object: "chat.completion",
    model: finalResponse?.model || upstream.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finalResponse?.incomplete_details ? "length" : "stop",
      },
    ],
    usage,
    upstream_response: {
      id: finalResponse?.id,
      status: finalResponse?.status,
      object: finalResponse?.object,
      events,
    },
  }

  return { payload, content }
}

function normalizeResponsesBody(body, upstream) {
  return {
    model: upstream.model,
    input: chatMessagesToResponsesInput(body?.messages || []),
    stream: true,
    store: false,
  }
}

function chatMessagesToResponsesInput(messages) {
  const normalized = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = normalizeResponsesRole(message?.role)
    const content = chatContentToResponsesContent(message?.content, role)
    if (content.length > 0) normalized.push({ role, content })
  }
  if (normalized.length === 0) {
    normalized.push({ role: "user", content: [{ type: "input_text", text: "" }] })
  }
  return normalized
}

function normalizeResponsesRole(role) {
  if (role === "assistant") return "assistant"
  return "user"
}

function chatContentToResponsesContent(content, role) {
  const type = role === "assistant" ? "output_text" : "input_text"
  if (typeof content === "string") return content ? [{ type, text: content }] : []
  if (!Array.isArray(content)) return content == null ? [] : [{ type, text: String(content) }]
  return content
    .map((part) => {
      if (typeof part === "string") return { type, text: part }
      if (part?.type === "text" && typeof part.text === "string") return { type, text: part.text }
      if (part?.type === "input_text" && typeof part.text === "string") return { type: "input_text", text: part.text }
      if (part?.type === "output_text" && typeof part.text === "string") return { type: "output_text", text: part.text }
      if (typeof part?.text === "string") return { type, text: part.text }
      if (typeof part?.content === "string") return { type, text: part.content }
      return null
    })
    .filter(Boolean)
}

async function readResponsesEventStream(response) {
  if (!response.body) {
    throw new UpstreamRequestError("Responses upstream returned an empty stream.", { status: response.status })
  }

  const reader = response.body.getReader()
  let buffer = ""
  const deltas = []
  let doneText = ""
  let finalResponse = null
  const events = []

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += TEXT_DECODER.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ""
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : ""
      if (!data || data === "[DONE]") continue
      const event = parseJsonPayload(data)
      if (!event || typeof event !== "object") continue
      if (event.type) events.push(event.type)
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") deltas.push(event.delta)
      if (event.type === "response.output_text.done" && typeof event.text === "string") doneText = event.text
      if (event.type === "response.error" || event.type === "error") {
        throw new UpstreamRequestError(event?.error?.message || event?.message || "Responses upstream returned an error.", {
          payload: sanitizeUpstreamPayload(event),
        })
      }
      if (event.response && typeof event.response === "object") finalResponse = event.response
    }
  }

  if (buffer.trim().startsWith("data:")) {
    const event = parseJsonPayload(buffer.trim().slice(5).trim())
    if (event?.response && typeof event.response === "object") finalResponse = event.response
  }

  const content = deltas.join("") || doneText || extractResponsesText(finalResponse)
  return { content, finalResponse, events: [...new Set(events)] }
}

function extractResponsesText(response) {
  const chunks = []
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (typeof part?.text === "string") chunks.push(part.text)
      else if (typeof part?.content === "string") chunks.push(part.content)
    }
  }
  return chunks.join("")
}

function normalizeResponsesUsage(usage, body, content) {
  const promptTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens)
  const completionTokens = Number(usage?.completion_tokens ?? usage?.output_tokens)
  const input = Number.isSafeInteger(promptTokens) && promptTokens > 0 ? promptTokens : estimateFallbackTokens(body?.messages || "")
  const output = Number.isSafeInteger(completionTokens) && completionTokens > 0 ? completionTokens : estimateFallbackTokens(content)
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
  }
}

function estimateFallbackTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "")
  return Math.max(1, Math.ceil(text.length / 4))
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
