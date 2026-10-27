-- The sign-in of the monitoring module's (Uptime Kuma's) administrator, one per installation: there is one monitoring module for every customer on it,
-- so its administrator is kept here once, not once per customer. The worker makes the administrator the first time any customer sets monitoring up and
-- stores the generated password encrypted (AES-256-GCM, DATA_ENCRYPTION_KEY); it is never shown. Customers' own copies (tenant migration 0071) are
-- only for an administrator somebody made by hand.
CREATE TABLE IF NOT EXISTS platform.monitoring_admin (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),
  admin_user      text NOT NULL,
  admin_pass_enc  text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
