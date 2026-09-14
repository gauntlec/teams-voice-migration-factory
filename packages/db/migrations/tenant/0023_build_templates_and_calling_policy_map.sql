-- Two related Design & Build features, both scoped per site (a customer's
-- sites can span countries even inside one M365 tenant, so the real Teams
-- policy a generic choice or a template should resolve to genuinely differs
-- by site):
--
-- 1. calling_policy_site_map - which real tenant_policies row a Data
--    Collection generic calling-policy catalog entry ("International",
--    "Standard", ...) resolves to for THIS site. Populate is blocked for a
--    site until every catalog entry actually referenced by an unlinked
--    discovery_users/discovery_caps row there has a mapping - see
--    BuildService.assertCallingPoliciesMapped.
--
-- 2. build_templates - a named, reusable preset of policy_ids + voicemail
--    defaults for Users or CAPs on one site. The one marked is_default
--    seeds every new row Populate creates for that site+kind; any template
--    can also be applied on demand to already-populated rows (reuses the
--    existing bulk-patch mechanism).

CREATE TABLE {{SCHEMA}}.calling_policy_site_map (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id                     uuid NOT NULL REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE CASCADE,
  discovery_calling_policy_id uuid NOT NULL REFERENCES {{SCHEMA}}.discovery_calling_policies(id) ON DELETE CASCADE,
  tenant_policy_id            uuid NOT NULL REFERENCES {{SCHEMA}}.tenant_policies(id) ON DELETE RESTRICT,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, discovery_calling_policy_id)
);

CREATE TABLE {{SCHEMA}}.build_templates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id            uuid NOT NULL REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('user', 'cap')),
  name               text NOT NULL,
  -- Same two-column pattern as build_users/build_caps (0018_build_policy_ids.sql):
  -- policy_ids is the durable tenant_policies.id per PolicyKey, policies is
  -- the last-resolved display/deploy name, kept in sync by the API.
  policy_ids         jsonb NOT NULL DEFAULT '{}'::jsonb,
  policies           jsonb NOT NULL DEFAULT '{}'::jsonb,
  voicemail_enabled  boolean,
  voicemail_language text,
  is_default         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, kind, name)
);

-- Only one default template per site+kind - the one Populate auto-applies.
CREATE UNIQUE INDEX idx_build_templates_default ON {{SCHEMA}}.build_templates (site_id, kind) WHERE is_default;
