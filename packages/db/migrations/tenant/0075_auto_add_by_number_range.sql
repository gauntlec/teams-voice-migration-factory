-- Automatic adding by number range (Discovery > Settings): after each full discovery run, objects whose number is in a site's range
-- and that are on no site are added to that site's Data Collection. Off by default. See site-suggestions.ts and
-- apps/api/src/modules/tenant-discovery/auto-add-by-range.service.ts.
ALTER TABLE {{SCHEMA}}.tenant_discovery_config
  ADD COLUMN auto_add_by_number_range boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_add_last_run_id     uuid,         -- the run it last acted on, so a run is only handled once
  ADD COLUMN auto_add_last_at         timestamptz,
  ADD COLUMN auto_add_last_summary    jsonb;        -- {added: n, bySite: {sitecode: n}, skipped: n}
