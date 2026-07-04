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
