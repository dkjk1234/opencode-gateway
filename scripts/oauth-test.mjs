import assert from "node:assert/strict"
import { completeOAuthCallback, createOAuthAuthorization, oauthConfigFromEnv } from "../src/oauth.mjs"

function createMockStore({ userCode = "ABCD-2345" } = {}) {
  const oauthStates = new Map()
  const approvals = []
  return {
    oauthStates,
    approvals,
    findDeviceByUserCode(input) {
      if (String(input || "") !== userCode) return undefined
      return { userCode, expiresAt: Date.now() + 60_000 }
    },
    createOAuthState(row) {
      const state = "oauth_test_state"
      const stored = { state, ...row, expiresAt: Date.now() + 60_000 }
      oauthStates.set(state, stored)
      return stored
    },
    consumeOAuthState(state) {
      const stored = oauthStates.get(state)
      oauthStates.delete(state)
      return stored
    },
    upsertExternalUser(profile) {
      assert.equal(profile.subject, "subject-1")
      assert.equal(profile.email, "user@example.com")
      return {
        userID: "usr_subject_1",
        orgID: "org_subject_1",
        user: { id: "usr_subject_1", email: profile.email, balance: 1000 },
        org: { id: "org_subject_1", name: "YourService User Org" },
      }
    },
    approveDeviceCodeForAccount(approvedUserCode, userID, orgID) {
      approvals.push({ approvedUserCode, userID, orgID })
      return { userCode: approvedUserCode, status: "approved", userID, orgID }
    },
  }
}

function testConfig(env = {}) {
  return oauthConfigFromEnv({
    YOURSERVICE_OAUTH_PROVIDER: "google",
    YOURSERVICE_OAUTH_AUTHORIZATION_URL: "https://accounts.example.test/auth",
    YOURSERVICE_OAUTH_TOKEN_URL: "https://accounts.example.test/token",
    YOURSERVICE_OAUTH_USERINFO_URL: "https://accounts.example.test/userinfo",
    YOURSERVICE_OAUTH_CLIENT_ID: "client-id",
    YOURSERVICE_OAUTH_CLIENT_SECRET: "client-secret",
    YOURSERVICE_OAUTH_SCOPE: "openid email profile",
    YOURSERVICE_OAUTH_INITIAL_CREDITS: "1000",
    ...env,
  })
}

async function authorizationUrlFor(config, publicBaseUrl = "https://gateway.example/base") {
  const store = createMockStore()
  const url = await createOAuthAuthorization({ config, publicBaseUrl, store, userCode: "ABCD-2345" })
  return { url: new URL(url), store }
}

{
  const config = testConfig()
  const { url, store } = await authorizationUrlFor(config)
  assert.equal(url.searchParams.get("redirect_uri"), "https://gateway.example/base/auth/oauth/callback")
  assert.equal(store.oauthStates.get("oauth_test_state").redirectUri, "https://gateway.example/base/auth/oauth/callback")
}

{
  const redirect = "https://llms.ai.kr/chatgpt/auth/google/callback"
  const config = testConfig({ YOURSERVICE_OAUTH_REDIRECT_URI: redirect })
  const { url, store } = await authorizationUrlFor(config, "https://llms.ai.kr/opencode-gateway")
  assert.equal(url.searchParams.get("redirect_uri"), redirect)
  assert.equal(store.oauthStates.get("oauth_test_state").redirectUri, redirect)
}

{
  const redirect = "https://llms.ai.kr/chatgpt/auth/google/callback"
  const config = testConfig({ YOURSERVICE_OAUTH_REDIRECT_URI: redirect })
  const { store } = await authorizationUrlFor(config, "https://llms.ai.kr/opencode-gateway")
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (String(url).endsWith("/token")) {
      const body = new URLSearchParams(options.body)
      assert.equal(body.get("redirect_uri"), redirect)
      assert.equal(body.get("code"), "oauth-code")
      assert.equal(body.get("client_id"), "client-id")
      assert.equal(body.get("client_secret"), "client-secret")
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ access_token: "access-token" })
        },
      }
    }
    if (String(url).endsWith("/userinfo")) {
      assert.equal(options.headers.authorization, "Bearer access-token")
      return {
        ok: true,
        status: 200,
        async json() {
          return { sub: "subject-1", email: "user@example.com", name: "User Example" }
        },
      }
    }
    throw new Error(`unexpected fetch ${url}`)
  }

  try {
    const result = await completeOAuthCallback({
      config,
      publicBaseUrl: "https://llms.ai.kr/opencode-gateway",
      store,
      query: new URLSearchParams({ code: "oauth-code", state: "oauth_test_state" }),
    })
    assert.equal(result.account.user.email, "user@example.com")
    assert.deepEqual(store.approvals, [
      { approvedUserCode: "ABCD-2345", userID: "usr_subject_1", orgID: "org_subject_1" },
    ])
    assert.equal(calls.length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log(JSON.stringify({ ok: true, oauth: "redirect override and token exchange reuse verified" }))
