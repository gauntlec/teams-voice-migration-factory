-- Monitoring alert sources (docs/INTAKE.md): a tool that posts alerts for one customer, with its own token. An alert becomes
-- (or updates) an incident, de-duplicated by the key the tool sends.
CREATE TABLE platform.intake_sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'generic' CHECK (kind IN ('generic', 'sbc', 'teams_health', 'cqd', 'microsoft_health')),
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Only a SHA-256 of the secret is kept; the token is shown once.
  secret_hash text NOT NULL,
  last4       text NOT NULL,
  ip_allow    text[] NOT NULL DEFAULT '{}',
  enabled     boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  alerts_received integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX intake_sources_name_uq ON platform.intake_sources (tenant_id, lower(name));
