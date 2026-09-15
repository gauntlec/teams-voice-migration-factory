-- Get-CsOnlineVoicemailUserSettings is real and per-user (confirmed against
-- Microsoft Learn) - it just has no bulk/wildcard form, so it was never part
-- of the full-tenant Get-CsOnlineUser sweep. Design & Build's "Validate
-- against tenant" already runs a targeted per-UPN live check
-- (runTargetedUserSync in apps/worker/src/discovery/run.ts) for exactly this
-- kind of data; it now also calls Get-CsOnlineVoicemailUserSettings per UPN
-- and stores the result here, so planIdentityRow can diff against it instead
-- of always re-issuing Set-CsOnlineVoicemailUserSettings.

ALTER TABLE {{SCHEMA}}.tenant_users
  ADD COLUMN voicemail_enabled boolean,
  ADD COLUMN voicemail_prompt_language text;
