-- Incident clocks on business-hours cover only count working time, so they need
-- to know when each pause happened, not just how long it lasted in total.
-- pause_log holds the closed pauses [{ from, to }]; paused_since is the open one.
ALTER TABLE {{SCHEMA}}.incidents ADD COLUMN pause_log jsonb NOT NULL DEFAULT '[]'::jsonb;
