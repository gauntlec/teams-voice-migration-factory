-- Managed Services: "Create in Design & Build" on a service request records a
-- 'build_drafted' timeline entry, with links to the rows it created in `links`
-- ([{ kind, label, href }], href an in-app path). Staff-only (internal) - the
-- customer can't open Design & Build.
-- (0036 is left free for the site-mode migration being worked on in parallel.)
ALTER TABLE {{SCHEMA}}.service_request_events DROP CONSTRAINT IF EXISTS service_request_events_kind_check;
ALTER TABLE {{SCHEMA}}.service_request_events
  ADD CONSTRAINT service_request_events_kind_check CHECK (kind IN ('created', 'status_changed', 'assigned', 'comment', 'build_drafted'));
ALTER TABLE {{SCHEMA}}.service_request_events ADD COLUMN links jsonb;
