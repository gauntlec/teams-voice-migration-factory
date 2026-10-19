-- Single sign-on, phase 3: the hub's revocation channel (docs/SSO.md 4.7 and 5.3).
-- The hub names people whose access ended in the reply to the heartbeat; the worker ends their sessions here and tells the hub the
-- highest line it applied.

-- The highest revocation line from the hub that has been applied (0 = none yet). Reset when the installation is pointed at a different hub.
ALTER TABLE platform.app_settings ADD COLUMN hub_sso_revocation_ack bigint NOT NULL DEFAULT 0;

-- Sign-ins through this identity that began before this moment are over, whatever access token they still hold (null = no cut-off).
-- Checked on every request made with a provider session, so a person removed at the hub is out at once, not at the next 15-minute refresh.
ALTER TABLE platform.external_identities ADD COLUMN revoked_before timestamptz;
