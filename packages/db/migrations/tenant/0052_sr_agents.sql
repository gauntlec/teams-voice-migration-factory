-- Assistants working service requests (docs/SERVICE-REQUEST-AGENTS.md): who holds a request, what they propose, and
-- the link between a request and the incident it came from. Mirrors incident_claims / incident_actions (0050).

ALTER TABLE {{SCHEMA}}.service_requests
  ADD COLUMN assigned_agent_id uuid,
  -- A person took the request over from an assistant: it may read but not write until it is handed back.
  ADD COLUMN agent_hold boolean NOT NULL DEFAULT false,
  -- The incident this request was raised for (or from), if any.
  ADD COLUMN incident_id uuid REFERENCES {{SCHEMA}}.incidents(id) ON DELETE SET NULL;
CREATE INDEX service_requests_incident_idx ON {{SCHEMA}}.service_requests (incident_id) WHERE incident_id IS NOT NULL;

ALTER TABLE {{SCHEMA}}.service_request_events
  ADD COLUMN actor_type text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'agent', 'system')),
  ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE {{SCHEMA}}.service_request_events DROP CONSTRAINT IF EXISTS service_request_events_kind_check;
ALTER TABLE {{SCHEMA}}.service_request_events
  ADD CONSTRAINT service_request_events_kind_check
  CHECK (kind IN ('created', 'status_changed', 'assigned', 'comment', 'build_drafted', 'deployment', 'waiting', 'resumed', 'approval', 'attachment',
                  'claim_started', 'claim_released', 'handoff', 'proposal', 'proposal_decided', 'whatif'));

CREATE TABLE {{SCHEMA}}.service_request_claims (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES {{SCHEMA}}.service_requests(id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL,
  note        text NOT NULL DEFAULT '',
  started_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  released_at timestamptz,
  release_reason text CHECK (release_reason IN ('released', 'expired', 'revoked', 'handed_off'))
);
CREATE UNIQUE INDEX service_request_claims_live_uq ON {{SCHEMA}}.service_request_claims (request_id) WHERE released_at IS NULL;
CREATE INDEX service_request_claims_expiry_idx ON {{SCHEMA}}.service_request_claims (expires_at) WHERE released_at IS NULL;

CREATE TABLE {{SCHEMA}}.service_request_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES {{SCHEMA}}.service_requests(id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL,
  kind        text NOT NULL,
  action_class text NOT NULL,
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  rationale   text NOT NULL DEFAULT '',
  risk        text NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'medium', 'high')),
  state       text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'approved', 'rejected', 'running', 'done', 'failed', 'expired')),
  decided_by  uuid,
  decided_at  timestamptz,
  decision_note text,
  -- A deploy: the approver's own tenant session it will run on, and the plan (a hash of the exact commands) that was approved.
  connection_id uuid,
  fingerprint text,
  result      jsonb,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  finished_at timestamptz
);
CREATE INDEX service_request_actions_request_idx ON {{SCHEMA}}.service_request_actions (request_id, created_at);
CREATE INDEX service_request_actions_open_idx ON {{SCHEMA}}.service_request_actions (state) WHERE state IN ('proposed', 'approved', 'running');
