-- Managed Services settings per customer: response/resolution targets,
-- approvals and the change window (see packages/shared/src/service-request-sla.ts).
-- Empty = the defaults.
ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS sr_settings jsonb NOT NULL DEFAULT '{}'::jsonb;
