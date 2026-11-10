-- Files added to a feature request (Craig, 10 Nov 2026: the same as bug reports got in 0042): a mock-up, a spreadsheet, an example
-- document. Feature requests are platform-wide, so the bytes live here, as bug report attachments do. Removed with their request.
CREATE TABLE platform.feature_request_attachments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_request_id  uuid NOT NULL REFERENCES platform.feature_requests(id) ON DELETE CASCADE,
  filename            text NOT NULL,
  content_type        text NOT NULL,
  size                integer NOT NULL,
  content             bytea NOT NULL,
  uploaded_by         uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_feature_request_attachments_request ON platform.feature_request_attachments(feature_request_id);
