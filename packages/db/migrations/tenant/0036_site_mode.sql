-- Managed Services: a site is in project mode (being migrated - no service
-- requests) until an engineer or admin moves it to operations mode, after which
-- the customer can raise service requests for it. Every existing site starts in
-- project mode.
ALTER TABLE {{SCHEMA}}.discovery_sites
  ADD COLUMN mode text NOT NULL DEFAULT 'project' CHECK (mode IN ('project', 'operations')),
  ADD COLUMN mode_changed_at timestamptz,
  ADD COLUMN mode_changed_by uuid;
