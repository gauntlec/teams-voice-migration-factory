-- The customer's own Microsoft tenant, recorded so a Teams sign-in to any other tenant is refused (bug report "Delete All Data
-- Button": a sign-in to another company's tenant from this customer read that company's Teams into it). Set from the customer's
-- discovered Get-CsTenant record, or else its first sign-in; cleared by "Delete discovered data" - see packages/db/src/teams-tenant.ts.
ALTER TABLE platform.tenants
  ADD COLUMN teams_tenant_id text,
  ADD COLUMN teams_tenant_name text,
  ADD COLUMN teams_tenant_recorded_at timestamptz;
