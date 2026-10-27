-- SNMP checks for watched devices (docs/DEVICE-MONITORING.md). One OID is read with a GET and compared with an expected value, as Uptime Kuma's SNMP monitor does.
-- The port column carries the SNMP port (161 by default). The community string is a secret: it is kept encrypted (AES-256-GCM, DATA_ENCRYPTION_KEY) and never sent to a browser.
ALTER TABLE {{SCHEMA}}.device_inventory DROP CONSTRAINT IF EXISTS device_inventory_check_type_check;
ALTER TABLE {{SCHEMA}}.device_inventory
  ADD CONSTRAINT device_inventory_check_type_check CHECK (check_type IN ('ping', 'port', 'snmp')),
  ADD COLUMN snmp_version       text CHECK (snmp_version IS NULL OR snmp_version IN ('1', '2c', '3')),
  ADD COLUMN snmp_community_enc text,                      -- v1 / v2c
  ADD COLUMN snmp_username      text,                      -- v3 (Kuma supports noAuthNoPriv only: a user name and nothing else)
  ADD COLUMN snmp_oid           text,
  ADD COLUMN snmp_operator      text CHECK (snmp_operator IS NULL OR snmp_operator IN ('==', '!=', '>', '>=', '<', '<=', 'contains')),
  ADD COLUMN snmp_expected      text,
  ADD COLUMN kuma_snmp_user     text;                      -- the v3 user name last written to Kuma (Kuma cannot change it on an existing monitor, so a change recreates the monitor)
