-- Master switch for email (Administration > Platform settings). When false the platform generates no email at all:
-- nothing is queued, and anything already queued is marked skipped instead of sent. Default on.
ALTER TABLE platform.app_settings ADD COLUMN IF NOT EXISTS email_enabled boolean NOT NULL DEFAULT true;
