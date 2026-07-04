import http from "node:http"
import assert from "node:assert/strict"
import { getModel } from "../src/models.mjs"
import { callOpenAICompatibleChat, resolveChatUpstream } from "../src/upstream.mjs"

const fakeUpstream = http.createServer(async (req, res) => {
  assert.equal(req.method, "POST")
  assert.equal(req.url, "/v1/chat/completions")
  assert.equal(req.headers.authorization, "Bearer test-upstream-key")

  let text = ""
  for await (const chunk of req) text += chunk
  const body = JSON.parse(text)
  assert.equal(body.model, "fake-pro-model")
  assert.equal(body.stream, false)

  res.writeHead(200, { "content-type": "application/json" })
  res.end(
    JSON.stringify({
      id: "chatcmpl_fake",
      object: "chat.completion",
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "fake upstream ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    }),
  )
})

await new Promise((resolve) => fakeUpstream.listen(0, "127.0.0.1", resolve))
try {
  const port = fakeUpstream.address().port
  process.env.YOURSERVICE_UPSTREAM_MODE = "openai"
  process.env.UPSTREAM_OPENAI_API_KEY = "test-upstream-key"
  process.env.UPSTREAM_OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`
  process.env.UPSTREAM_OPENAI_PRO_MODEL = "fake-pro-model"

  const model = getModel("pro")
  const upstream = resolveChatUpstream(model)
  const result = await callOpenAICompatibleChat(
    upstream,
    { model: "pro", messages: [{ role: "user", content: "hello" }], stream: true },
    model,
    "req_test",
  )

  assert.equal(result.content, "fake upstream ok")
  assert.equal(result.payload.model, "fake-pro-model")
  assert.equal(result.payload.usage.total_tokens, 10)
  console.log(JSON.stringify({ ok: true, upstreamModel: result.payload.model, content: result.content }))
} finally {
  fakeUpstream.close()
}

const fakeResponsesUpstream = http.createServer(async (req, res) => {
  assert.equal(req.method, "POST")
  assert.equal(req.url, "/v1/responses")
  assert.equal(req.headers.authorization, "Bearer test-responses-key")

  let text = ""
  for await (const chunk of req) text += chunk
  const body = JSON.parse(text)
  assert.equal(body.model, "fake-codex-model")
  assert.equal(body.stream, true)
  assert.equal(body.input[0].content[0].type, "input_text")

  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" })
  res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_fake", object: "response", status: "in_progress", model: body.model } })}\n\n`)
  res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "fake " })}\n\n`)
  res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "responses ok" })}\n\n`)
  res.write(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_fake",
        object: "response",
        status: "completed",
        model: body.model,
        usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
      },
    })}\n\n`,
  )
  res.end()
})

await new Promise((resolve) => fakeResponsesUpstream.listen(0, "127.0.0.1", resolve))
try {
  const port = fakeResponsesUpstream.address().port
  process.env.YOURSERVICE_UPSTREAM_MODE = "codex-responses"
  process.env.UPSTREAM_OPENAI_API_KEY = "test-responses-key"
  process.env.UPSTREAM_OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`
  process.env.UPSTREAM_OPENAI_PRO_MODEL = "fake-codex-model"

  const model = getModel("pro")
  const upstream = resolveChatUpstream(model)
  const result = await callOpenAICompatibleChat(
    upstream,
    { model: "pro", messages: [{ role: "user", content: "hello responses" }] },
    model,
    "req_responses_test",
  )

  assert.equal(result.content, "fake responses ok")
  assert.equal(result.payload.model, "fake-codex-model")
  assert.equal(result.payload.usage.total_tokens, 16)
  console.log(JSON.stringify({ ok: true, upstreamModel: result.payload.model, content: result.content, mode: "responses" }))
} finally {
  fakeResponsesUpstream.close()
}
