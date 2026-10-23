-- The discovered resource accounts that belong to one Data Collection resource account / voice app record. An auto attendant or call
-- queue can have several resource accounts (each its own UPN and number); the record holds them all, and Design & Build makes one
-- resource account row per member. Each discovered resource account belongs to at most one record.
CREATE TABLE {{SCHEMA}}.discovery_resource_account_members (
  resource_account_id uuid NOT NULL REFERENCES {{SCHEMA}}.discovery_resource_accounts(id) ON DELETE CASCADE,
  tenant_object_id    uuid NOT NULL REFERENCES {{SCHEMA}}.tenant_objects(id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_account_id, tenant_object_id)
);
CREATE UNIQUE INDEX discovery_ra_members_object_idx ON {{SCHEMA}}.discovery_resource_account_members (tenant_object_id);
