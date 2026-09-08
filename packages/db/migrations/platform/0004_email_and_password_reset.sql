-- Forced first-sign-in password reset + the email communication log.

ALTER TABLE platform.users
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN password_changed_at  timestamptz;

-- Every message the platform sends. The API inserts a row (status 'queued') and
-- enqueues a 'mail' job; the worker renders it, delivers it via SMTP and updates
-- the row. Generic on purpose so future workflow/approval/review notifications
-- reuse it.
CREATE TABLE platform.email_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email     citext NOT NULL,
  to_name      text,
  template     text NOT NULL,
  context      jsonb NOT NULL DEFAULT '{}'::jsonb,
  subject      text,
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','sent','failed','skipped')),
  error        text,
  attempts     integer NOT NULL DEFAULT 0,
  related_type text,
  related_id   text,
  created_by   uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz
);
CREATE INDEX idx_email_messages_created_at ON platform.email_messages(created_at DESC);
CREATE INDEX idx_email_messages_related ON platform.email_messages(related_type, related_id);
