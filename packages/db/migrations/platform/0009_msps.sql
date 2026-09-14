-- Managed Service Providers: organizations (Voxshift itself, or a partner)
-- whose engineers/PMs get their OWN branding in the app chrome, resolved by
-- email domain (or an explicit per-user override) rather than by whichever
-- customer tenant they happen to be looking at - see auth.service.ts's me().
CREATE TABLE platform.msps (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  domains    text[] NOT NULL DEFAULT '{}',  -- lowercased, no leading '@'
  branding   jsonb,
  created_by uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_msps_domains ON platform.msps USING gin (domains);

-- Explicit per-user fallback when no domain matches any MSP.
ALTER TABLE platform.users ADD COLUMN msp_id uuid REFERENCES platform.msps(id) ON DELETE SET NULL;
