-- Files sent with an email (docs/EMAIL.md): today the report PDF of a scheduled report (docs/INSIGHTS.md, step 4b). Kept with
-- the message so Resend sends the same file; removed with the message, and the content after 90 days.
CREATE TABLE platform.email_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   uuid NOT NULL REFERENCES platform.email_messages(id) ON DELETE CASCADE,
  filename     text NOT NULL,
  content_type text NOT NULL,
  content      bytea,
  size         integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_email_attachments_message ON platform.email_attachments(message_id);
