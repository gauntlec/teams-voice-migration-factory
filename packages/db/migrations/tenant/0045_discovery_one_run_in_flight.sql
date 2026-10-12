-- One discovery run (sync or Validate check) in flight per customer. The API
-- checked for an in-flight run and then inserted, so two quick starts (or a
-- start and a Validate click) could both get through and run on the same
-- PowerShell session - and a Validate check marking users seen mid-sync can
-- make the sync mark them removed. The index makes the second insert fail.
--
-- Any extra in-flight rows today are leftovers; keep the newest.
UPDATE {{SCHEMA}}.tenant_discovery_runs r
   SET status = 'failed',
       finished_at = now(),
       error = 'Superseded by a newer run.'
 WHERE r.status IN ('queued', 'running')
   AND r.id <> (SELECT x.id FROM {{SCHEMA}}.tenant_discovery_runs x
                 WHERE x.status IN ('queued', 'running')
                 ORDER BY x.created_at DESC LIMIT 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_discovery_runs_one_in_flight
  ON {{SCHEMA}}.tenant_discovery_runs ((true))
  WHERE status IN ('queued', 'running');
