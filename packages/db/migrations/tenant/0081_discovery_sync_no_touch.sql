-- Discovery sync writes nothing for what has not changed (docs/DISCOVERY.md "How a sync stores what it reads").
-- A hash of what a user's tenant_users row was projected from, so an unchanged user is not rewritten, and a change to the projection
-- itself still reaches every user.
ALTER TABLE {{SCHEMA}}.tenant_users ADD COLUMN IF NOT EXISTS projection_hash text;
-- When each object type was last read in full. An unchanged object is no longer written just to record that it was seen, so "Last seen"
-- is the later of its own discovered_at and this.
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.tenant_object_sweeps (
  object_type text PRIMARY KEY,
  run_id      uuid REFERENCES {{SCHEMA}}.tenant_discovery_runs(id) ON DELETE SET NULL,
  swept_at    timestamptz NOT NULL
);
-- A sync rewrites far fewer rows now; the default page fill is fine again.
ALTER TABLE {{SCHEMA}}.tenant_objects RESET (fillfactor);
ALTER TABLE {{SCHEMA}}.tenant_users RESET (fillfactor);
