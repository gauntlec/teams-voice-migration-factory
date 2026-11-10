-- Service Handover outstanding actions as records (feature request "Service Handover View", docs/HANDOVER-VIEW.md step 1), so
-- each can be ticked off when done and counted. Until now they were one free-text note per site, a line per action written as
-- "description | owner"; each line becomes a row here (in its order, with the note's author and time) and those notes go.
CREATE TABLE {{SCHEMA}}.handover_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- null = applies to every site (printed in every pack), as an all-sites note did
  site_id     uuid REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE CASCADE,
  description text NOT NULL,
  owner       text NOT NULL DEFAULT '',
  position    integer NOT NULL DEFAULT 0,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- set together when the action is ticked off; cleared together when it is opened again
  done_at     timestamptz,
  done_by     uuid,
  CONSTRAINT handover_actions_done_together CHECK ((done_at IS NULL) = (done_by IS NULL))
);
CREATE INDEX handover_actions_site_idx ON {{SCHEMA}}.handover_actions (site_id);

INSERT INTO {{SCHEMA}}.handover_actions (site_id, description, owner, position, created_by, created_at)
SELECT n.site_id,
       btrim(split_part(l.line, '|', 1)),
       CASE WHEN strpos(l.line, '|') > 0 THEN btrim(substr(l.line, strpos(l.line, '|') + 1)) ELSE '' END,
       l.ord::integer,
       n.updated_by,
       n.updated_at
FROM {{SCHEMA}}.handover_notes n
CROSS JOIN LATERAL (
  SELECT regexp_replace(btrim(x), '^[-•*]\s+', '') AS line, ord
  FROM regexp_split_to_table(n.body, E'\r?\n') WITH ORDINALITY AS t(x, ord)
) l
WHERE n.section_key = 'outstanding_actions' AND l.line <> '';

DELETE FROM {{SCHEMA}}.handover_notes WHERE section_key = 'outstanding_actions';
