-- A Call flows row created from a discovered auto attendant or call queue remembers which discovered object it came from, so it is
-- matched on that and never on a name that can repeat, is only made once per voice app, and can be told apart from a wizard capture.
ALTER TABLE {{SCHEMA}}.discovery_flows ADD COLUMN tenant_object_id uuid REFERENCES {{SCHEMA}}.tenant_objects(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX discovery_flows_tenant_object_idx ON {{SCHEMA}}.discovery_flows (tenant_object_id) WHERE tenant_object_id IS NOT NULL;
