-- Drift: deployed Design & Build rows that no longer match the live tenant, worked out after each Discovery sync
-- (packages/db/src/drift.ts). One row per site, replaced on every check; the Deployment page reads the counts.
CREATE TABLE {{SCHEMA}}.deployment_drift (
  site_id       uuid PRIMARY KEY REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE CASCADE,
  drifted       integer NOT NULL DEFAULT 0,
  awaiting_sync integer NOT NULL DEFAULT 0,
  rows          jsonb NOT NULL DEFAULT '[]'::jsonb,
  run_id        uuid REFERENCES {{SCHEMA}}.tenant_discovery_runs(id) ON DELETE SET NULL,
  computed_at   timestamptz NOT NULL DEFAULT now()
);
