-- Wires up build_call_queues/build_auto_attendants, which existed since
-- 0001_init but were never given a site_id or any route - 100% dead code
-- until now, so no defensive backfill is needed (no rows could ever have
-- been created through the app). Adds:
--
-- 1. site_id + discovery_resource_account_id on both, same shape as
--    build_resource_accounts (0016_build_site_scope.sql) - a build_* row is
--    always reached through a site workspace, and discovery_resource_account_id
--    makes "Populate from Discovery" idempotent the same way.
-- 2. Real Set-CsCallQueue-shaped columns on build_call_queues, replacing its
--    vague `config` jsonb catch-all.
-- 3. Descriptive-only columns on build_auto_attendants, mirroring
--    discovery_resource_accounts' narrative fields (business_hours,
--    ooh_action, holiday, advanced_features) - no cmdlet authoring for AA
--    yet, this just stops Populate from silently discarding them.

DELETE FROM {{SCHEMA}}.build_call_queues;
DELETE FROM {{SCHEMA}}.build_auto_attendants;

ALTER TABLE {{SCHEMA}}.build_call_queues
  ADD COLUMN site_id uuid REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE CASCADE,
  ADD COLUMN discovery_resource_account_id uuid REFERENCES {{SCHEMA}}.discovery_resource_accounts(id) ON DELETE SET NULL,
  ADD COLUMN routing_method text NOT NULL DEFAULT 'Attendant'
    CHECK (routing_method IN ('Attendant', 'Serial', 'RoundRobin', 'LongestIdle')),
  ADD COLUMN agent_alert_time smallint NOT NULL DEFAULT 30 CHECK (agent_alert_time BETWEEN 15 AND 180),
  ADD COLUMN presence_based_routing boolean NOT NULL DEFAULT true,
  ADD COLUMN agents jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN overflow jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN timeout jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN language_id text,
  ADD COLUMN notes text,
  DROP COLUMN config;

ALTER TABLE {{SCHEMA}}.build_call_queues ALTER COLUMN site_id SET NOT NULL;
CREATE INDEX idx_build_call_queues_site ON {{SCHEMA}}.build_call_queues(site_id);

ALTER TABLE {{SCHEMA}}.build_auto_attendants
  ADD COLUMN site_id uuid REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE CASCADE,
  ADD COLUMN discovery_resource_account_id uuid REFERENCES {{SCHEMA}}.discovery_resource_accounts(id) ON DELETE SET NULL,
  ADD COLUMN business_hours text,
  ADD COLUMN ooh_action text,
  ADD COLUMN holiday text,
  ADD COLUMN advanced_features text,
  ADD COLUMN notes text;

ALTER TABLE {{SCHEMA}}.build_auto_attendants ALTER COLUMN site_id SET NOT NULL;
CREATE INDEX idx_build_auto_attendants_site ON {{SCHEMA}}.build_auto_attendants(site_id);
