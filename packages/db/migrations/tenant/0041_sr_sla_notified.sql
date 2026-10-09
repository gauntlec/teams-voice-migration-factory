-- Managed Services targets: which target emails have gone out for a request,
-- so each is sent once - { response_warning, response_breached,
-- resolution_warning, resolution_breached } -> ISO time.
ALTER TABLE {{SCHEMA}}.service_requests ADD COLUMN sla_notified jsonb NOT NULL DEFAULT '{}'::jsonb;
