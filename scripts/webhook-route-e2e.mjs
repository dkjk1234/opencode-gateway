import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHmac, randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const token = "dev-token"
const webhookSecret = "whsec_route_e2e"
const creditAmount = 5000

const port = await freePort()
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "yourservice-webhook-route-e2e-"))
const statePath = path.join(tempRoot, "gateway-state.json")
const stdoutPath = path.join(tempRoot, "gateway.stdout.log")
const stderrPath = path.join(tempRoot, "gateway.stderr.log")
const baseUrl = `http://127.0.0.1:${port}`

let child
try {
  const stdout = await import("node:fs").then((fs) => fs.createWriteStream(stdoutPath))
  const stderr = await import("node:fs").then((fs) => fs.createWriteStream(stderrPath))
  child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      YOURSERVICE_GATEWAY_HOST: "127.0.0.1",
      YOURSERVICE_GATEWAY_PORT: String(port),
      YOURSERVICE_PUBLIC_BASE_URL: baseUrl,
      YOURSERVICE_BASE_PATH: "",
      YOURSERVICE_STATE_BACKEND: "json",
      YOURSERVICE_DATA_PATH: statePath,
      YOURSERVICE_DEV_TOKENS: `${token}:1000`,
      YOURSERVICE_ADMIN_TOKEN: "admin-token",
      YOURSERVICE_RATE_LIMIT_DISABLED: "true",
      YOURSERVICE_UPSTREAM_MODE: "mock",
      YOURSERVICE_BILLING_PROVIDER: "stripe",
      YOURSERVICE_BILLING_PLANS_JSON: JSON.stringify([
        {
          id: "starter",
          name: "Starter credits",
          credits: creditAmount,
          amount: 990,
          currency: "usd",
        },
      ]),
      YOURSERVICE_STRIPE_SECRET_KEY: "sk_test_fake",
      YOURSERVICE_STRIPE_WEBHOOK_SECRET: webhookSecret,
      YOURSERVICE_STRIPE_MAX_CREDIT_GRANT: "100000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.pipe(stdout)
  child.stderr.pipe(stderr)

  await waitForHealth(baseUrl, child, stderrPath)

  const health = await getJson(`${baseUrl}/health`)
  assert.equal(health.ok, true)
  assert.equal(health.billing.checkout_configured, true)
  assert.equal(health.billing.stripe_webhook_configured, true)

  const before = await getJson(`${baseUrl}/v1/credits`, authHeaders())
  assert.equal(before.credits, 1000)

  const invalidEvent = stripeEvent({ eventID: `evt_invalid_${randomUUID()}` })
  const invalid = await postRaw(`${baseUrl}/webhooks/stripe`, JSON.stringify(invalidEvent), {
    "content-type": "application/json",
    "stripe-signature": signStripePayload(JSON.stringify(invalidEvent), "wrong_secret"),
  })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, "invalid_stripe_signature")

  const event = stripeEvent({ eventID: `evt_route_${randomUUID()}` })
  const rawBody = JSON.stringify(event)
  const signature = signStripePayload(rawBody, webhookSecret)
  const credited = await postRaw(`${baseUrl}/webhooks/stripe`, rawBody, {
    "content-type": "application/json",
    "stripe-signature": signature,
  })
  assert.equal(credited.status, 200)
  assert.equal(credited.body.received, true)
  assert.equal(credited.body.credited, true)
  assert.equal(credited.body.credits, creditAmount)

  const after = await getJson(`${baseUrl}/v1/credits`, authHeaders())
  assert.equal(after.credits, before.credits + creditAmount)

  const replay = await postRaw(`${baseUrl}/webhooks/stripe`, rawBody, {
    "content-type": "application/json",
    "stripe-signature": signature,
  })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.replayed, true)
  assert.equal(replay.body.status, "credited")

  const afterReplay = await getJson(`${baseUrl}/v1/credits`, authHeaders())
  assert.equal(afterReplay.credits, after.credits)

  const usage = await getJson(`${baseUrl}/v1/usage`, authHeaders())
  const stripeCredit = usage.data.find((row) => row.type === "credit" && row.source === "stripe" && row.amount === creditAmount)
  assert.ok(stripeCredit, "Expected a stripe credit ledger row.")
  assert.equal(stripeCredit.reason, "route webhook e2e")

  const admin = await getJson(`${baseUrl}/admin/status`, { authorization: "Bearer admin-token" })
  assert.equal(admin.billing.checkout_configured, true)
  assert.equal(admin.billing.webhook_configured, true)
  assert.equal(admin.state.billing_events_by_status.credited, 1)

  console.log(
    JSON.stringify({
      ok: true,
      webhook: "credited",
      replay: "idempotent",
      creditsBefore: before.credits,
      creditsAfter: afterReplay.credits,
      ledgerID: credited.body.ledger_id,
      tempRoot,
    }),
  )
} finally {
  if (child && !child.killed) child.kill()
  if (child) await waitForExit(child, 3000)
  if (process.env.YOURSERVICE_KEEP_E2E_TEMP !== "true") {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

function stripeEvent({ eventID }) {
  return {
    id: eventID,
    type: "checkout.session.completed",
    data: {
      object: {
        metadata: {
          yourservice_token: token,
          yourservice_credits: String(creditAmount),
          reason: "route webhook e2e",
        },
      },
    },
  }
}

function authHeaders() {
  return { authorization: `Bearer ${token}` }
}

function signStripePayload(rawBody, secret) {
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")
  return `t=${timestamp},v1=${signature}`
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers })
  const body = await response.json()
  assert.ok(response.ok, `${url} failed: ${response.status} ${JSON.stringify(body)}`)
  return body
}

async function postRaw(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
  })
  return {
    status: response.status,
    body: await response.json(),
  }
}

async function waitForHealth(baseUrl, processHandle, stderrPath) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      const stderr = await readFile(stderrPath, "utf8").catch(() => "")
      throw new Error(`Gateway exited early with ${processHandle.exitCode}. stderr: ${stderr}`)
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) {
        const body = await response.json()
        if (body.ok) return
      }
    } catch {
      // Server is still starting.
    }
    await sleep(250)
  }
  const stderr = await readFile(stderrPath, "utf8").catch(() => "")
  throw new Error(`Gateway did not become healthy. stderr: ${stderr}`)
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function waitForExit(processHandle, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    processHandle.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
