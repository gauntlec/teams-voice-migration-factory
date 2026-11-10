-- Physical phone tracking (bug report "Physical Phone Tracking"): which users' and common area phones' handsets have actually been
-- installed. A tick per person or phone, on the Site Data row that says the handset is needed, with who ticked it. Recorded with its
-- own update that leaves updated_at alone, so ticking a handset is not a Site Data change to acknowledge.
ALTER TABLE {{SCHEMA}}.discovery_users
  ADD COLUMN handset_installed_at timestamptz,
  ADD COLUMN handset_installed_by text;
ALTER TABLE {{SCHEMA}}.discovery_caps
  ADD COLUMN handset_installed_at timestamptz,
  ADD COLUMN handset_installed_by text;
