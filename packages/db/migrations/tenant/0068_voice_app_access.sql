-- Auto attendant and call queue settings Microsoft documents as PowerShell only (packages/shared/src/voice-app-access.ts):
-- authorised users and the hidden ones (UPNs), the auto attendant's dial-by-name extension, the queue's AI voicemail triage
-- template. NULL = not managed by Voxshift: the deployment leaves whatever Teams has.
ALTER TABLE {{SCHEMA}}.build_call_queues
  ADD COLUMN authorized_users             jsonb,
  ADD COLUMN hide_authorized_users        jsonb,
  ADD COLUMN voicemail_triage_template_id text;
ALTER TABLE {{SCHEMA}}.build_auto_attendants
  ADD COLUMN authorized_users      jsonb,
  ADD COLUMN hide_authorized_users jsonb,
  ADD COLUMN user_name_extension   text CHECK (user_name_extension IN ('None', 'Office', 'Department'));
