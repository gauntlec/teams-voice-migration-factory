-- Platform-wide settings a Super Admin can change without redeploying (one row, id is always true).
-- base_url: the address people use to reach this installation (https://www.voxshift.io for the hosted
-- service; a customer-premises install sets its own). NULL means "use the WEB_ORIGIN environment value".
CREATE TABLE IF NOT EXISTS platform.app_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  base_url text,
  updated_by uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
