-- Per-customer: email the person who started a discovery run when it finishes.

ALTER TABLE {{SCHEMA}}.tenant_discovery_config
  ADD COLUMN notify_on_complete boolean NOT NULL DEFAULT true;
