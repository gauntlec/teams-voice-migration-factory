-- A site's region used to be stored twice: free text in discovery_sites.region (site creation form) and AMER / EMEA / APAC in
-- discovery_sites.overview ->> 'region' (Site Overview). It now lives in discovery_sites.region only, as AMER, EMEA or APAC.
--
-- The Overview value wins where it is one of the three (it was the controlled one). Otherwise the site column is kept, upper-cased,
-- when it already says AMER / EMEA / APAC. Any other older free-text value is left exactly as it is (nothing is deleted); the
-- Overview shows it as not set until someone chooses a region. An Overview value that is not one of the three is copied to the
-- site column when that is empty, so nothing is lost.

UPDATE {{SCHEMA}}.discovery_sites
   SET region = upper(btrim(overview ->> 'region'))
 WHERE upper(btrim(overview ->> 'region')) IN ('AMER', 'EMEA', 'APAC');

UPDATE {{SCHEMA}}.discovery_sites
   SET region = btrim(overview ->> 'region')
 WHERE nullif(btrim(region), '') IS NULL
   AND nullif(btrim(overview ->> 'region'), '') IS NOT NULL;

UPDATE {{SCHEMA}}.discovery_sites
   SET region = upper(btrim(region))
 WHERE upper(btrim(region)) IN ('AMER', 'EMEA', 'APAC')
   AND region <> upper(btrim(region));

UPDATE {{SCHEMA}}.discovery_sites
   SET overview = overview - 'region'
 WHERE overview ? 'region';
