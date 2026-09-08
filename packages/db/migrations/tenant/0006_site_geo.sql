-- Map coordinates for a site, so the Data Collection landing page can pin every
-- site the caller is allowed to see on a map. Nullable: a site without
-- coordinates is listed but not pinned until someone sets them.
ALTER TABLE {{SCHEMA}}.discovery_sites
  ADD COLUMN latitude  double precision,
  ADD COLUMN longitude double precision;
