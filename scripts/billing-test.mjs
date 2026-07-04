import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import {
  billingConfigFromEnv,
  billingStatus,
  createStripeCheckoutSession,
  publicBillingPlans,
  resolveBillingPlan,
} from "../src/billing.mjs"
import { stripeEventToCreditGrant, verifyStripeSignature } from "../src/stripe.mjs"

const plansJson = JSON.stringify([
  {
    id: "starter",
    name: "Starter credits",
    description: "Test starter pack",
    credits: 5000,
    amount: 990,
    currency: "usd",
  },
])
const config = billingConfigFromEnv({
  YOURSERVICE_BILLING_PROVIDER: "stripe",
  YOURSERVICE_BILLING_PLANS_JSON: plansJson,
  YOURSERVICE_STRIPE_SECRET_KEY: "sk_test_fake",
})

assert.equal(config.stripe.enabled, true)
assert.equal(publicBillingPlans(config).length, 1)
assert.equal(billingStatus(config).checkout_configured, true)
const plan = resolveBillingPlan(config, "starter")
assert.equal(plan.credits, 5000)

let captured
const checkout = await createStripeCheckoutSession({
  config,
  plan,
  publicBaseUrl: "https://example.test/opencode-gateway",
  idempotencyKey: "billing_checkout:user:org:test",
  account: {
    userID: "usr_test",
    orgID: "org_test",
    user: { email: "buyer@example.test" },
  },
  fetchImpl: async (url, options) => {
    captured = { url, options, body: new URLSearchParams(options.body) }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ id: "cs_test_123", url: "https://checkout.stripe.test/cs_test_123", mode: "payment" })
      },
    }
  },
})

assert.equal(checkout.id, "cs_test_123")
assert.equal(captured.url, "https://api.stripe.com/v1/checkout/sessions")
assert.equal(captured.options.headers.authorization, "Bearer sk_test_fake")
assert.equal(captured.options.headers["idempotency-key"], "billing_checkout:user:org:test")
assert.equal(captured.body.get("mode"), "payment")
assert.equal(captured.body.get("client_reference_id"), "usr_test")
assert.equal(captured.body.get("line_items[0][price_data][unit_amount]"), "990")
assert.equal(captured.body.get("metadata[yourservice_user_id]"), "usr_test")
assert.equal(captured.body.get("metadata[yourservice_org_id]"), "org_test")
assert.equal(captured.body.get("metadata[yourservice_credits]"), "5000")
assert.equal(captured.body.get("payment_intent_data[metadata][yourservice_plan_id]"), "starter")

const event = {
  id: "evt_test",
  type: "checkout.session.completed",
  data: {
    object: {
      metadata: {
        yourservice_user_id: "usr_test",
        yourservice_org_id: "org_test",
        yourservice_credits: "5000",
        reason: "starter",
      },
    },
  },
}
const grant = stripeEventToCreditGrant(event, { maxCreditGrant: 10000 })
assert.equal(grant.userID, "usr_test")
assert.equal(grant.orgID, "org_test")
assert.equal(grant.credits, 5000)

const rawBody = JSON.stringify(event)
const timestamp = Math.floor(Date.now() / 1000)
const secret = "whsec_test"
const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")
assert.equal(verifyStripeSignature({ rawBody, signatureHeader: `t=${timestamp},v1=${signature}`, secret }), true)

console.log(JSON.stringify({ ok: true, checkout: checkout.id, plan: plan.id, credits: grant.credits }))
