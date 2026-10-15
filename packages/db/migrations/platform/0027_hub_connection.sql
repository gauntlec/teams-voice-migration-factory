-- Connection to a Voxshift Hub (the registry that lists this installation and where staff open it from).
-- The worker reports in once a minute with a version and a health word, and nothing else. All empty = not connected.
ALTER TABLE platform.app_settings
  ADD COLUMN IF NOT EXISTS hub_url text,
  ADD COLUMN IF NOT EXISTS hub_token_enc text,
  ADD COLUMN IF NOT EXISTS hub_token_hint text,
  ADD COLUMN IF NOT EXISTS hub_last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS hub_last_ok_at timestamptz,
  ADD COLUMN IF NOT EXISTS hub_last_error text;
