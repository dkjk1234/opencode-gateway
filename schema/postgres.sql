-- Production database target for replacing the local JSON state file.
-- The gateway can run with YOURSERVICE_STATE_BACKEND=postgres today via the
-- gateway_state snapshot table below. The normalized tables define the durable
-- contract for the OAuth, billing, token, device, idempotency, and credit-ledger
-- paths as the service graduates from snapshot persistence to row-level writes.

create table if not exists gateway_state (
  id text primary key,
  state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists users (
  id text primary key,
  email text not null,
  name text,
  default_org_id text not null,
  balance bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists orgs (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists org_users (
  org_id text not null references orgs(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table if not exists external_identities (
  provider text not null,
  subject text not null,
  user_id text not null references users(id) on delete cascade,
  org_id text not null references orgs(id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, subject)
);

create table if not exists access_tokens (
  token_fingerprint text primary key,
  user_id text not null references users(id) on delete cascade,
  org_id text not null references orgs(id) on delete cascade,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists refresh_tokens (
  token_fingerprint text primary key,
  user_id text not null references users(id) on delete cascade,
  org_id text not null references orgs(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists device_codes (
  device_code text primary key,
  user_code text unique not null,
  client_id text not null,
  status text not null,
  user_id text references users(id) on delete set null,
  org_id text references orgs(id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

create table if not exists oauth_states (
  state text primary key,
  provider text not null,
  user_code text not null,
  code_verifier text not null,
  redirect_uri text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists ledger (
  id uuid primary key,
  type text not null,
  user_id text not null references users(id) on delete cascade,
  org_id text not null references orgs(id) on delete cascade,
  amount bigint not null,
  balance_after bigint not null,
  source text,
  reason text,
  request jsonb,
  created_at timestamptz not null default now()
);

create table if not exists idempotency_keys (
  key text primary key,
  user_id text references users(id) on delete cascade,
  org_id text references orgs(id) on delete cascade,
  request_fingerprint text,
  response jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists billing_events (
  id text primary key,
  provider text not null default 'stripe',
  status text not null,
  ledger_id uuid references ledger(id) on delete set null,
  payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
