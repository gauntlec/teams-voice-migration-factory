-- Site-scoped membership. A CUSTOMER user's membership can be limited to a set
-- of sites (a "site contact"). Empty array = access to the whole customer.
-- The ids point at `discovery_sites.id` inside that customer's tenant schema;
-- there is no cross-schema FK, so the API validates and enforces them.
-- Never populated for SUPER_ADMIN or ENGINEER (always whole-customer).
ALTER TABLE platform.tenant_memberships
  ADD COLUMN site_ids uuid[] NOT NULL DEFAULT '{}';
