import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"

export const DEFAULT_STATE = {
  users: {},
  orgs: {},
  accessTokens: {},
  refreshTokens: {},
  apiTokens: {},
  deviceCodes: {},
  oauthStates: {},
  externalIdentities: {},
  billingEvents: {},
  ledger: [],
  requests: {},
  adminOperations: {},
}

export class GatewayState {
  constructor(filePath) {
    this.filePath = filePath
    this.backend = "json"
    this.description = filePath
    this.state = structuredClone(DEFAULT_STATE)
    this.saveChain = Promise.resolve()
  }

  static async open(filePath, seedSpec) {
    const store = new GatewayState(filePath)
    await store.load()
    store.seed(seedSpec)
    await store.save()
    return store
  }

  async load() {
    try {
      const text = await readFile(this.filePath, "utf8")
      this.state = { ...structuredClone(DEFAULT_STATE), ...JSON.parse(text) }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      this.state = structuredClone(DEFAULT_STATE)
    }
  }

  async save() {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`
    const write = this.saveChain.catch(() => undefined).then(() => this.writeSnapshot(snapshot))
    this.saveChain = write
    return write
  }

  async writeSnapshot(snapshot) {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    await writeFile(tempPath, snapshot, "utf8")
    await rename(tempPath, this.filePath)
  }

  seed(seedSpec = "dev-token:100000") {
    for (const pair of seedSpec.split(",")) {
      const [tokenRaw, creditsRaw] = pair.split(":")
      const token = tokenRaw?.trim()
      if (!token) continue
      const credits = normalizeSeedBalance(creditsRaw || 100000, 100000)
      const tokenFingerprint = fingerprintToken(token)
      const now = new Date().toISOString()
      const userID = `dev_${token.slice(0, 8).replace(/[^a-zA-Z0-9_]/g, "") || "user"}`
      const orgID = `${userID}_org`
      if (!this.state.users[userID]) {
        this.state.users[userID] = {
          id: userID,
          email: `${userID}@yourservice.local`,
          defaultOrgID: orgID,
          balance: credits,
          createdAt: now,
        }
      }
      if (!this.state.orgs[orgID]) {
        this.state.orgs[orgID] = {
          id: orgID,
          name: "YourService Dev Org",
          userIDs: [userID],
        }
      }
      const createdAt = this.state.apiTokens[token]?.createdAt || now
      this.state.apiTokens[token] = { userID, orgID, tokenFingerprint, createdAt, updatedAt: now }
      this.state.accessTokens[token] = { userID, orgID, expiresAt: null, dev: true, tokenFingerprint }
      this.reconcileUserLedger(userID, orgID, {
        tokenFingerprint,
        source: "seed",
        reason: "startup seed reconciliation",
      })
    }
  }

  authenticate(token) {
    if (!token) return undefined
    const access = this.state.accessTokens[token]
    if (!access) return undefined
    if (access.expiresAt && access.expiresAt <= Date.now()) return undefined
    return this.account(access.userID, access.orgID, token, access.tokenFingerprint)
  }

  account(userID, orgID, token, tokenFingerprint = token ? fingerprintToken(token) : undefined) {
    const user = this.state.users[userID]
    if (!user) return undefined
    const resolvedOrgID = orgID || user.defaultOrgID
    const org = this.state.orgs[resolvedOrgID]
    if (!org) return undefined
    return { token, tokenFingerprint, user, org, userID, orgID: resolvedOrgID }
  }

  accountForToken(token) {
    if (!token) return undefined
    const row = this.state.apiTokens[token] || this.state.accessTokens[token]
    if (!row) return undefined
    return this.account(row.userID, row.orgID, token, row.tokenFingerprint || fingerprintToken(token))
  }

  accountForUserID(userID, orgID) {
    if (!userID) return undefined
    const user = this.state.users[userID]
    if (!user) return undefined
    return this.account(userID, orgID || user.defaultOrgID)
  }

  createDeviceCode({ clientID }) {
    const deviceCode = `dc_${randomUUID()}`
    const userCode = randomUserCode()
    const now = Date.now()
    this.state.deviceCodes[deviceCode] = {
      deviceCode,
      userCode,
      clientID,
      status: "pending",
      createdAt: now,
      expiresAt: now + 10 * 60 * 1000,
      interval: 2,
    }
    return this.state.deviceCodes[deviceCode]
  }

  findDeviceByUserCode(userCode) {
    const normalized = normalizeUserCode(userCode)
    return Object.values(this.state.deviceCodes).find((item) => normalizeUserCode(item.userCode) === normalized)
  }

  approveDeviceCode(userCode, token) {
    const device = this.findDeviceByUserCode(userCode)
    if (!device) return undefined
    if (device.expiresAt <= Date.now()) return undefined
    if (device.status === "denied") return undefined
    const account = this.authenticate(token)
    if (!account) return undefined
    if (device.status === "approved") return device
    device.status = "approved"
    device.userID = account.userID
    device.orgID = account.orgID
    device.approvedAt = Date.now()
    return device
  }

  approveDeviceCodeForAccount(userCode, userID, orgID) {
    const device = this.findDeviceByUserCode(userCode)
    if (!device) return undefined
    if (device.expiresAt <= Date.now()) return undefined
    if (device.status === "denied") return undefined
    const account = this.account(userID, orgID)
    if (!account) return undefined
    if (device.status === "approved") return device
    device.status = "approved"
    device.userID = account.userID
    device.orgID = account.orgID
    device.approvedAt = Date.now()
    return device
  }

  denyDeviceCode(userCode) {
    const device = this.findDeviceByUserCode(userCode)
    if (!device) return undefined
    device.status = "denied"
    return device
  }

  issueApiToken(userID, orgID, source = "device_oauth") {
    const token = `ys_api_${randomUUID()}`
    const now = Date.now()
    const tokenFingerprint = fingerprintToken(token)
    this.state.apiTokens[token] = { userID, orgID, tokenFingerprint, createdAt: now, updatedAt: now, source }
    this.state.accessTokens[token] = { userID, orgID, expiresAt: null, api: true, tokenFingerprint }
    this.reconcileUserLedger(userID, orgID, {
      tokenFingerprint,
      source,
      reason: "api token reconciliation",
    })
    return token
  }

  issueToken(userID, orgID, options = {}) {
    const accessToken = `ys_access_${randomUUID()}`
    const refreshToken = `ys_refresh_${randomUUID()}`
    const expiresIn = 3600
    const expiresAt = Date.now() + expiresIn * 1000
    this.state.accessTokens[accessToken] = { userID, orgID, expiresAt, tokenFingerprint: fingerprintToken(accessToken) }
    this.state.refreshTokens[refreshToken] = {
      userID,
      orgID,
      tokenFingerprint: fingerprintToken(refreshToken),
      createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    }
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      ...(options.includeApiToken ? { api_token: this.issueApiToken(userID, orgID) } : {}),
    }
  }

  refresh(refreshToken) {
    const row = this.state.refreshTokens[refreshToken]
    if (!row) return undefined
    if (row.expiresAt && row.expiresAt <= Date.now()) {
      delete this.state.refreshTokens[refreshToken]
      return undefined
    }
    delete this.state.refreshTokens[refreshToken]
    return this.issueToken(row.userID, row.orgID)
  }

  revokeAccessToken(accessToken) {
    if (!accessToken || !this.state.accessTokens[accessToken]) return false
    delete this.state.accessTokens[accessToken]
    return true
  }

  revokeRefreshToken(refreshToken) {
    if (!refreshToken || !this.state.refreshTokens[refreshToken]) return false
    delete this.state.refreshTokens[refreshToken]
    return true
  }

  revokeToken(token) {
    return {
      access: this.revokeAccessToken(token),
      refresh: this.revokeRefreshToken(token),
    }
  }

  createOAuthState({ userCode, provider = "oidc", codeVerifier, redirectUri }) {
    const state = `oauth_${randomUUID()}`
    const now = Date.now()
    this.state.oauthStates[state] = {
      state,
      userCode,
      provider,
      codeVerifier,
      redirectUri,
      createdAt: now,
      expiresAt: now + 10 * 60 * 1000,
    }
    return this.state.oauthStates[state]
  }

  consumeOAuthState(state) {
    const key = String(state || "")
    const row = this.state.oauthStates[key]
    if (!row) return undefined
    delete this.state.oauthStates[key]
    if (row.expiresAt <= Date.now()) return undefined
    return row
  }

  upsertExternalUser({ provider = "oidc", subject, email, name, initialCredits = 0 }) {
    const normalizedSubject = String(subject || "").trim()
    if (!normalizedSubject) {
      const error = new Error("External auth subject is required.")
      error.statusCode = 400
      throw error
    }
    const identityKey = `${provider}:${normalizedSubject}`
    const now = new Date().toISOString()
    const existing = this.state.externalIdentities[identityKey]
    const idSuffix = createHash("sha256").update(identityKey).digest("hex").slice(0, 16)
    const userID = existing?.userID || `usr_${idSuffix}`
    const orgID = existing?.orgID || `org_${idSuffix}`

    if (!this.state.users[userID]) {
      this.state.users[userID] = {
        id: userID,
        email: String(email || `${userID}@yourservice.local`).slice(0, 320),
        name: name ? String(name).slice(0, 160) : undefined,
        defaultOrgID: orgID,
        balance: normalizeSeedBalance(initialCredits, 0),
        createdAt: now,
      }
    } else {
      if (email) this.state.users[userID].email = String(email).slice(0, 320)
      if (name) this.state.users[userID].name = String(name).slice(0, 160)
      this.state.users[userID].updatedAt = now
    }

    if (!this.state.orgs[orgID]) {
      this.state.orgs[orgID] = {
        id: orgID,
        name: "YourService User Org",
        userIDs: [userID],
      }
    }

    this.state.externalIdentities[identityKey] = {
      provider,
      subject: normalizedSubject,
      userID,
      orgID,
      email: email || this.state.users[userID].email,
      updatedAt: now,
      createdAt: existing?.createdAt || now,
    }

    this.reconcileUserLedger(userID, orgID, {
      tokenFingerprint: identityKey,
      source: "external_auth",
      reason: "external identity reconciliation",
    })

    return this.account(userID, orgID)
  }

  pollDeviceCode(deviceCode) {
    const device = this.state.deviceCodes[deviceCode]
    if (!device) return { error: "expired_token", error_description: "Unknown device code." }
    if (device.expiresAt <= Date.now()) return { error: "expired_token", error_description: "Device code expired." }
    if (device.status === "denied") return { error: "access_denied", error_description: "Authorization denied." }
    if (device.status !== "approved") return { error: "authorization_pending", error_description: "Authorization is pending." }
    return this.issueToken(device.userID, device.orgID, { includeApiToken: true })
  }

  getRequest(idempotencyKey) {
    if (!idempotencyKey) return undefined
    const row = this.state.requests[idempotencyKey]
    if (!row) return undefined
    if (row.expiresAt && row.expiresAt <= Date.now()) {
      delete this.state.requests[idempotencyKey]
      return undefined
    }
    return row
  }

  putRequest(idempotencyKey, value) {
    if (!idempotencyKey) return
    const now = Date.now()
    this.state.requests[idempotencyKey] = {
      createdAt: value.createdAt || now,
      expiresAt: value.expiresAt || now + 24 * 60 * 60 * 1000,
      ...value,
    }
  }

  debit(account, amount, request) {
    const credits = normalizeCreditAmount(amount)
    if (account.user.balance < credits) {
      const error = new Error("Not enough credits for this request.")
      error.statusCode = 402
      error.code = "insufficient_credits"
      error.required_credits = credits
      error.current_credits = account.user.balance
      throw error
    }
    account.user.balance -= credits
    const row = {
      id: randomUUID(),
      type: "debit",
      userId: account.userID,
      orgId: account.orgID,
      tokenFingerprint: account.tokenFingerprint,
      amount: -credits,
      balanceAfter: account.user.balance,
      request,
      createdAt: new Date().toISOString(),
    }
    this.state.ledger.push(row)
    return row
  }

  grantCredits(account, amount, { actor = "admin", reason = "credit grant", idempotencyKey } = {}) {
    const credits = normalizeCreditAmount(amount)
    const operationKey = idempotencyKey?.trim()
    if (operationKey) {
      const existing = this.state.adminOperations[operationKey]
      if (existing) {
        if (
          existing.type !== "credit_grant" ||
          existing.userID !== account.userID ||
          existing.orgID !== account.orgID ||
          existing.amount !== credits
        ) {
          const error = new Error("Idempotency key was already used for a different admin credit grant.")
          error.statusCode = 409
          throw error
        }
        const row = this.state.ledger.find((entry) => entry.id === existing.ledgerId)
        if (!row) {
          const error = new Error("Idempotent admin operation exists but its ledger row is missing.")
          error.statusCode = 409
          throw error
        }
        return { row, replayed: true }
      }
    }

    account.user.balance += credits
    const row = {
      id: randomUUID(),
      type: "credit",
      userId: account.userID,
      orgId: account.orgID,
      tokenFingerprint: account.tokenFingerprint,
      amount: credits,
      balanceAfter: account.user.balance,
      source: actor,
      reason,
      createdAt: new Date().toISOString(),
    }
    this.state.ledger.push(row)

    if (operationKey) {
      this.state.adminOperations[operationKey] = {
        type: "credit_grant",
        userID: account.userID,
        orgID: account.orgID,
        amount: credits,
        ledgerId: row.id,
        createdAt: row.createdAt,
      }
    }

    return { row, replayed: false }
  }

  getBillingEvent(eventID) {
    if (!eventID) return undefined
    return this.state.billingEvents[eventID]
  }

  putBillingEvent(eventID, value = {}) {
    if (!eventID) return
    const now = new Date().toISOString()
    this.state.billingEvents[eventID] = {
      id: eventID,
      createdAt: this.state.billingEvents[eventID]?.createdAt || now,
      updatedAt: now,
      ...value,
    }
  }

  ledgerFor(userID, limit = 100) {
    return this.state.ledger.filter((row) => row.userId === userID).slice(-limit)
  }

  summary() {
    const deviceStatuses = countBy(Object.values(this.state.deviceCodes), (item) => item.status || "unknown")
    const billingStatuses = countBy(Object.values(this.state.billingEvents), (item) => item.status || "unknown")
    const ledgerTotal = this.state.ledger.reduce((sum, row) => sum + Number(row.amount || 0), 0)
    return {
      users: Object.keys(this.state.users).length,
      orgs: Object.keys(this.state.orgs).length,
      access_tokens: Object.keys(this.state.accessTokens).length,
      refresh_tokens: Object.keys(this.state.refreshTokens).length,
      api_tokens: Object.keys(this.state.apiTokens).length,
      device_codes: Object.keys(this.state.deviceCodes).length,
      device_codes_by_status: deviceStatuses,
      oauth_states: Object.keys(this.state.oauthStates).length,
      external_identities: Object.keys(this.state.externalIdentities).length,
      billing_events: Object.keys(this.state.billingEvents).length,
      billing_events_by_status: billingStatuses,
      ledger_rows: this.state.ledger.length,
      ledger_total: ledgerTotal,
      admin_operations: Object.keys(this.state.adminOperations).length,
      requests: Object.keys(this.state.requests).length,
    }
  }

  reconcileUserLedger(userID, orgID, { tokenFingerprint, source, reason }) {
    const user = this.state.users[userID]
    if (!user) return undefined
    const ledgerTotal = this.state.ledger
      .filter((row) => row.userId === userID)
      .reduce((sum, row) => sum + Number(row.amount || 0), 0)
    const adjustment = user.balance - ledgerTotal
    if (!adjustment) return undefined
    const row = {
      id: randomUUID(),
      type: adjustment > 0 ? "credit" : "ledger_adjustment",
      userId: userID,
      orgId: orgID,
      tokenFingerprint,
      amount: adjustment,
      balanceAfter: user.balance,
      source,
      reason,
      createdAt: new Date().toISOString(),
    }
    this.state.ledger.push(row)
    return row
  }
}

export class PostgresGatewayState extends GatewayState {
  constructor(pool, snapshotID = "default") {
    super(`postgres:gateway_state/${snapshotID}`)
    this.pool = pool
    this.snapshotID = snapshotID
    this.backend = "postgres"
    this.description = `postgres:gateway_state/${snapshotID}`
  }

  static async open({ databaseUrl, seedSpec, snapshotID = "default", autoMigrate = true, ssl }) {
    if (!databaseUrl) {
      const error = new Error("DATABASE_URL is required when YOURSERVICE_STATE_BACKEND=postgres.")
      error.code = "missing_database_url"
      throw error
    }
    const { default: pg } = await import("pg")
    const { Pool } = pg
    const pool = new Pool({
      connectionString: databaseUrl,
      ssl,
      max: positiveIntegerFromEnv(process.env.YOURSERVICE_POSTGRES_POOL_MAX, 5),
    })
    const store = new PostgresGatewayState(pool, snapshotID)
    if (autoMigrate) await store.migrate()
    await store.load()
    store.seed(seedSpec)
    await store.save()
    return store
  }

  async migrate() {
    await this.pool.query(`
      create table if not exists gateway_state (
        id text primary key,
        state jsonb not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `)
  }

  async load() {
    const result = await this.pool.query("select state from gateway_state where id = $1", [this.snapshotID])
    const row = result.rows[0]
    if (!row) {
      this.state = structuredClone(DEFAULT_STATE)
      return
    }
    const loaded = typeof row.state === "string" ? JSON.parse(row.state) : row.state
    this.state = { ...structuredClone(DEFAULT_STATE), ...loaded }
  }

  async save() {
    const snapshot = JSON.stringify(this.state)
    const write = this.saveChain.catch(() => undefined).then(() => this.writeSnapshot(snapshot))
    this.saveChain = write
    return write
  }

  async writeSnapshot(snapshot) {
    await this.pool.query(
      `
        insert into gateway_state (id, state, updated_at)
        values ($1, $2::jsonb, now())
        on conflict (id) do update
          set state = excluded.state,
              updated_at = now()
      `,
      [this.snapshotID, snapshot],
    )
  }

  async close() {
    await this.pool.end()
  }
}

export async function openGatewayState({ backend = "json", filePath, seedSpec, databaseUrl, env = process.env }) {
  const normalized = String(backend || "json").toLowerCase()
  if (normalized === "json") return GatewayState.open(filePath, seedSpec)
  if (normalized === "postgres" || normalized === "postgresql" || normalized === "pg") {
    return PostgresGatewayState.open({
      databaseUrl,
      seedSpec,
      snapshotID: env.YOURSERVICE_POSTGRES_SNAPSHOT_ID || "default",
      autoMigrate: env.YOURSERVICE_POSTGRES_AUTO_MIGRATE !== "false",
      ssl: postgresSslFromEnv(env),
    })
  }
  const error = new Error(`Unsupported YOURSERVICE_STATE_BACKEND '${backend}'. Use 'json' or 'postgres'.`)
  error.code = "unsupported_state_backend"
  throw error
}

function postgresSslFromEnv(env) {
  const mode = String(env.YOURSERVICE_POSTGRES_SSL || "").toLowerCase()
  if (!mode) return undefined
  if (["false", "0", "disable", "disabled"].includes(mode)) return false
  if (["true", "1", "require", "required"].includes(mode)) return { rejectUnauthorized: false }
  if (["verify-full", "verify_ca", "verify-ca"].includes(mode)) return { rejectUnauthorized: true }
  return undefined
}

function randomUserCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  let value = ""
  for (let i = 0; i < 8; i++) value += alphabet[Math.floor(Math.random() * alphabet.length)]
  return `${value.slice(0, 4)}-${value.slice(4)}`
}

function normalizeUserCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}

function countBy(items, keyFn) {
  const counts = {}
  for (const item of items) {
    const key = String(keyFn(item) || "unknown")
    counts[key] = (counts[key] || 0) + 1
  }
  return counts
}

function normalizeCreditAmount(value, fallback) {
  const amount = Number(value)
  if (Number.isSafeInteger(amount) && amount > 0) return amount
  if (fallback !== undefined) return fallback
  const error = new Error("Credit amount must be a positive safe integer.")
  error.statusCode = 400
  throw error
}

function normalizeSeedBalance(value, fallback) {
  const amount = Number(value)
  if (Number.isSafeInteger(amount) && amount >= 0) return amount
  return fallback
}

function positiveIntegerFromEnv(value, fallback) {
  const amount = Number(value)
  if (Number.isSafeInteger(amount) && amount > 0) return amount
  return fallback
}

function fingerprintToken(token) {
  return createHash("sha256").update(String(token)).digest("hex").slice(0, 16)
}
