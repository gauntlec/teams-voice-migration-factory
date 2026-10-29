-- Discovery sync speed (docs/DISCOVERY.md "How a sync stores what it reads").
-- A hash of each object's data, so a sync can tell an unchanged object without reading its data back, and only rewrites what changed.
ALTER TABLE {{SCHEMA}}.tenant_objects ADD COLUMN IF NOT EXISTS content_hash text;
-- No query reads this index, and every sync paid to rebuild it for every object it wrote.
DROP INDEX IF EXISTS {{SCHEMA}}.idx_tenant_objects_data;
-- Room on each page, so the "seen again" update of an unchanged row can stay on its page and skip the indexes.
ALTER TABLE {{SCHEMA}}.tenant_objects SET (fillfactor = 85);
ALTER TABLE {{SCHEMA}}.tenant_users SET (fillfactor = 85);
