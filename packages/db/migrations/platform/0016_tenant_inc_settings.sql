-- Incident management settings per customer: response / restoration /
-- resolution targets and the impact x urgency matrix (see
-- packages/shared/src/incidents.ts). Empty = the defaults.
ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS inc_settings jsonb NOT NULL DEFAULT '{}'::jsonb;
