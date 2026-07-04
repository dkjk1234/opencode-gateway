export function billingConfigFromEnv(env = process.env) {
  const provider = String(env.YOURSERVICE_BILLING_PROVIDER || "stripe").trim().toLowerCase()
  const plans = parseBillingPlans(env.YOURSERVICE_BILLING_PLANS_JSON || env.YOURSERVICE_BILLING_PLAN_JSON || "")
  const stripeSecretKey = String(env.YOURSERVICE_STRIPE_SECRET_KEY || "").trim()
  return {
    provider,
    plans,
    stripe: {
      enabled: provider === "stripe" && Boolean(stripeSecretKey) && plans.length > 0,
      secretKey: stripeSecretKey,
      apiBaseUrl: trimTrailingSlashes(env.YOURSERVICE_STRIPE_API_BASE_URL || "https://api.stripe.com"),
      successUrl: String(env.YOURSERVICE_BILLING_SUCCESS_URL || "").trim(),
      cancelUrl: String(env.YOURSERVICE_BILLING_CANCEL_URL || "").trim(),
    },
  }
}

export function billingStatus(config) {
  return {
    provider: config.provider,
    checkout_configured: config.provider === "stripe" && Boolean(config.stripe?.enabled),
    plans_count: config.plans.length,
    plans: publicBillingPlans(config),
    stripe: {
      secret_configured: Boolean(config.stripe?.secretKey),
      checkout_configured: Boolean(config.stripe?.enabled),
    },
  }
}

export function publicBillingPlans(config) {
  return config.plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    description: plan.description,
    credits: plan.credits,
    currency: plan.currency,
    amount: plan.amount,
    stripe_price_configured: Boolean(plan.stripePriceId),
  }))
}

export function resolveBillingPlan(config, planID) {
  const id = String(planID || "").trim()
  if (!id) throw httpError(400, "billing_plan_required", "plan_id is required.")
  const plan = config.plans.find((item) => item.id === id)
  if (!plan) throw httpError(404, "billing_plan_not_found", "Billing plan was not found.")
  return plan
}

export async function createStripeCheckoutSession({
  config,
  plan,
  account,
  publicBaseUrl,
  idempotencyKey,
  successUrl,
  cancelUrl,
  customerEmail,
  fetchImpl = fetch,
}) {
  if (config.provider !== "stripe") throw httpError(503, "billing_provider_disabled", "Stripe billing is not selected.")
  if (!config.stripe?.secretKey) throw httpError(503, "stripe_secret_key_required", "Stripe secret key is not configured.")
  if (!config.stripe?.enabled) throw httpError(503, "stripe_checkout_disabled", "Stripe checkout is disabled until billing plans and a secret key are configured.")
  if (!account?.userID || !account?.orgID) throw httpError(401, "account_required", "An authenticated account is required.")

  const metadata = checkoutMetadata({ plan, account })
  const params = new URLSearchParams()
  params.set("mode", "payment")
  params.set("client_reference_id", account.userID)
  params.set("success_url", checkoutReturnUrl(successUrl || config.stripe.successUrl, publicBaseUrl, "success"))
  params.set("cancel_url", checkoutReturnUrl(cancelUrl || config.stripe.cancelUrl, publicBaseUrl, "cancel"))
  if (customerEmail) params.set("customer_email", String(customerEmail).slice(0, 320))

  for (const [key, value] of Object.entries(metadata)) {
    params.set(`metadata[${key}]`, String(value))
    params.set(`payment_intent_data[metadata][${key}]`, String(value))
  }

  if (plan.stripePriceId) {
    params.set("line_items[0][price]", plan.stripePriceId)
  } else {
    params.set("line_items[0][price_data][currency]", plan.currency)
    params.set("line_items[0][price_data][unit_amount]", String(plan.amount))
    params.set("line_items[0][price_data][product_data][name]", plan.name)
    if (plan.description) params.set("line_items[0][price_data][product_data][description]", plan.description)
  }
  params.set("line_items[0][quantity]", "1")

  const headers = {
    authorization: `Bearer ${config.stripe.secretKey}`,
    "content-type": "application/x-www-form-urlencoded",
  }
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey

  const response = await fetchImpl(`${config.stripe.apiBaseUrl}/v1/checkout/sessions`, {
    method: "POST",
    headers,
    body: params,
  })
  const text = await response.text()
  const data = parseJsonOrText(text)
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `Stripe checkout failed with HTTP ${response.status}.`
    throw httpError(response.status || 502, "stripe_checkout_failed", message)
  }
  if (!data?.id || !data?.url) {
    throw httpError(502, "stripe_checkout_invalid_response", "Stripe checkout response did not include id and url.")
  }
  return {
    id: data.id,
    url: data.url,
    mode: data.mode || "payment",
    metadata,
    raw: data,
  }
}

export function parseBillingPlans(raw) {
  const text = String(raw || "").trim()
  if (!text) return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`YOURSERVICE_BILLING_PLANS_JSON must be valid JSON: ${error.message}`)
  }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  return items.map(normalizeBillingPlan)
}

function normalizeBillingPlan(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Billing plan at index ${index} must be an object.`)
  const id = cleanID(raw.id || raw.code || raw.plan_id || raw.planID)
  if (!id) throw new Error(`Billing plan at index ${index} requires id/code.`)
  const credits = positiveInteger(raw.credits ?? raw.credit_amount ?? raw.creditAmount, `Billing plan ${id} requires a positive credits value.`)
  const currency = String(raw.currency || "usd").trim().toLowerCase()
  if (!/^[a-z]{3}$/.test(currency)) throw new Error(`Billing plan ${id} has invalid currency.`)
  const stripePriceId = String(raw.stripe_price_id || raw.stripePriceId || raw.price_id || "").trim()
  const amount = positiveInteger(raw.amount ?? raw.amount_cents ?? raw.unit_amount ?? raw.price_cents, `Billing plan ${id} requires a positive amount/unit_amount unless a Stripe price is used.`, Boolean(stripePriceId))
  return {
    id,
    name: String(raw.name || id).slice(0, 120),
    description: String(raw.description || `${credits} credits`).slice(0, 300),
    credits,
    currency,
    amount,
    stripePriceId,
  }
}

function checkoutMetadata({ plan, account }) {
  return {
    yourservice_user_id: account.userID,
    yourservice_org_id: account.orgID,
    yourservice_credits: plan.credits,
    yourservice_plan_id: plan.id,
    reason: `billing plan ${plan.id}`,
  }
}

function checkoutReturnUrl(value, publicBaseUrl, fallbackName) {
  const url = String(value || "").trim()
  if (url) return url
  const base = String(publicBaseUrl || "").replace(/\/+$/, "")
  return `${base}/billing/${fallbackName}?session_id={CHECKOUT_SESSION_ID}`
}

function positiveInteger(value, message, allowEmpty = false) {
  if ((value === undefined || value === null || value === "") && allowEmpty) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(message)
  return parsed
}

function cleanID(value) {
  const id = String(value || "").trim()
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(id) ? id : ""
}

function trimTrailingSlashes(value) {
  return String(value || "").replace(/\/+$/, "")
}

function parseJsonOrText(text) {
  try {
    return JSON.parse(text)
  } catch {
    return { text }
  }
}

function httpError(statusCode, code, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}
