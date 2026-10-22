-- The Data Collection review (draft -> submitted -> accepted) moves from the customer to each site, and nothing is locked any
-- more: data keeps changing right up to the migration. Instead, every change made to a site after it was submitted is recorded
-- in discovery_site_changes so the engineer can see what is new since the submission and acknowledge it.
--
-- Each site starts with the customer's current status (and who/when), so nothing already submitted or accepted is lost.
-- discovery.status and its columns stay in place but are no longer read.

ALTER TABLE {{SCHEMA}}.discovery_sites
  ADD COLUMN review_status text NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft', 'submitted', 'accepted')),
  ADD COLUMN submitted_by uuid,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN accepted_by uuid,
  ADD COLUMN accepted_at timestamptz;

UPDATE {{SCHEMA}}.discovery_sites s
   SET review_status = d.status,
       submitted_by = d.submitted_by,
       submitted_at = d.submitted_at,
       accepted_by = d.accepted_by,
       accepted_at = d.accepted_at
  FROM (SELECT status, submitted_by, submitted_at, accepted_by, accepted_at FROM {{SCHEMA}}.discovery ORDER BY created_at LIMIT 1) d;

CREATE TABLE {{SCHEMA}}.discovery_site_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         uuid NOT NULL REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE CASCADE,
  changed_at      timestamptz NOT NULL DEFAULT now(),
  actor_id        uuid,
  actor_name      text,
  -- what was changed, as shown to the engineer: 'User', 'Number range', 'Resource account', ...
  entity          text NOT NULL,
  -- the person, range or name it was about: 'jane@contoso.com', '+441234567000 - +441234567099'
  entity_label    text,
  action          text NOT NULL CHECK (action IN ('added', 'changed', 'removed')),
  detail          text,
  acknowledged_at timestamptz,
  acknowledged_by uuid
);
CREATE INDEX discovery_site_changes_site_idx ON {{SCHEMA}}.discovery_site_changes (site_id, acknowledged_at, changed_at DESC);
