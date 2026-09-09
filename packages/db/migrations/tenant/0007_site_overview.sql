-- The discovery "overview" moved from the customer (discovery.general) to each
-- site. Holds the 7 overview fields plus assignedUserIds (ENGINEER /
-- PROJECT_MANAGER platform user ids, validated by the API).

ALTER TABLE {{SCHEMA}}.discovery_sites
  ADD COLUMN overview jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Carry the old customer-level overview onto the sole site of a single-site
-- customer. Multi-site customers start blank and staff fill each site in.
UPDATE {{SCHEMA}}.discovery_sites
   SET overview = COALESCE((SELECT general FROM {{SCHEMA}}.discovery LIMIT 1), '{}'::jsonb)
 WHERE overview = '{}'::jsonb
   AND (SELECT count(*) FROM {{SCHEMA}}.discovery_sites) = 1;
