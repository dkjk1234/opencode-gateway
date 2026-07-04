export const MODELS = {
  fast: {
    id: "fast",
    object: "model",
    owned_by: "yourservice",
    displayName: "Fast",
    family: "yourservice-fast",
    upstream: "openai-compatible",
    upstreamModelEnv: "UPSTREAM_OPENAI_FAST_MODEL",
    inputCreditPer1K: 1,
    outputCreditPer1K: 3,
    contextTokens: 128000,
    defaultOutputTokens: 8192,
    toolCall: true,
    reasoning: false,
  },
  pro: {
    id: "pro",
    object: "model",
    owned_by: "yourservice",
    displayName: "Pro",
    family: "yourservice-pro",
    upstream: "openai-compatible",
    upstreamModelEnv: "UPSTREAM_OPENAI_PRO_MODEL",
    inputCreditPer1K: 3,
    outputCreditPer1K: 9,
    contextTokens: 200000,
    defaultOutputTokens: 16384,
    toolCall: true,
    reasoning: true,
  },
}

export function hasModel(id) {
  return Boolean(MODELS[id])
}

export function getModel(id) {
  return MODELS[id] ?? MODELS.pro
}

export function listModels() {
  return Object.values(MODELS).map((model) => ({
    id: model.id,
    object: model.object,
    owned_by: model.owned_by,
  }))
}

export function providerModelConfig() {
  return Object.fromEntries(
    Object.values(MODELS).map((model) => [
      model.id,
      {
        name: model.displayName,
        family: model.family,
        tool_call: model.toolCall,
        reasoning: model.reasoning,
        status: "active",
        cost: { input: model.inputCreditPer1K / 1000, output: model.outputCreditPer1K / 1000 },
        limit: { context: model.contextTokens, output: model.defaultOutputTokens },
      },
    ]),
  )
}

export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "")
  return Math.max(1, Math.ceil(text.length / 4))
}

export function calculateCredits(model, inputTokens, outputTokens) {
  const input = (inputTokens / 1000) * model.inputCreditPer1K
  const output = (outputTokens / 1000) * model.outputCreditPer1K
  return Math.max(1, Math.ceil(input + output))
}
