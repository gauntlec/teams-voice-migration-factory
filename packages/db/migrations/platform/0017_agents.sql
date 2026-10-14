-- AI agents as first-class workers on incidents (docs/INCIDENT-MANAGEMENT.md, section 7).
-- An agent has its own identity, hashed tokens, a per-customer autonomy policy and an
-- events feed; everything it does is attributed to it and audited. Nothing here is a
-- user account: an agent can never reach user, tenant or billing endpoints.

CREATE TABLE platform.agents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- What it is for; informs the default autonomy and how it is shown, nothing more.
  kind        text NOT NULL DEFAULT 'general' CHECK (kind IN ('triage', 'diagnostic', 'resolver', 'comms', 'monitor', 'general')),
  -- The MSP that runs it (null = Voxshift itself).
  msp_id      uuid REFERENCES platform.msps(id) ON DELETE SET NULL,
  -- paused: finishes nothing new (every write refused); disabled: tokens stop working.
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  -- Free text for people ("Claude Sonnet 5.5 via the triage runbook"); not trusted for anything.
  model_label text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);
CREATE UNIQUE INDEX agents_name_uq ON platform.agents (lower(name));

-- Bearer tokens, shown once and stored only as a SHA-256 of the secret.
CREATE TABLE platform.agent_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    uuid NOT NULL REFERENCES platform.agents(id) ON DELETE CASCADE,
  name        text NOT NULL,
  last4       text NOT NULL,
  secret_hash text NOT NULL,
  -- Coarse endpoint groups: read, note, propose, act. What it may actually do is the autonomy policy.
  scopes      text[] NOT NULL DEFAULT '{read,note,propose}',
  -- When set, only these source addresses may use the token.
  ip_allow    text[] NOT NULL DEFAULT '{}',
  expires_at  timestamptz,
  last_used_at timestamptz,
  revoked_at  timestamptz,
  created_by  uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_tokens_agent_idx ON platform.agent_tokens (agent_id);

-- Which customers an agent may work on, and how far it may go there, per action class
-- (0 observe, 1 suggest, 2 act with approval, 3 act alone). A customer with no row is off limits.
CREATE TABLE platform.agent_customer_policy (
  agent_id   uuid NOT NULL REFERENCES platform.agents(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  enabled    boolean NOT NULL DEFAULT true,
  autonomy   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, tenant_id)
);

-- Kill switches: every agent on one customer, and every agent everywhere.
ALTER TABLE platform.tenants ADD COLUMN agents_enabled boolean NOT NULL DEFAULT true;
CREATE TABLE platform.agent_kill_switch (
  id           smallint PRIMARY KEY CHECK (id = 1),
  all_disabled boolean NOT NULL DEFAULT false,
  note         text,
  changed_by   uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  changed_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform.agent_kill_switch (id, all_disabled) VALUES (1, false);

-- The events feed: what happened on incidents, for agents to poll (GET /events?after=<id>)
-- or have pushed to a webhook. agent_id set = for that agent only (e.g. "your claim was revoked").
-- The payload is small on purpose: an agent reads the incident for the detail.
CREATE TABLE platform.agent_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  incident_id uuid,
  kind        text NOT NULL,
  agent_id    uuid REFERENCES platform.agents(id) ON DELETE CASCADE,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_events_tenant_idx ON platform.agent_events (tenant_id, id);
CREATE INDEX agent_events_agent_idx ON platform.agent_events (agent_id, id) WHERE agent_id IS NOT NULL;
CREATE INDEX agent_events_created_idx ON platform.agent_events (created_at);

-- Signed webhooks: the worker POSTs new events (at least once, with retries). The signing
-- secret is stored encrypted and shown once.
CREATE TABLE platform.agent_webhooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    uuid NOT NULL REFERENCES platform.agents(id) ON DELETE CASCADE,
  url         text NOT NULL,
  secret_enc  text NOT NULL,
  -- Event kinds wanted; empty = all.
  kinds       text[] NOT NULL DEFAULT '{}',
  active      boolean NOT NULL DEFAULT true,
  -- The last event id delivered.
  cursor      bigint NOT NULL DEFAULT 0,
  failures    integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status text,
  last_delivery_at timestamptz,
  created_by  uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_webhooks_due_idx ON platform.agent_webhooks (next_attempt_at) WHERE active;

-- Idempotency for agent writes: the same key from the same agent does the thing once and
-- returns the same answer.
CREATE TABLE platform.agent_requests (
  agent_id   uuid NOT NULL REFERENCES platform.agents(id) ON DELETE CASCADE,
  idem_key   text NOT NULL,
  status     text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done')),
  response   jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, idem_key)
);
CREATE INDEX agent_requests_created_idx ON platform.agent_requests (created_at);
