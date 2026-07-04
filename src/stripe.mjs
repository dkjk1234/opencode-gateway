import { createHmac, timingSafeEqual } from "node:crypto"

export function stripeWebhookConfigFromEnv(env = process.env) {
  return {
    enabled: Boolean(String(env.YOURSERVICE_STRIPE_WEBHOOK_SECRET || "").trim()),
    secret: String(env.YOURSERVICE_STRIPE_WEBHOOK_SECRET || "").trim(),
    toleranceSeconds: positiveInteger(env.YOURSERVICE_STRIPE_SIGNATURE_TOLERANCE_SECONDS, 300),
    maxCreditGrant: positiveInteger(env.YOURSERVICE_STRIPE_MAX_CREDIT_GRANT, 1_000_000),
  }
}

export function verifyStripeSignature({ rawBody, signatureHeader, secret, toleranceSeconds = 300, now = Date.now() }) {
  if (!secret) throw httpError(404, "stripe_webhook_disabled", "Stripe webhook is not configured.")
  const parts = Object.fromEntries(
    String(signatureHeader || "")
      .split(",")
      .map((item) => item.split("=", 2))
      .filter(([key, value]) => key && value),
  )
  const timestamp = Number(parts.t)
  const signature = parts.v1
  if (!timestamp || !signature) throw httpError(400, "invalid_stripe_signature", "Stripe signature header is missing t or v1.")
  const age = Math.abs(Math.floor(now / 1000) - timestamp)
  if (age > toleranceSeconds) throw httpError(400, "stale_stripe_signature", "Stripe signature timestamp is outside the allowed tolerance.")

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")
  const left = Buffer.from(signature, "hex")
  const right = Buffer.from(expected, "hex")
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw httpError(400, "invalid_stripe_signature", "Stripe signature verification failed.")
  }
  return true
}

export function stripeEventToCreditGrant(event, { maxCreditGrant = 1_000_000 } = {}) {
  const eventType = String(event?.type || "")
  if (!["checkout.session.completed", "invoice.paid", "payment_intent.succeeded"].includes(eventType)) {
    return { ignored: true, reason: `ignored event type ${eventType || "unknown"}` }
  }
  const object = event?.data?.object || {}
  const metadata = object.metadata || {}
  const credits = Number(metadata.yourservice_credits || metadata.credits)
  if (!Number.isSafeInteger(credits) || credits <= 0 || credits > maxCreditGrant) {
    throw httpError(400, "invalid_credit_metadata", "Stripe event metadata must include a valid yourservice_credits amount.")
  }
  const token = String(metadata.yourservice_token || metadata.token || "").trim()
  const userID = String(metadata.yourservice_user_id || metadata.user_id || "").trim()
  const orgID = String(metadata.yourservice_org_id || metadata.org_id || "").trim()
  if (!token && !userID) {
    throw httpError(400, "missing_account_metadata", "Stripe event metadata must include yourservice_token or yourservice_user_id.")
  }
  return {
    ignored: false,
    token,
    userID,
    orgID,
    credits,
    reason: String(metadata.reason || `stripe ${eventType}`).slice(0, 280),
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function httpError(statusCode, code, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}
