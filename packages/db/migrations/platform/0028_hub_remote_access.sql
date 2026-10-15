-- Remote access through a Voxshift Hub: the CUSTOMER's switch (off unless someone on this installation turns it on), and what the connector is doing.
-- While the switch is on, the worker keeps one outbound connection to the hub so staff the hub allows can open this installation there.
ALTER TABLE platform.app_settings
  ADD COLUMN IF NOT EXISTS hub_remote_access boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hub_tunnel_state text NOT NULL DEFAULT 'off' CHECK (hub_tunnel_state IN ('off', 'connecting', 'connected', 'error')),
  ADD COLUMN IF NOT EXISTS hub_tunnel_error text,
  ADD COLUMN IF NOT EXISTS hub_tunnel_at timestamptz;
