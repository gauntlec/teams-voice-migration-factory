-- One live discovered user per UPN, not one row ever. A Teams account deleted and created again with the same UPN (a new Identity),
-- or two accounts that swapped UPNs, used to break every user sync from then on with
-- `duplicate key value violates unique constraint "idx_tenant_users_upn"`, because the old account's row kept the UPN even once
-- removed. The worker now marks the old row removed before storing the new account (apps/worker/src/discovery/run.ts,
-- releaseReusedUpns), and removed rows no longer hold the UPN. Readers already pick the live row (removed_at IS NULL).
DROP INDEX IF EXISTS {{SCHEMA}}.idx_tenant_users_upn;
CREATE UNIQUE INDEX idx_tenant_users_upn ON {{SCHEMA}}.tenant_users (lower(upn)) WHERE removed_at IS NULL;
