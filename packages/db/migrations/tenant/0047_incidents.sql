-- Incident management (Managed Services): something that worked has stopped
-- working or is working badly. Workflow: new -> in_progress -> (on_hold) ->
-- restored -> resolved -> closed, or cancelled / duplicate. See
-- packages/shared/src/incidents.ts and docs/INCIDENT-MANAGEMENT.md.

-- Per-customer incident number, shown as INC-0001.
CREATE SEQUENCE {{SCHEMA}}.incident_number_seq;

CREATE TABLE {{SCHEMA}}.incidents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        integer NOT NULL DEFAULT nextval('{{SCHEMA}}.incident_number_seq'),
  title         text NOT NULL,
  description   text NOT NULL,
  category      text NOT NULL,
  subcategory   text,
  -- NULL for a customer-wide incident (SBC, Microsoft, Voxshift, other).
  site_id       uuid REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE SET NULL,
  impact        text NOT NULL CHECK (impact IN ('individual', 'team', 'site', 'company')),
  urgency       text NOT NULL CHECK (urgency IN ('cannot_call', 'degraded', 'feature_broken', 'question')),
  priority      text NOT NULL CHECK (priority IN ('p1', 'p2', 'p3', 'p4')),
  -- true when staff (or the emergency rule) set the priority instead of the matrix.
  priority_overridden boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'on_hold', 'restored', 'resolved', 'closed', 'cancelled', 'duplicate')),
  hold_reason   text CHECK (hold_reason IN ('customer', 'carrier', 'microsoft', 'vendor')),
  source        text NOT NULL DEFAULT 'customer' CHECK (source IN ('customer', 'staff', 'agent', 'monitor', 'email')),
  -- Monitoring / agents: the same key appends to the open incident instead of making another.
  dedup_key     text,
  -- Category answers, example calls and a callback number (IncDetails).
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  reporter_id   uuid NOT NULL,
  assigned_to   uuid,
  -- Reserved for AI agents (platform.agents, a later chunk).
  assigned_agent_id uuid,
  duplicate_of  uuid REFERENCES {{SCHEMA}}.incidents(id) ON DELETE SET NULL,
  -- Bumped on every change, so an agent's stale write can be refused.
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  restored_at   timestamptz,
  resolved_at   timestamptz,
  closed_at     timestamptz,
  cancelled_at  timestamptz,
  reopened_at   timestamptz,
  -- Clocks stop while a pausing hold is open (incHoldPauses); paused_seconds is the total so far.
  paused_since  timestamptz,
  paused_seconds integer NOT NULL DEFAULT 0,
  waiting_reminded_at timestamptz,
  waiting_reminders integer NOT NULL DEFAULT 0,
  -- Target emails already sent: { response_warning, response_breached, ... } -> ISO time.
  sla_notified  jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK ((status = 'on_hold') = (hold_reason IS NOT NULL))
);
ALTER SEQUENCE {{SCHEMA}}.incident_number_seq OWNED BY {{SCHEMA}}.incidents.number;
CREATE UNIQUE INDEX incidents_number_uq ON {{SCHEMA}}.incidents (number);
CREATE INDEX incidents_status_idx ON {{SCHEMA}}.incidents (status, created_at DESC);
CREATE INDEX incidents_site_idx ON {{SCHEMA}}.incidents (site_id);
CREATE INDEX incidents_assigned_idx ON {{SCHEMA}}.incidents (assigned_to) WHERE assigned_to IS NOT NULL;
-- One open incident per dedup key.
CREATE UNIQUE INDEX incidents_dedup_open_uq ON {{SCHEMA}}.incidents (dedup_key)
  WHERE dedup_key IS NOT NULL AND status IN ('new', 'in_progress', 'on_hold', 'restored', 'resolved');

-- Everything that happened to an incident, oldest first. `internal` entries are
-- staff-only. actor_type 'agent' / 'system' have no author_id user.
CREATE TABLE {{SCHEMA}}.incident_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES {{SCHEMA}}.incidents(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('created', 'status_changed', 'priority_changed', 'assigned', 'comment', 'waiting', 'resumed', 'attachment', 'link')),
  from_status text,
  to_status   text,
  body        text,
  internal    boolean NOT NULL DEFAULT false,
  actor_type  text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'agent', 'system')),
  author_id   uuid,
  -- priority_changed: { from, to }; status_changed: { holdReason, kind }; link: { kind, ref }.
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Agents: a retry with the same key is ignored.
  idempotency_key text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_events_incident_idx ON {{SCHEMA}}.incident_events (incident_id, created_at);
CREATE UNIQUE INDEX incident_events_idem_uq ON {{SCHEMA}}.incident_events (incident_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- What an incident is about: the people, numbers, queues, auto attendants and
-- phones affected, and the service requests / deployments / ports it links to.
CREATE TABLE {{SCHEMA}}.incident_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES {{SCHEMA}}.incidents(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('site', 'user', 'number', 'call_queue', 'auto_attendant', 'cap', 'service_request', 'deployment', 'number_port')),
  ref         text NOT NULL,
  label       text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, kind, ref)
);

-- Customer users who follow an incident (later: they get its updates by email).
CREATE TABLE {{SCHEMA}}.incident_watchers (
  incident_id uuid NOT NULL REFERENCES {{SCHEMA}}.incidents(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  added_by    uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, user_id)
);

ALTER TABLE {{SCHEMA}}.files DROP CONSTRAINT IF EXISTS files_category_check;
ALTER TABLE {{SCHEMA}}.files
  ADD CONSTRAINT files_category_check
  CHECK (category IN ('deployment_change_document', 'number_port_document', 'resource_account_request', 'handover_pack', 'service_request_attachment', 'incident_attachment'));
