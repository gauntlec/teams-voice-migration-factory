-- Optional areas of the application a Super Admin can switch off for this installation (Administration > Platform settings > Menus and features),
-- e.g. the bug and feature boards or the MSP console on a customer-premises installation. Empty = everything on (the default, so nothing changes).
ALTER TABLE platform.app_settings ADD COLUMN IF NOT EXISTS disabled_features text[] NOT NULL DEFAULT '{}';
