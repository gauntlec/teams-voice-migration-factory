-- Design & Build's "Validate against tenant" starts a narrow, users-only run
-- for a handful of UPNs. Those rows looked exactly like a partial "users" sync,
-- so the Discovery page's "Latest discovery run" card and the Changes tab's
-- default run showed a tiny validate check instead of the last real sync.
-- 'sync' = a discovery started from the Discovery page (full or partial);
-- 'targeted' = a Validate check. Existing rows are all treated as syncs.
ALTER TABLE {{SCHEMA}}.tenant_discovery_runs
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'sync'
    CHECK (kind IN ('sync','targeted'));
