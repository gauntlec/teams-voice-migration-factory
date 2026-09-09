-- Optional VLAN ID for a network subnet row (Network / E911 tab).
ALTER TABLE {{SCHEMA}}.discovery_network ADD COLUMN vlan_id integer;
