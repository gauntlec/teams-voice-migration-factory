-- Telephony discovery, aligned to the ATTC MS Teams Telephony Discovery
-- Template: customer-defined outbound calling policies, DID ranges that
-- generate an individual-number inventory, and users / CAPs / resource
-- accounts that each hold at most one number (resource accounts may hold
-- several). Every number belongs to exactly one holder or none.

-- ---------------------- Outbound Calling Policies ----------------------
CREATE TABLE {{SCHEMA}}.discovery_calling_policies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  description         text,
  allow_local         boolean NOT NULL DEFAULT true,
  allow_national      boolean NOT NULL DEFAULT false,
  allow_international  boolean NOT NULL DEFAULT false,
  allow_service       boolean NOT NULL DEFAULT true,
  allow_premium       boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_calling_policy_name ON {{SCHEMA}}.discovery_calling_policies(lower(name));

INSERT INTO {{SCHEMA}}.discovery_calling_policies
  (name, description, allow_local, allow_national, allow_international, allow_service, allow_premium)
VALUES
  ('Unrestricted', 'Unrestricted calling',        true, true,  true,  true, true),
  ('International', 'National + international',     true, true,  true,  true, false),
  ('National',     'National calling only',        true, true,  false, true, false),
  ('Local',        'Local area code calling only', true, false, false, true, false);

-- ------------------- DID ranges (LOA tracking added) ------------------
ALTER TABLE {{SCHEMA}}.discovery_number_ranges
  ADD COLUMN IF NOT EXISTS loa_sent      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS loa_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS comments      text;

-- ------------------------- Number inventory --------------------------
CREATE TABLE {{SCHEMA}}.phone_numbers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  range_id     uuid NOT NULL REFERENCES {{SCHEMA}}.discovery_number_ranges(id) ON DELETE RESTRICT,
  e164         text NOT NULL,
  status       text NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','assigned')),
  holder_type  text CHECK (holder_type IN ('user','cap','resource_account','analogue')),
  holder_id    uuid,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT holder_pair CHECK ((holder_type IS NULL) = (holder_id IS NULL)),
  CONSTRAINT assigned_iff_held CHECK ((status = 'assigned') = (holder_id IS NOT NULL))
);
CREATE UNIQUE INDEX idx_phone_e164 ON {{SCHEMA}}.phone_numbers(e164);
CREATE INDEX idx_phone_range ON {{SCHEMA}}.phone_numbers(range_id);
CREATE INDEX idx_phone_holder ON {{SCHEMA}}.phone_numbers(holder_type, holder_id);
-- One number per user / CAP / analogue device; resource accounts may hold many.
CREATE UNIQUE INDEX idx_phone_one_per_holder
  ON {{SCHEMA}}.phone_numbers(holder_type, holder_id)
  WHERE holder_id IS NOT NULL AND holder_type <> 'resource_account';

-- ------------------------------- Users ------------------------------
CREATE TABLE {{SCHEMA}}.discovery_users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upn                text NOT NULL,
  display_name       text,
  calling_policy_id  uuid REFERENCES {{SCHEMA}}.discovery_calling_policies(id) ON DELETE SET NULL,
  caller_id          text CHECK (caller_id IN ('user','anonymous','main_number')),
  voicemail_enabled  boolean NOT NULL DEFAULT true,
  voicemail_language text,
  requires_handset   boolean NOT NULL DEFAULT false,
  handset_model      text,
  access_port_id     text,
  comments           text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_discovery_user_upn ON {{SCHEMA}}.discovery_users(lower(upn));

-- -------------------------- Common Area Phones ----------------------
CREATE TABLE {{SCHEMA}}.discovery_caps (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name       text NOT NULL,
  upn                text,
  device_model       text,
  calling_policy_id  uuid REFERENCES {{SCHEMA}}.discovery_calling_policies(id) ON DELETE SET NULL,
  caller_id          text CHECK (caller_id IN ('user','anonymous','main_number')),
  access_port_id     text,
  comments           text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- --------------- Resource accounts (Virtual Numbers tab) ----------
CREATE TABLE {{SCHEMA}}.discovery_resource_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('auto_attendant','call_queue')),
  directory_entry       text,
  business_hours        text,
  who_answers           text,
  ooh_action            text,
  exception_conditions  text,
  exception_action      text,
  holiday               text,
  advanced_features     text,
  comments              text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
