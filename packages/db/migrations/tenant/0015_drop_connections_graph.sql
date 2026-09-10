-- Reverts 0014. The Teams device inventory needed Microsoft Graph
-- `/teamwork/devices`, which Microsoft retired (Nov/Dec 2025) with no
-- replacement. Discovery now derives phone endpoints from the users /
-- resource-account snapshot instead, so no second sign-in and no columns here.

ALTER TABLE {{SCHEMA}}.connections
  DROP COLUMN IF EXISTS graph_status,
  DROP COLUMN IF EXISTS graph_user_code,
  DROP COLUMN IF EXISTS graph_verification_uri,
  DROP COLUMN IF EXISTS graph_upn,
  DROP COLUMN IF EXISTS graph_expires_at;
