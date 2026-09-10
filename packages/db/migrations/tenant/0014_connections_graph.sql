-- Optional second (Microsoft Graph) sign-in on a customer-tenant connection,
-- used to read the Teams device inventory (`/teamwork/devices`). Still no tokens.

ALTER TABLE {{SCHEMA}}.connections
  ADD COLUMN graph_status text NOT NULL DEFAULT 'none'
    CHECK (graph_status IN ('none', 'pending', 'active', 'failed')),
  ADD COLUMN graph_user_code text,
  ADD COLUMN graph_verification_uri text,
  ADD COLUMN graph_upn text,
  ADD COLUMN graph_expires_at timestamptz;
