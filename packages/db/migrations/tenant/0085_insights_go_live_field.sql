-- Voxshift Insights (docs/INSIGHTS.md): a site's go-live date is the "Target go-live" field it already had in its
-- overview (discovery_sites.overview->>'targetGoLive', YYYY-MM-DD), set in Site Data > (site) > Overview and shown in
-- handover packs. 0084 added a second, separate column for it; this folds that back into the one field.
--
-- 1. A date set through the separate column in the short time it existed is kept, where the overview has no date.
UPDATE {{SCHEMA}}.discovery_sites
   SET overview = jsonb_set(coalesce(overview, '{}'::jsonb), '{targetGoLive}', to_jsonb(to_char(target_go_live, 'YYYY-MM-DD')))
 WHERE target_go_live IS NOT NULL
   AND coalesce(overview->>'targetGoLive', '') !~ '^\d{4}-\d{2}-\d{2}$';

-- 2. The date first agreed starts as today's date, for sites that have one. A value that looks like a date but is not
--    one (2026-02-30) is left out rather than stopping the migration.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, overview->>'targetGoLive' AS d FROM {{SCHEMA}}.discovery_sites
            WHERE first_go_live IS NULL AND overview->>'targetGoLive' ~ '^\d{4}-\d{2}-\d{2}$' LOOP
    BEGIN
      UPDATE {{SCHEMA}}.discovery_sites SET first_go_live = r.d::date WHERE id = r.id;
    EXCEPTION WHEN others THEN NULL;
    END;
  END LOOP;
END $$;

ALTER TABLE {{SCHEMA}}.discovery_sites DROP COLUMN target_go_live;
