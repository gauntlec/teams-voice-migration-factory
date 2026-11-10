-- Which Microsoft tenant each Teams sign-in reached, and why a sign-in was refused (a different tenant from the customer's own) -
-- see packages/db/src/teams-tenant.ts.
ALTER TABLE {{SCHEMA}}.connections
  ADD COLUMN ms_tenant_id text,
  ADD COLUMN ms_tenant_name text,
  ADD COLUMN refused_reason text;
