-- Design & Build is organised per site, the same shape as Data Collection
-- (discovery_users/discovery_caps/discovery_resource_accounts all carry
-- site_id already). A build_* row is always reached through a site workspace,
-- so site_id is required here (not nullable, unlike the discovery_* tables).
-- discovery_user_id/discovery_cap_id/discovery_resource_account_id make the
-- "Populate from Discovery" bulk-seed idempotent (upsert on the source row).

ALTER TABLE {{SCHEMA}}.build_users
  ADD COLUMN site_id uuid REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE CASCADE,
  ADD COLUMN discovery_user_id uuid REFERENCES {{SCHEMA}}.discovery_users(id) ON DELETE SET NULL;

ALTER TABLE {{SCHEMA}}.build_caps
  ADD COLUMN site_id uuid REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE CASCADE,
  ADD COLUMN discovery_cap_id uuid REFERENCES {{SCHEMA}}.discovery_caps(id) ON DELETE SET NULL;

ALTER TABLE {{SCHEMA}}.build_resource_accounts
  ADD COLUMN site_id uuid REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE CASCADE,
  ADD COLUMN discovery_resource_account_id uuid REFERENCES {{SCHEMA}}.discovery_resource_accounts(id) ON DELETE SET NULL,
  ADD COLUMN voice_routing_policy text,
  ADD COLUMN status jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN errors text;

-- Backfill: any pre-existing rows (only possible in dev/demo data - no site_id
-- means "not reachable from any site workspace" once the NOT NULL lands) get
-- attached to the tenant's first site, or removed if there is none.
DO $$
DECLARE
  fallback_site uuid;
BEGIN
  SELECT id INTO fallback_site FROM {{SCHEMA}}.discovery_sites ORDER BY created_at LIMIT 1;
  IF fallback_site IS NOT NULL THEN
    UPDATE {{SCHEMA}}.build_users SET site_id = fallback_site WHERE site_id IS NULL;
    UPDATE {{SCHEMA}}.build_caps SET site_id = fallback_site WHERE site_id IS NULL;
    UPDATE {{SCHEMA}}.build_resource_accounts SET site_id = fallback_site WHERE site_id IS NULL;
  ELSE
    DELETE FROM {{SCHEMA}}.build_users WHERE site_id IS NULL;
    DELETE FROM {{SCHEMA}}.build_caps WHERE site_id IS NULL;
    DELETE FROM {{SCHEMA}}.build_resource_accounts WHERE site_id IS NULL;
  END IF;
END $$;

ALTER TABLE {{SCHEMA}}.build_users ALTER COLUMN site_id SET NOT NULL;
ALTER TABLE {{SCHEMA}}.build_caps ALTER COLUMN site_id SET NOT NULL;
ALTER TABLE {{SCHEMA}}.build_resource_accounts ALTER COLUMN site_id SET NOT NULL;

-- The uniqueness of a UPN is now per-site, not tenant-wide.
DROP INDEX IF EXISTS {{SCHEMA}}.idx_build_users_upn;
CREATE UNIQUE INDEX idx_build_users_site_upn ON {{SCHEMA}}.build_users(site_id, lower(upn));
DROP INDEX IF EXISTS {{SCHEMA}}.idx_build_caps_upn;
CREATE UNIQUE INDEX idx_build_caps_site_upn ON {{SCHEMA}}.build_caps(site_id, lower(upn));

CREATE INDEX idx_build_resource_accounts_site ON {{SCHEMA}}.build_resource_accounts(site_id);
