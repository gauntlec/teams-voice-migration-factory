-- Discovery: a point-in-time inventory of the customer's live Microsoft 365 /
-- Teams tenant, gathered by the worker over an engineer's device-code sign-in
-- (MicrosoftTeams PowerShell module). Stored as one current snapshot per object
-- (JSONB) plus "hot" projections for users and policies that other modules
-- (Data Collection autofill, Design & Build policy pickers) read directly.
-- No customer credentials are stored here - only the discovered configuration.
-- See docs/DISCOVERY.md.

CREATE TABLE {{SCHEMA}}.tenant_discovery_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid REFERENCES {{SCHEMA}}.connections(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','completed','failed')),
  started_by    uuid NOT NULL,
  started_at    timestamptz,
  finished_at   timestamptz,
  -- {step, completed[], counts{type:n}, errors[{step,message}]}
  progress      jsonb NOT NULL DEFAULT '{"step":null,"completed":[],"counts":{},"errors":[]}'::jsonb,
  summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tenant_discovery_runs_created ON {{SCHEMA}}.tenant_discovery_runs(created_at DESC);

-- One row per discovered object: the current snapshot. Re-running discovery
-- upserts on (object_type, object_key); objects that vanish from the tenant are
-- tombstoned with removed_at (kept for history, hidden by default).
CREATE TABLE {{SCHEMA}}.tenant_objects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type       text NOT NULL,
  object_key        text NOT NULL,
  display_name      text,
  data              jsonb NOT NULL,
  -- full-text over name + key + the raw JSON (capped so huge objects stay indexable)
  search            tsvector GENERATED ALWAYS AS (
                      to_tsvector('simple',
                        coalesce(display_name, '') || ' ' || object_key || ' ' || left(data::text, 20000))
                    ) STORED,
  first_seen_run_id uuid REFERENCES {{SCHEMA}}.tenant_discovery_runs(id) ON DELETE SET NULL,
  last_seen_run_id  uuid REFERENCES {{SCHEMA}}.tenant_discovery_runs(id) ON DELETE SET NULL,
  discovered_at     timestamptz NOT NULL DEFAULT now(),
  removed_at        timestamptz,
  UNIQUE (object_type, object_key)
);
CREATE INDEX idx_tenant_objects_type_live ON {{SCHEMA}}.tenant_objects(object_type, removed_at);
CREATE INDEX idx_tenant_objects_data ON {{SCHEMA}}.tenant_objects USING gin (data jsonb_path_ops);
CREATE INDEX idx_tenant_objects_search ON {{SCHEMA}}.tenant_objects USING gin (search);

-- Hot projection of users (from Get-CsOnlineUser) for lists, lookups and autofill.
CREATE TABLE {{SCHEMA}}.tenant_users (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id                    uuid NOT NULL UNIQUE REFERENCES {{SCHEMA}}.tenant_objects(id) ON DELETE CASCADE,
  upn                          text NOT NULL,
  entra_id                     text,
  display_name                 text,
  account_type                 text,
  account_enabled              boolean,
  enterprise_voice_enabled     boolean NOT NULL DEFAULT false,
  line_uri                     text,
  telephone_numbers            jsonb NOT NULL DEFAULT '[]'::jsonb,
  feature_types                text[] NOT NULL DEFAULT '{}',
  assigned_plans               jsonb NOT NULL DEFAULT '[]'::jsonb,
  usage_location               text,
  department                   text,
  job_title                    text,
  interpreted_user_type        text,
  policies                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_policy_assignments jsonb NOT NULL DEFAULT '[]'::jsonb,
  when_changed                 timestamptz,
  last_seen_run_id             uuid REFERENCES {{SCHEMA}}.tenant_discovery_runs(id) ON DELETE SET NULL,
  removed_at                   timestamptz
);
CREATE UNIQUE INDEX idx_tenant_users_upn ON {{SCHEMA}}.tenant_users(lower(upn));
CREATE INDEX idx_tenant_users_live ON {{SCHEMA}}.tenant_users(removed_at, enterprise_voice_enabled);
CREATE INDEX idx_tenant_users_line_uri ON {{SCHEMA}}.tenant_users(line_uri);

-- Hot projection of policy definitions (one row per policy instance per type).
CREATE TABLE {{SCHEMA}}.tenant_policies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id        uuid NOT NULL UNIQUE REFERENCES {{SCHEMA}}.tenant_objects(id) ON DELETE CASCADE,
  policy_type      text NOT NULL,
  identity         text NOT NULL,
  name             text NOT NULL,
  is_global        boolean NOT NULL DEFAULT false,
  data             jsonb NOT NULL,
  last_seen_run_id uuid REFERENCES {{SCHEMA}}.tenant_discovery_runs(id) ON DELETE SET NULL,
  removed_at       timestamptz,
  UNIQUE (policy_type, identity)
);
CREATE INDEX idx_tenant_policies_type_live ON {{SCHEMA}}.tenant_policies(policy_type, removed_at);

-- Link a Data Collection user to the real tenant user (matched on lower(upn)).
ALTER TABLE {{SCHEMA}}.discovery_users
  ADD COLUMN tenant_user_id uuid REFERENCES {{SCHEMA}}.tenant_users(id) ON DELETE SET NULL;
CREATE INDEX idx_discovery_users_tenant_user ON {{SCHEMA}}.discovery_users(tenant_user_id);
