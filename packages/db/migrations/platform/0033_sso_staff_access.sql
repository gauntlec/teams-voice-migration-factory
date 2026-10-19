-- Single sign-on, phase 3: customer-approved, time-limited access for Voxshift hub STAFF accounts (docs/SSO.md 4.3a).

-- Per installation, on the hub provider: may people with a hub STAFF account (Voxshift staff, the MSP's engineers) sign in?
--   allowed        - as before: a staff sign-in gets a session straight away (the default, so nothing changes)
--   needs_approval - a staff sign-in waits until an administrator of this installation approves it, for a time they choose; the session ends with that time
--   off            - staff sign-ins are refused
-- The customer's own people with hub accounts (kind 'customer') are not affected, nor are local accounts (including break-glass).
ALTER TABLE platform.sso_providers
  ADD COLUMN staff_access text NOT NULL DEFAULT 'allowed' CHECK (staff_access IN ('allowed', 'needs_approval', 'off'));

-- When an approved window ends for this person (null = no limit). Checked on every request made with a provider session, so access ends
-- exactly then, not at the next token refresh.
ALTER TABLE platform.external_identities ADD COLUMN access_until timestamptz;

-- A staff sign-in that waits for approval, and the window it is given. Nothing here lets anyone in by itself: a session is only started
-- from an approved request, by the browser that asked (its wait token), once.
CREATE TABLE platform.sso_access_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id        uuid NOT NULL REFERENCES platform.sso_providers(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  subject            text NOT NULL,
  email              text NOT NULL,
  display_name       text,
  -- what the hub asked for, and what the ceiling allows
  requested_role     text NOT NULL,
  effective_role     text NOT NULL,
  amr                text[] NOT NULL DEFAULT '{}',
  -- the hub's own session reference, when it sent one
  provider_session   text,
  ip                 text,
  user_agent         text,
  return_to          text NOT NULL DEFAULT '/',
  -- pending -> approved (a window) | denied | expired (nobody answered) | cancelled (the setting was changed)
  -- approved -> expired (the window ran out) | ended (an administrator ended it early) | cancelled
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'ended', 'cancelled')),
  -- only a hash: the browser that asked holds the token in a cookie
  wait_token_hash    text NOT NULL,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  -- nobody answered by then
  request_expires_at timestamptz NOT NULL,
  decided_by         uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  decided_at         timestamptz,
  decision_note      text,
  window_hours       integer CHECK (window_hours IS NULL OR window_hours BETWEEN 1 AND 24),
  window_starts_at   timestamptz,
  window_ends_at     timestamptz,
  -- the session was started from this approval (once)
  claimed_at         timestamptz,
  ended_at           timestamptz,
  ended_by           uuid REFERENCES platform.users(id) ON DELETE SET NULL
);
CREATE INDEX sso_access_requests_status ON platform.sso_access_requests (status, requested_at DESC);
CREATE INDEX sso_access_requests_user ON platform.sso_access_requests (user_id, requested_at DESC);
