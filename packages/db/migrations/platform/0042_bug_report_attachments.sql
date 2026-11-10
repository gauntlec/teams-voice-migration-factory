-- Files added to a bug report (bug report "attach a PDF to a report"): a screenshot, a log, a written-up investigation. Bug reports are
-- platform-wide, not one customer's, so the bytes live here rather than in a customer's file store, the same way email attachments do.
-- Removed with their report.
CREATE TABLE platform.bug_report_attachments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bug_report_id  uuid NOT NULL REFERENCES platform.bug_reports(id) ON DELETE CASCADE,
  filename       text NOT NULL,
  content_type   text NOT NULL,
  size           integer NOT NULL,
  content        bytea NOT NULL,
  uploaded_by    uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_bug_report_attachments_report ON platform.bug_report_attachments(bug_report_id);
