import { createHash, randomBytes } from "node:crypto"

let discoveryCache

export function oauthConfigFromEnv(env = process.env) {
  const issuer = trim(env.YOURSERVICE_OAUTH_ISSUER)
  const clientID = trim(env.YOURSERVICE_OAUTH_CLIENT_ID)
  const clientSecret = trim(env.YOURSERVICE_OAUTH_CLIENT_SECRET)
  const authorizationEndpoint = trim(env.YOURSERVICE_OAUTH_AUTHORIZATION_URL)
  const tokenEndpoint = trim(env.YOURSERVICE_OAUTH_TOKEN_URL)
  const userinfoEndpoint = trim(env.YOURSERVICE_OAUTH_USERINFO_URL)
  const redirectUri = trim(env.YOURSERVICE_OAUTH_REDIRECT_URI)
  const scope = trim(env.YOURSERVICE_OAUTH_SCOPE) || "openid email profile"
  const provider = trim(env.YOURSERVICE_OAUTH_PROVIDER) || "oidc"
  return {
    enabled: Boolean(clientID && (issuer || (authorizationEndpoint && tokenEndpoint))),
    issuer,
    clientID,
    clientSecret,
    authorizationEndpoint,
    tokenEndpoint,
    userinfoEndpoint,
    redirectUri,
    scope,
    provider,
    initialCredits: safeInteger(env.YOURSERVICE_OAUTH_INITIAL_CREDITS, 0),
  }
}

export async function createOAuthAuthorization({ config, publicBaseUrl, store, userCode }) {
  if (!config.enabled) throw httpError(404, "oauth_disabled", "OAuth login is not configured.")
  const device = store.findDeviceByUserCode(userCode)
  if (!device || device.expiresAt <= Date.now()) throw httpError(404, "device_code_not_found", "Device code not found or expired.")
  const endpoints = await resolveEndpoints(config)
  const redirectUri = callbackUrl(config, publicBaseUrl)
  const codeVerifier = base64url(randomBytes(32))
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest())
  const stateRow = store.createOAuthState({
    userCode: device.userCode,
    provider: config.provider,
    codeVerifier,
    redirectUri,
  })
  const authUrl = new URL(endpoints.authorizationEndpoint)
  authUrl.searchParams.set("response_type", "code")
  authUrl.searchParams.set("client_id", config.clientID)
  authUrl.searchParams.set("redirect_uri", redirectUri)
  authUrl.searchParams.set("scope", config.scope)
  authUrl.searchParams.set("state", stateRow.state)
  authUrl.searchParams.set("code_challenge", codeChallenge)
  authUrl.searchParams.set("code_challenge_method", "S256")
  return authUrl.toString()
}

export async function completeOAuthCallback({ config, publicBaseUrl, store, query }) {
  if (!config.enabled) throw httpError(404, "oauth_disabled", "OAuth login is not configured.")
  const error = query.get("error")
  if (error) throw httpError(401, "oauth_denied", query.get("error_description") || error)
  const code = query.get("code")
  const state = store.consumeOAuthState(query.get("state"))
  if (!code || !state) throw httpError(400, "invalid_oauth_state", "OAuth code or state is missing, expired, or already used.")

  const endpoints = await resolveEndpoints(config)
  const tokenSet = await exchangeCode({ config, endpoints, code, state, publicBaseUrl })
  const profile = await fetchProfile({ endpoints, tokenSet })
  const subject = profile.sub || profile.id || profile.email
  if (!subject) throw httpError(502, "oauth_profile_missing_subject", "OAuth profile did not include a stable subject.")

  const account = store.upsertExternalUser({
    provider: config.provider,
    subject,
    email: profile.email,
    name: profile.name,
    initialCredits: config.initialCredits,
  })
  const device = store.approveDeviceCodeForAccount(state.userCode, account.userID, account.orgID)
  if (!device) throw httpError(404, "device_code_not_found", "Device code expired before OAuth login completed.")
  return { account, device }
}

async function resolveEndpoints(config) {
  if (config.authorizationEndpoint && config.tokenEndpoint) {
    return {
      authorizationEndpoint: config.authorizationEndpoint,
      tokenEndpoint: config.tokenEndpoint,
      userinfoEndpoint: config.userinfoEndpoint,
    }
  }
  if (!config.issuer) throw httpError(500, "oauth_misconfigured", "OAuth issuer or explicit endpoints are required.")
  if (!discoveryCache) {
    const discoveryUrl = `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`
    const response = await fetch(discoveryUrl, { headers: { accept: "application/json" } })
    if (!response.ok) throw httpError(502, "oauth_discovery_failed", `OAuth discovery failed with HTTP ${response.status}.`)
    discoveryCache = await response.json()
  }
  return {
    authorizationEndpoint: discoveryCache.authorization_endpoint,
    tokenEndpoint: discoveryCache.token_endpoint,
    userinfoEndpoint: discoveryCache.userinfo_endpoint,
  }
}

async function exchangeCode({ config, endpoints, code, state, publicBaseUrl }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: state.redirectUri || callbackUrl(config, publicBaseUrl),
    client_id: config.clientID,
    code_verifier: state.codeVerifier,
  })
  if (config.clientSecret) body.set("client_secret", config.clientSecret)
  const response = await fetch(endpoints.tokenEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : {}
  if (!response.ok) throw httpError(502, "oauth_token_exchange_failed", payload.error_description || payload.error || `HTTP ${response.status}`)
  return payload
}

async function fetchProfile({ endpoints, tokenSet }) {
  if (endpoints.userinfoEndpoint && tokenSet.access_token) {
    const response = await fetch(endpoints.userinfoEndpoint, {
      headers: { accept: "application/json", authorization: `Bearer ${tokenSet.access_token}` },
    })
    if (response.ok) return response.json()
  }
  if (tokenSet.id_token) return decodeJwtPayload(tokenSet.id_token)
  throw httpError(502, "oauth_profile_unavailable", "OAuth provider did not return a usable user profile.")
}

function decodeJwtPayload(jwt) {
  const [, payload] = String(jwt).split(".")
  if (!payload) return {}
  return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64url").toString("utf8"))
}

function callbackUrl(config, publicBaseUrl) {
  return config.redirectUri || `${publicBaseUrl}/auth/oauth/callback`
}

function trim(value) {
  return String(value || "").trim()
}

function safeInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function httpError(statusCode, code, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}
