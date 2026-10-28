-- More than one address on a site: a campus of several buildings, each with its own civic address, is one site with one site code.
-- The primary address stays on discovery_sites (address, latitude, longitude); every other address is a row here and is pinned on the
-- site map under the same site code.
CREATE TABLE {{SCHEMA}}.discovery_site_addresses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE CASCADE,
  label       text,                       -- e.g. "Building B"
  address     text NOT NULL,
  latitude    double precision,
  longitude   double precision,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_site_addresses_site ON {{SCHEMA}}.discovery_site_addresses(site_id, sort_order);
