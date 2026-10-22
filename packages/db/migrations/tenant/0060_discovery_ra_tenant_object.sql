-- Which exact discovered object a Data Collection resource account / voice app row was created from. Names can repeat (two
-- "Reception" attendants), so rows added from Discovery are matched on this id - never on the display name. For a resource
-- account row it is the resource account object; for an auto attendant or call queue row it is that voice app object.
-- Rows created before this column existed stay null and keep matching on name.
ALTER TABLE {{SCHEMA}}.discovery_resource_accounts ADD COLUMN tenant_object_id uuid REFERENCES {{SCHEMA}}.tenant_objects(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX discovery_resource_accounts_tenant_object_idx ON {{SCHEMA}}.discovery_resource_accounts (tenant_object_id) WHERE tenant_object_id IS NOT NULL;
