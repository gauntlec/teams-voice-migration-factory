-- Diagnostic runbook results on an incident (docs/DIAGNOSTICS.md). Read-only checks against what Discovery
-- and the design say; kept so the next person (or assistant) sees what was already looked at, and when.
CREATE TABLE {{SCHEMA}}.incident_diagnostics (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES {{SCHEMA}}.incidents(id) ON DELETE CASCADE,
  runbook     text NOT NULL,
  input       text NOT NULL DEFAULT '',
  subject     text NOT NULL DEFAULT '',
  status      text NOT NULL CHECK (status IN ('ok', 'warn', 'fail', 'unknown')),
  summary     text NOT NULL DEFAULT '',
  findings    jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_as_of  timestamptz,
  actor_type  text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'agent', 'system')),
  run_by      uuid,
  proposal_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_diagnostics_incident_idx ON {{SCHEMA}}.incident_diagnostics (incident_id, created_at DESC);

ALTER TABLE {{SCHEMA}}.incident_events DROP CONSTRAINT IF EXISTS incident_events_kind_check;
ALTER TABLE {{SCHEMA}}.incident_events
  ADD CONSTRAINT incident_events_kind_check
  CHECK (kind IN ('created', 'status_changed', 'priority_changed', 'assigned', 'comment', 'waiting', 'resumed', 'attachment', 'link',
                  'major_declared', 'major_update', 'major_ended', 'child_linked', 'child_unlinked', 'problem_linked', 'review_shared',
                  'claim_started', 'claim_released', 'handoff', 'proposal', 'proposal_decided', 'diagnostic'));
