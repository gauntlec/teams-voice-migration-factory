-- Per-customer Discovery settings. One row per tenant schema, seeded here.

CREATE TABLE {{SCHEMA}}.tenant_discovery_config (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- when true (default), a discovery run stores only User accounts licensed for
  -- Teams; small customers can turn this off so every enabled user is stored.
  filter_users boolean NOT NULL DEFAULT true,
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO {{SCHEMA}}.tenant_discovery_config DEFAULT VALUES;
