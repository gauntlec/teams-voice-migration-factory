-- Per-customer schema. `{{SCHEMA}}` is replaced with tenant_<shortid> by the
-- migration runner. Nothing here references another tenant's schema.

-- ---------------------------- Data Collection ---------------------------
CREATE TABLE {{SCHEMA}}.discovery (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','accepted')),
  general      jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_by uuid,
  submitted_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE {{SCHEMA}}.discovery_sites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_code  text,
  name       text,
  address    text,
  country    text,
  region     text,
  paging     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE {{SCHEMA}}.discovery_number_ranges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  range_start text NOT NULL,
  range_end   text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('new','port','retain')),
  carrier     text,
  port_status text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE {{SCHEMA}}.discovery_network (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope        text NOT NULL CHECK (scope IN ('internal','external')),
  subnet       text NOT NULL,
  mask         integer,
  location     text,
  network_type text CHECK (network_type IN ('LAN','WLAN')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE {{SCHEMA}}.attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename     text NOT NULL,
  content_type text NOT NULL,
  bytes        bytea NOT NULL,
  uploaded_by  uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------ Design & Build -------------------------
CREATE TABLE {{SCHEMA}}.build_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upn            text NOT NULL,
  did            text,
  ext            text,
  e164           text,
  number_type    text,
  revoke_ev      boolean NOT NULL DEFAULT false,
  hold_uri       text,
  action         text,
  migration_wave text,
  policies       jsonb NOT NULL DEFAULT '{}'::jsonb,
  voicemail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  call_forwarding jsonb NOT NULL DEFAULT '{}'::jsonb,
  delegates      jsonb NOT NULL DEFAULT '[]'::jsonb,
  pickup_group   jsonb NOT NULL DEFAULT '{}'::jsonb,
  comments       text,
  validation     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors         text,
  hidden         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_build_users_upn ON {{SCHEMA}}.build_users(lower(upn));

CREATE TABLE {{SCHEMA}}.build_caps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upn            text NOT NULL,
  did            text,
  ext            text,
  e164           text,
  number_type    text,
  revoke_ev      boolean NOT NULL DEFAULT false,
  hold_uri       text,
  action         text,
  migration_wave text,
  policies       jsonb NOT NULL DEFAULT '{}'::jsonb,
  voicemail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  call_forwarding jsonb NOT NULL DEFAULT '{}'::jsonb,
  delegates      jsonb NOT NULL DEFAULT '[]'::jsonb,
  pickup_group   jsonb NOT NULL DEFAULT '{}'::jsonb,
  comments       text,
  validation     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors         text,
  hidden         boolean NOT NULL DEFAULT false,
  "function"     text,
  display_name   text,
  phone_model    text,
  device_config_profile text,
  mac_address    text,
  serial_number  text,
  phone_location text,
  lan_jack       text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_build_caps_upn ON {{SCHEMA}}.build_caps(lower(upn));

CREATE TABLE {{SCHEMA}}.build_resource_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upn            text NOT NULL,
  display_name   text,
  kind           text NOT NULL CHECK (kind IN ('auto_attendant','call_queue')),
  location_id    text,
  phone_number   text,
  number_type    text,
  application_id text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE {{SCHEMA}}.build_auto_attendants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  resource_accounts jsonb NOT NULL DEFAULT '[]'::jsonb,
  language          text,
  timezone          text,
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE {{SCHEMA}}.build_call_queues (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  resource_accounts jsonb NOT NULL DEFAULT '[]'::jsonb,
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE {{SCHEMA}}.build_m365_groups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  email              text,
  description        text,
  used_for_voicemail boolean NOT NULL DEFAULT false,
  owners             jsonb NOT NULL DEFAULT '[]'::jsonb,
  members            jsonb NOT NULL DEFAULT '[]'::jsonb,
  group_id           text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- --------------------------- Deployment & Audit -----------------------
-- NB: connections has NO token columns by design (docs/SECURITY.md).
CREATE TABLE {{SCHEMA}}.connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_by       uuid NOT NULL,
  method           text NOT NULL DEFAULT 'device_code' CHECK (method IN ('device_code')),
  status           text NOT NULL CHECK (status IN ('pending','active','expired','closed')),
  user_code        text,
  verification_uri text,
  tenant_domain    text,
  upn              text,
  scopes           text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz,
  closed_at        timestamptz
);

CREATE TABLE {{SCHEMA}}.deployments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid REFERENCES {{SCHEMA}}.connections(id) ON DELETE SET NULL,
  mode          text NOT NULL CHECK (mode IN ('dry_run','execute')),
  scope         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  created_by    uuid NOT NULL,
  started_at    timestamptz,
  finished_at   timestamptz,
  summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE {{SCHEMA}}.deployment_changes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id    uuid NOT NULL REFERENCES {{SCHEMA}}.deployments(id) ON DELETE CASCADE,
  seq              integer NOT NULL,
  at               timestamptz NOT NULL DEFAULT now(),
  operator_user_id uuid,
  correlation_id   text NOT NULL,
  object_type      text NOT NULL,
  object_id        text,
  cmdlet           text NOT NULL,
  parameters       jsonb NOT NULL DEFAULT '{}'::jsonb,
  before           jsonb NOT NULL DEFAULT '{}'::jsonb,
  after            jsonb NOT NULL DEFAULT '{}'::jsonb,
  result           text NOT NULL CHECK (result IN ('applied','skipped','failed','whatif')),
  message          text,
  UNIQUE (deployment_id, seq)
);
CREATE INDEX idx_changes_deployment ON {{SCHEMA}}.deployment_changes(deployment_id, seq);

CREATE TABLE {{SCHEMA}}.deployment_scripts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL REFERENCES {{SCHEMA}}.deployments(id) ON DELETE CASCADE,
  filename      text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('ps1','txt')),
  content       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------- Service Handover ------------------------
CREATE TABLE {{SCHEMA}}.handover_packs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version      integer NOT NULL,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued')),
  generated_by uuid NOT NULL,
  generated_at timestamptz,
  source       jsonb NOT NULL DEFAULT '{}'::jsonb,
  file         bytea,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE {{SCHEMA}}.handover_sections (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id uuid NOT NULL REFERENCES {{SCHEMA}}.handover_packs(id) ON DELETE CASCADE,
  key     text NOT NULL,
  title   text NOT NULL,
  ordinal integer NOT NULL,
  content jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- -------------------------------- Common -----------------------------
CREATE TABLE {{SCHEMA}}.audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at            timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_email   text,
  action        text NOT NULL,
  target_type   text,
  target_id     text,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_tenant_audit_at ON {{SCHEMA}}.audit_log(at DESC);

INSERT INTO {{SCHEMA}}.discovery (status) VALUES ('draft');
