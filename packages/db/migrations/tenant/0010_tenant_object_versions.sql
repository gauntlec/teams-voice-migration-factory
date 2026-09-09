-- Discovery, round 2: selective sync + version history.
--
--  * A run can now cover part of the tenant. `tenant_discovery_runs.scope_types`
--    lists the object types it discovered; NULL means a full run (every step).
--    Tombstoning only touches the types a run actually covered, so a
--    "users only" run never removes policies.
--
--  * Every time a discovered object's `data` actually changes between runs we
--    keep a row in `tenant_object_versions` with the before and after and the
--    list of top-level fields that differ. This gives a per-item timeline and a
--    per-run changelog ("what changed in this sync"). `content_changed_at` on
--    `tenant_objects` is when the data last changed (vs `discovered_at` = last
--    seen).
--
-- See docs/DISCOVERY.md.

ALTER TABLE {{SCHEMA}}.tenant_discovery_runs
  ADD COLUMN scope_types text[];

ALTER TABLE {{SCHEMA}}.tenant_objects
  ADD COLUMN content_changed_at timestamptz;

CREATE TABLE {{SCHEMA}}.tenant_object_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id      uuid NOT NULL REFERENCES {{SCHEMA}}.tenant_objects(id) ON DELETE CASCADE,
  run_id         uuid REFERENCES {{SCHEMA}}.tenant_discovery_runs(id) ON DELETE SET NULL,
  -- denormalised so the per-run changelog is a single-table scan and a
  -- since-removed object still shows what it was
  object_type    text NOT NULL,
  object_key     text NOT NULL,
  display_name   text,
  change_kind    text NOT NULL CHECK (change_kind IN ('added', 'updated', 'removed', 'readded')),
  changed_fields text[] NOT NULL DEFAULT '{}',
  before         jsonb,
  after          jsonb,
  changed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tenant_object_versions_object ON {{SCHEMA}}.tenant_object_versions (object_id, changed_at DESC);
CREATE INDEX idx_tenant_object_versions_run ON {{SCHEMA}}.tenant_object_versions (run_id, object_type);
