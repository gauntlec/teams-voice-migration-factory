-- Managed Services: customer-raised service requests and their timeline.
-- Workflow: new -> planned -> built (designed & built) -> deployed, or cancelled
-- from any open status. See packages/shared/src/service-requests.ts.

-- Per-customer request number, shown as SR-0001. A sequence, so two requests
-- raised at the same moment can never get the same number.
CREATE SEQUENCE {{SCHEMA}}.service_request_number_seq;

CREATE TABLE {{SCHEMA}}.service_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number       integer NOT NULL DEFAULT nextval('{{SCHEMA}}.service_request_number_seq'),
  type         text NOT NULL CHECK (type IN ('new_site', 'new_user', 'new_phone_numbers', 'new_common_area_phone', 'new_call_queue', 'new_auto_attendant', 'other')),
  title        text NOT NULL,
  -- NULL for a new site (no site yet) or a customer-wide "other" request.
  site_id      uuid REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE SET NULL,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority     text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status       text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'planned', 'built', 'deployed', 'cancelled')),
  target_date  date,
  requested_by uuid NOT NULL,
  assigned_to  uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  planned_at   timestamptz,
  built_at     timestamptz,
  deployed_at  timestamptz,
  cancelled_at timestamptz
);
ALTER SEQUENCE {{SCHEMA}}.service_request_number_seq OWNED BY {{SCHEMA}}.service_requests.number;
CREATE UNIQUE INDEX service_requests_number_uq ON {{SCHEMA}}.service_requests (number);
CREATE INDEX service_requests_status_idx ON {{SCHEMA}}.service_requests (status, created_at DESC);

-- Everything that happened to a request, oldest first: raised, status moves,
-- assignment and comments. `internal` comments are staff-only.
CREATE TABLE {{SCHEMA}}.service_request_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES {{SCHEMA}}.service_requests(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('created', 'status_changed', 'assigned', 'comment')),
  from_status text,
  to_status   text,
  body        text,
  internal    boolean NOT NULL DEFAULT false,
  author_id   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_request_events_request_idx ON {{SCHEMA}}.service_request_events (request_id, created_at);
