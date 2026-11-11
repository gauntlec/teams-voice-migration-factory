-- Replies on a Bug reports or Feature requests card (Craig, 11 Nov 2026): the reporter answering our questions, staff asking more, anyone
-- who can see the board adding feedback - on the card, instead of by chat. Each board keeps its own table, keyed to its cards the same way
-- their attachments are (0042, 0043). Removed with their card. A reply can carry files: they go in the card's attachments table with
-- reply_id set, so downloads use the card's attachment route and a file goes when its reply does.
CREATE TABLE platform.bug_report_replies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bug_report_id  uuid NOT NULL REFERENCES platform.bug_reports(id) ON DELETE CASCADE,
  body           text NOT NULL,
  author_id      uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_bug_report_replies_report ON platform.bug_report_replies(bug_report_id, created_at);

CREATE TABLE platform.feature_request_replies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_request_id  uuid NOT NULL REFERENCES platform.feature_requests(id) ON DELETE CASCADE,
  body                text NOT NULL,
  author_id           uuid REFERENCES platform.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_feature_request_replies_request ON platform.feature_request_replies(feature_request_id, created_at);

ALTER TABLE platform.bug_report_attachments ADD COLUMN reply_id uuid REFERENCES platform.bug_report_replies(id) ON DELETE CASCADE;
CREATE INDEX idx_bug_report_attachments_reply ON platform.bug_report_attachments(reply_id) WHERE reply_id IS NOT NULL;
ALTER TABLE platform.feature_request_attachments ADD COLUMN reply_id uuid REFERENCES platform.feature_request_replies(id) ON DELETE CASCADE;
CREATE INDEX idx_feature_request_attachments_reply ON platform.feature_request_attachments(reply_id) WHERE reply_id IS NOT NULL;
