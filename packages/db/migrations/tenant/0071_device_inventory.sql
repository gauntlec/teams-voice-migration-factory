-- Device status, phase 2 (docs/DEVICE-MONITORING.md): the devices a customer wants watched are kept here, and the worker keeps Uptime Kuma in step
-- with them (so nobody has to open Kuma). "Managed" = Voxshift looks after Kuma for this customer: it creates Kuma's administrator on first start
-- (its password is generated here and kept encrypted, like the other secrets) and owns the status page it reads back.
ALTER TABLE {{SCHEMA}}.device_monitor_settings
  ADD COLUMN managed             boolean NOT NULL DEFAULT false,
  ADD COLUMN kuma_admin_user     text,
  ADD COLUMN kuma_admin_pass_enc text,                           -- AES-256-GCM with DATA_ENCRYPTION_KEY (apps/api/src/common/crypto.ts)
  ADD COLUMN sync_needed         boolean NOT NULL DEFAULT false, -- the inventory changed since the last successful sync
  ADD COLUMN last_sync_at        timestamptz,
  ADD COLUMN last_sync_error     text;

CREATE TABLE {{SCHEMA}}.device_inventory (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_code       text NOT NULL,
  name            text NOT NULL,
  kind            text NOT NULL DEFAULT 'other',
  check_type      text NOT NULL CHECK (check_type IN ('ping', 'port')),
  address         text NOT NULL,
  port            integer CHECK (port IS NULL OR (port BETWEEN 1 AND 65535)),
  kuma_monitor_id integer,                                       -- the monitor Voxshift made in Kuma for this device
  sync_state      text NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending', 'synced', 'error')),
  sync_error      text,
  removed         boolean NOT NULL DEFAULT false,                -- taken off the list; the row goes when its Kuma monitor has been deleted
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_inventory_site_idx ON {{SCHEMA}}.device_inventory (site_code);
