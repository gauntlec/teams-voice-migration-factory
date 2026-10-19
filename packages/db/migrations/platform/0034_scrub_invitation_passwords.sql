-- Invitation one-time passwords were stored in plain text in platform.email_messages.context (key "tempPassword") and kept for
-- ever. From this release the API stores them encrypted ("tempPasswordEnc") only until the worker has handled the message, and the
-- worker then removes them. This removes the ones already there.
--
-- Rows queued within the last day are left alone so an invitation that has not been delivered yet is not broken; the worker removes
-- the password once it handles them (sent, skipped or failed for good). Everything else is scrubbed now, including a row stuck as
-- 'queued' for more than a day (delivery is retried for minutes, not days).
UPDATE platform.email_messages
SET context = (context - 'tempPassword' - 'tempPasswordEnc') || '{"tempPasswordRemoved": true}'::jsonb
WHERE template = 'user_invitation'
  AND (status <> 'queued' OR created_at < now() - interval '1 day')
  AND (context ? 'tempPassword' OR context ? 'tempPasswordEnc');
