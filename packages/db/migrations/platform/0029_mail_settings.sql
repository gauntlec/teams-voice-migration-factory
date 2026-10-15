-- Email settings inside the app (Administration > Platform settings > Email), so they no longer need editing in the stack's .env.
-- mail_mode NULL = nothing saved here yet: the SMTP_* / MAIL_FROM environment values apply, exactly as before.
--   none = send nothing;  smtp = this installation's own mail server;  hub = relay through the Voxshift Hub it is connected to.
ALTER TABLE platform.app_settings
  ADD COLUMN IF NOT EXISTS mail_mode text CHECK (mail_mode IN ('none', 'smtp', 'hub')),
  ADD COLUMN IF NOT EXISTS smtp_host text,
  ADD COLUMN IF NOT EXISTS smtp_port integer,
  ADD COLUMN IF NOT EXISTS smtp_secure boolean,
  ADD COLUMN IF NOT EXISTS smtp_user text,
  ADD COLUMN IF NOT EXISTS smtp_pass_enc text,
  ADD COLUMN IF NOT EXISTS mail_from text,
  ADD COLUMN IF NOT EXISTS mail_from_name text,
  -- What the hub last said about its mail service for this installation (from the heartbeat reply); null until it has said.
  ADD COLUMN IF NOT EXISTS hub_mail_relay boolean;
