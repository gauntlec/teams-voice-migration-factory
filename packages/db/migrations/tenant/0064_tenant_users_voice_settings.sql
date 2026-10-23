-- Everything per-user that Teams voice has beyond the Get-CsOnlineUser sweep, read for voice-enabled users only:
--   calling_settings    Get-CsUserCallingSettings, in the shape Design & Build designs it (call_forwarding / pickup_group / delegates)
--   voicemail_settings  Get-CsOnlineVoicemailUserSettings, as Teams returns it (the enabled flag and language also stay in their own columns)
ALTER TABLE {{SCHEMA}}.tenant_users
  ADD COLUMN calling_settings   jsonb,
  ADD COLUMN voicemail_settings jsonb,
  ADD COLUMN voice_settings_at  timestamptz;
CREATE INDEX idx_tenant_users_voice_settings_at ON {{SCHEMA}}.tenant_users (voice_settings_at NULLS FIRST) WHERE removed_at IS NULL;
