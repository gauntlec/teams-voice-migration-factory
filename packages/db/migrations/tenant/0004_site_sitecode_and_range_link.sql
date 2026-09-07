-- Rename discovery_sites.site_code -> sitecode, make it the site's unique key,
-- and link each DID range to its site by that key.

ALTER TABLE {{SCHEMA}}.discovery_sites RENAME COLUMN site_code TO sitecode;

-- Backfill blanks so sitecode can be a real identifier.
UPDATE {{SCHEMA}}.discovery_sites
   SET sitecode = 'SITE-' || upper(substr(replace(id::text, '-', ''), 1, 6))
 WHERE sitecode IS NULL OR btrim(sitecode) = '';

-- De-duplicate (case-insensitive) so the unique index can be created.
WITH d AS (
  SELECT id,
         row_number() OVER (PARTITION BY lower(sitecode) ORDER BY created_at, id) AS rn
    FROM {{SCHEMA}}.discovery_sites
)
UPDATE {{SCHEMA}}.discovery_sites s
   SET sitecode = s.sitecode || '-' || substr(replace(s.id::text, '-', ''), 1, 4)
  FROM d
 WHERE d.id = s.id AND d.rn > 1;

ALTER TABLE {{SCHEMA}}.discovery_sites ALTER COLUMN sitecode SET NOT NULL;
CREATE UNIQUE INDEX idx_discovery_site_sitecode ON {{SCHEMA}}.discovery_sites (sitecode);

-- Number ranges reference the site by its sitecode. Nullable so existing
-- ranges migrate cleanly; the UI requires a site for new ranges.
ALTER TABLE {{SCHEMA}}.discovery_number_ranges
  ADD COLUMN sitecode text
    REFERENCES {{SCHEMA}}.discovery_sites (sitecode)
    ON UPDATE CASCADE ON DELETE SET NULL;
CREATE INDEX idx_number_range_sitecode ON {{SCHEMA}}.discovery_number_ranges (sitecode);
