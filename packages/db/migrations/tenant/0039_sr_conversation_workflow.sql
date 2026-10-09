-- Managed Services, phase 1: conversation and a more flexible workflow.
--
-- * 'declined': the team won't do the request (with a reason). Like
--   'cancelled' it is closed; unlike it, it's the team's decision.
-- * Send back (Designed & built -> Planned) and reopen (Deployed -> Planned,
--   within 14 days) reuse 'planned'; reopened_at records the last reopen.
-- * Waiting on customer: waiting_since is set while the team waits for the
--   customer's reply. waiting_seconds totals the time spent waiting (excluded
--   from response/resolution targets); waiting_reminded_at / waiting_reminders
--   drive the reminder email (worker).
-- * first_response_at: the team's first reply, move or question - the
--   response target is measured to it.
ALTER TABLE {{SCHEMA}}.service_requests DROP CONSTRAINT IF EXISTS service_requests_status_check;
ALTER TABLE {{SCHEMA}}.service_requests
  ADD CONSTRAINT service_requests_status_check CHECK (status IN ('new', 'planned', 'built', 'deployed', 'cancelled', 'declined'));
ALTER TABLE {{SCHEMA}}.service_requests
  ADD COLUMN declined_at timestamptz,
  ADD COLUMN reopened_at timestamptz,
  ADD COLUMN waiting_since timestamptz,
  ADD COLUMN waiting_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN waiting_reminded_at timestamptz,
  ADD COLUMN waiting_reminders integer NOT NULL DEFAULT 0,
  ADD COLUMN first_response_at timestamptz;
CREATE INDEX service_requests_waiting_idx ON {{SCHEMA}}.service_requests (waiting_since) WHERE waiting_since IS NOT NULL;

-- 'waiting': the team asked the customer something and is waiting for the
-- reply (public, the question is the body). 'resumed': no longer waiting.
ALTER TABLE {{SCHEMA}}.service_request_events DROP CONSTRAINT IF EXISTS service_request_events_kind_check;
ALTER TABLE {{SCHEMA}}.service_request_events
  ADD CONSTRAINT service_request_events_kind_check
  CHECK (kind IN ('created', 'status_changed', 'assigned', 'comment', 'build_drafted', 'deployment', 'waiting', 'resumed'));
