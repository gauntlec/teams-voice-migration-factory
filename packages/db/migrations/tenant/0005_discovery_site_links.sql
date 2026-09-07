-- Link the remaining discovery entities to a site so a "site contact" (a
-- CUSTOMER user whose membership is limited to specific sites) sees and edits
-- only their site's rows. Nullable: existing rows stay unassigned and remain
-- visible to whole-customer users until someone sets a site. ON DELETE SET NULL
-- so removing a site never deletes discovery data.

ALTER TABLE {{SCHEMA}}.discovery_users
  ADD COLUMN site_id uuid REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE SET NULL;
ALTER TABLE {{SCHEMA}}.discovery_caps
  ADD COLUMN site_id uuid REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE SET NULL;
ALTER TABLE {{SCHEMA}}.discovery_resource_accounts
  ADD COLUMN site_id uuid REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE SET NULL;
ALTER TABLE {{SCHEMA}}.discovery_network
  ADD COLUMN site_id uuid REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE SET NULL;
ALTER TABLE {{SCHEMA}}.discovery_flows
  ADD COLUMN site_id uuid REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE SET NULL;

CREATE INDEX idx_discovery_users_site ON {{SCHEMA}}.discovery_users(site_id);
CREATE INDEX idx_discovery_caps_site ON {{SCHEMA}}.discovery_caps(site_id);
CREATE INDEX idx_discovery_ra_site ON {{SCHEMA}}.discovery_resource_accounts(site_id);
CREATE INDEX idx_discovery_network_site ON {{SCHEMA}}.discovery_network(site_id);
CREATE INDEX idx_discovery_flows_site ON {{SCHEMA}}.discovery_flows(site_id);
