-- Incident management, chunk 4: major incidents (a lead, a comms owner, a cadence of
-- customer updates, child incidents), problem records (root cause, workaround, known
-- errors) and post-incident reviews. See docs/INCIDENT-MANAGEMENT.md.

-- Per-customer problem number, shown as PRB-0001.
CREATE SEQUENCE {{SCHEMA}}.problem_number_seq;

CREATE TABLE {{SCHEMA}}.problems (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        integer NOT NULL DEFAULT nextval('{{SCHEMA}}.problem_number_seq'),
  title         text NOT NULL,
  description   text NOT NULL DEFAULT '',
  -- What kind of incident this is the cause of, so a known error can be matched to new ones.
  category      text,
  subcategory   text,
  status        text NOT NULL DEFAULT 'investigating' CHECK (status IN ('investigating', 'known_error', 'fix_planned', 'resolved')),
  root_cause    text NOT NULL DEFAULT '',
  -- For the team: how to work around it until it is fixed.
  workaround    text NOT NULL DEFAULT '',
  -- What a customer is told when they are about to raise an incident this problem explains.
  customer_note text NOT NULL DEFAULT '',
  owner_id      uuid,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);
ALTER SEQUENCE {{SCHEMA}}.problem_number_seq OWNED BY {{SCHEMA}}.problems.number;
CREATE UNIQUE INDEX problems_number_uq ON {{SCHEMA}}.problems (number);
CREATE INDEX problems_status_idx ON {{SCHEMA}}.problems (status);

ALTER TABLE {{SCHEMA}}.incidents
  ADD COLUMN major boolean NOT NULL DEFAULT false,
  ADD COLUMN major_declared_at timestamptz,
  ADD COLUMN major_declared_by uuid,
  -- Set when the incident is resolved (or cancelled / merged): it is no longer a live major incident.
  ADD COLUMN major_ended_at timestamptz,
  ADD COLUMN lead_id uuid,
  ADD COLUMN comms_id uuid,
  ADD COLUMN update_interval_minutes integer,
  -- When the next customer update is due; the worker reminds the comms owner, then the lead.
  ADD COLUMN next_update_due_at timestamptz,
  ADD COLUMN update_reminded_at timestamptz,
  ADD COLUMN update_escalated_at timestamptz,
  ADD COLUMN parent_id uuid REFERENCES {{SCHEMA}}.incidents(id) ON DELETE SET NULL,
  ADD COLUMN problem_id uuid REFERENCES {{SCHEMA}}.problems(id) ON DELETE SET NULL,
  ADD CONSTRAINT incidents_parent_not_self CHECK (parent_id IS NULL OR parent_id <> id),
  ADD CONSTRAINT incidents_major_needs_lead CHECK (NOT major OR (lead_id IS NOT NULL AND comms_id IS NOT NULL));
CREATE INDEX incidents_parent_idx ON {{SCHEMA}}.incidents (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX incidents_major_idx ON {{SCHEMA}}.incidents (major) WHERE major;
CREATE INDEX incidents_problem_idx ON {{SCHEMA}}.incidents (problem_id) WHERE problem_id IS NOT NULL;

ALTER TABLE {{SCHEMA}}.incident_events DROP CONSTRAINT IF EXISTS incident_events_kind_check;
ALTER TABLE {{SCHEMA}}.incident_events
  ADD CONSTRAINT incident_events_kind_check
  CHECK (kind IN ('created', 'status_changed', 'priority_changed', 'assigned', 'comment', 'waiting', 'resumed', 'attachment', 'link',
                  'major_declared', 'major_update', 'major_ended', 'child_linked', 'child_unlinked', 'problem_linked', 'review_shared'));

-- One post-incident review per incident (major incidents mainly). The timeline is
-- built from the incident's own public events when it is shown; only what a person
-- writes is stored. Customers see it once it is shared.
CREATE TABLE {{SCHEMA}}.incident_reviews (
  incident_id uuid PRIMARY KEY REFERENCES {{SCHEMA}}.incidents(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'shared')),
  summary     text NOT NULL DEFAULT '',
  cause       text NOT NULL DEFAULT '',
  went_well   text NOT NULL DEFAULT '',
  went_badly  text NOT NULL DEFAULT '',
  -- [{ text, owner, due, serviceRequestId }]
  actions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  shared_at   timestamptz,
  shared_by   uuid,
  CHECK ((status = 'shared') = (shared_at IS NOT NULL))
);
