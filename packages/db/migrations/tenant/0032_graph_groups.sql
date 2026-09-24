-- Optional second device-code sign-in (Microsoft Graph, read-only
-- Group.Read.All) so an engineer can search M365 groups by name instead of
-- typing a raw Object ID into the Shared Voicemail groupId field. Same
-- columns a prior, reverted feature added to `connections` for a different
-- purpose (Teams device inventory) - re-added fresh since that migration
-- and its revert already ran.
ALTER TABLE {{SCHEMA}}.connections
  ADD COLUMN graph_status text NOT NULL DEFAULT 'none'
    CHECK (graph_status IN ('none', 'pending', 'active', 'failed')),
  ADD COLUMN graph_user_code text,
  ADD COLUMN graph_verification_uri text,
  ADD COLUMN graph_upn text,
  ADD COLUMN graph_expires_at timestamptz;

-- Cache of this tenant's M365 groups, populated once per Graph sign-in
-- (full sweep via Invoke-MgGraphRequest, following @odata.nextLink) so
-- group search is a normal fast DB read afterward, not a live per-keystroke
-- round trip through the worker's pwsh session.
CREATE TABLE {{SCHEMA}}.tenant_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id text NOT NULL UNIQUE,
  display_name text NOT NULL,
  mail text,
  synced_at timestamptz NOT NULL DEFAULT now()
);
