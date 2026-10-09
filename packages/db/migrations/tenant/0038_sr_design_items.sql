-- Managed Services: design and deploy inside a service request.
--
-- service_request_items links a request to the Design & Build rows designed
-- for it (or the new site made for it). row_id is a plain reference, not a
-- foreign key, because it points into one of several tables (by `kind`); a
-- row deleted from Design & Build simply stops resolving, and the request's
-- Design tab shows it as deleted.
CREATE TABLE {{SCHEMA}}.service_request_items (
  request_id  uuid NOT NULL REFERENCES {{SCHEMA}}.service_requests(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('site', 'user', 'cap', 'resource_account', 'shared_calling_policy', 'call_queue', 'auto_attendant')),
  row_id      uuid NOT NULL,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, kind, row_id)
);
-- "Which requests is this row on?" - the reference shown in Design & Build.
CREATE INDEX service_request_items_row_idx ON {{SCHEMA}}.service_request_items (row_id);

-- 'deployment' timeline entries: a What-If or live run started from the
-- request finished. deployment_id points at the run (no FK: runs are never
-- deleted, and the timeline must survive if one ever is).
ALTER TABLE {{SCHEMA}}.service_request_events DROP CONSTRAINT IF EXISTS service_request_events_kind_check;
ALTER TABLE {{SCHEMA}}.service_request_events
  ADD CONSTRAINT service_request_events_kind_check CHECK (kind IN ('created', 'status_changed', 'assigned', 'comment', 'build_drafted', 'deployment'));
ALTER TABLE {{SCHEMA}}.service_request_events ADD COLUMN deployment_id uuid;
