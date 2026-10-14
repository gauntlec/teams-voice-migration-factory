-- Incidents by email (docs/INTAKE.md): reply tokens (one per incident per recipient, so a reply is tied to the person it was sent to),
-- a log of what became of each inbound message, and the Reply-To an outgoing message carries.
ALTER TABLE platform.email_messages ADD COLUMN reply_to text;

CREATE TABLE platform.inbound_reply_tokens (
  token       text PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  incident_id uuid NOT NULL,
  user_id     uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE UNIQUE INDEX inbound_reply_tokens_one_uq ON platform.inbound_reply_tokens (incident_id, user_id);
CREATE INDEX inbound_reply_tokens_expiry_idx ON platform.inbound_reply_tokens (expires_at);

CREATE TABLE platform.inbound_email_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  text NOT NULL UNIQUE,
  from_email  text NOT NULL,
  subject     text NOT NULL DEFAULT '',
  outcome     text NOT NULL,
  detail      text NOT NULL DEFAULT '',
  tenant_id   uuid REFERENCES platform.tenants(id) ON DELETE SET NULL,
  incident_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbound_email_log_created_idx ON platform.inbound_email_log (created_at DESC);
