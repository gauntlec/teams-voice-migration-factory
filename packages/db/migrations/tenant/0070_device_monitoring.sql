-- Device status (docs/DEVICE-MONITORING.md): the worker reads an Uptime Kuma status page on the customer's own network and keeps
-- what it sees here. Voxshift never writes to Kuma; engineers tag each Kuma monitor site=<sitecode> and device=<kind>.

-- One row: where the customer's Kuma status page is. enabled = false until an engineer switches it on.
CREATE TABLE {{SCHEMA}}.device_monitor_settings (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled        boolean NOT NULL DEFAULT false,
  kuma_url       text,                       -- http(s)://host:port, no path
  status_slug    text,                       -- the status page's address name in Kuma
  last_polled_at timestamptz,
  last_ok_at     timestamptz,
  last_error     text
);
INSERT INTO {{SCHEMA}}.device_monitor_settings DEFAULT VALUES;

-- The current state of each monitor on the status page.
CREATE TABLE {{SCHEMA}}.device_monitors (
  kuma_id      integer PRIMARY KEY,
  name         text NOT NULL,
  monitor_type text NOT NULL DEFAULT '',
  group_name   text,
  sitecode     text,                         -- from the site= tag; null = no site tag
  device_kind  text NOT NULL DEFAULT 'other',
  state        text NOT NULL CHECK (state IN ('up', 'down', 'pending', 'maintenance', 'unknown')),
  since        timestamptz NOT NULL,         -- when it entered this state, or the oldest beat Kuma still holds
  since_exact  boolean NOT NULL DEFAULT true, -- false: it has been in this state at least this long (seen on first look)
  last_beat_at timestamptz,
  response_ms  numeric,
  message      text NOT NULL DEFAULT '',
  uptime_24h   numeric,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_monitors_site_idx ON {{SCHEMA}}.device_monitors (sitecode);

-- Every change of state Voxshift saw, kept 90 days: Kuma itself only holds the last 100 beats.
CREATE TABLE {{SCHEMA}}.device_status_changes (
  id         bigserial PRIMARY KEY,
  kuma_id    integer NOT NULL,
  name       text NOT NULL,
  sitecode   text,
  device_kind text NOT NULL DEFAULT 'other',
  from_state text,
  to_state   text NOT NULL,
  at         timestamptz NOT NULL,
  message    text NOT NULL DEFAULT ''
);
CREATE INDEX device_status_changes_at_idx ON {{SCHEMA}}.device_status_changes (at DESC);
