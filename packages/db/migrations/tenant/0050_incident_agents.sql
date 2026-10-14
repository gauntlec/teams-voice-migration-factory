-- Incident management, chunk 5: AI agents working incidents alongside people.
-- A claim is a short lease saying "I am working this"; a proposal is a structured next
-- step an agent suggests for a person to approve. See docs/INCIDENT-MANAGEMENT.md, section 7.

-- Whoever is working an incident holds a lease they must renew. At most one live claim per
-- incident; an expired one is released by the next claimer (or the worker's sweep).
CREATE TABLE {{SCHEMA}}.incident_claims (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES {{SCHEMA}}.incidents(id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL,
  note        text NOT NULL DEFAULT '',
  started_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  released_at timestamptz,
  -- released: the agent let go; expired: the lease lapsed; revoked: a person took over; handed_off: it handed the incident on.
  release_reason text CHECK (release_reason IN ('released', 'expired', 'revoked', 'handed_off'))
);
CREATE UNIQUE INDEX incident_claims_live_uq ON {{SCHEMA}}.incident_claims (incident_id) WHERE released_at IS NULL;
CREATE INDEX incident_claims_expiry_idx ON {{SCHEMA}}.incident_claims (expires_at) WHERE released_at IS NULL;

-- Proposals: an agent's suggested next step, decided by a person. Kinds the platform can do
-- itself are carried out when approved; the rest are for the agent to do and report back.
CREATE TABLE {{SCHEMA}}.incident_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES {{SCHEMA}}.incidents(id) ON DELETE CASCADE,
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
  result      jsonb,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  finished_at timestamptz
);
CREATE INDEX incident_actions_incident_idx ON {{SCHEMA}}.incident_actions (incident_id, created_at);
CREATE INDEX incident_actions_open_idx ON {{SCHEMA}}.incident_actions (state) WHERE state IN ('proposed', 'approved', 'running');

-- A person took the incident over from an agent: the agent may read but not write until it is handed back.
ALTER TABLE {{SCHEMA}}.incidents ADD COLUMN agent_hold boolean NOT NULL DEFAULT false;

ALTER TABLE {{SCHEMA}}.incident_events DROP CONSTRAINT IF EXISTS incident_events_kind_check;
ALTER TABLE {{SCHEMA}}.incident_events
  ADD CONSTRAINT incident_events_kind_check
  CHECK (kind IN ('created', 'status_changed', 'priority_changed', 'assigned', 'comment', 'waiting', 'resumed', 'attachment', 'link',
                  'major_declared', 'major_update', 'major_ended', 'child_linked', 'child_unlinked', 'problem_linked', 'review_shared',
                  'claim_started', 'claim_released', 'handoff', 'proposal', 'proposal_decided'));
