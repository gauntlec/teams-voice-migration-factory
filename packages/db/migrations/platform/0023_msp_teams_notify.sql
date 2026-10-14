-- Telling an MSP's Teams channel about what matters (docs/INTAKE.md). The webhook URL is a secret (encrypted); notifications go through an
-- outbox so a slow or failing channel never holds up an incident.
ALTER TABLE platform.msps
  ADD COLUMN teams_webhook_enc text,
  ADD COLUMN teams_notify jsonb NOT NULL DEFAULT '{"incidents": true, "major": true, "sla": true}'::jsonb;

CREATE TABLE platform.msp_notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  msp_id      uuid NOT NULL REFERENCES platform.msps(id) ON DELETE CASCADE,
  tenant_id   uuid REFERENCES platform.tenants(id) ON DELETE SET NULL,
  kind        text NOT NULL CHECK (kind IN ('incident', 'major', 'sla', 'test')),
  card        jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  attempts    integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX msp_notifications_due_idx ON platform.msp_notifications (next_attempt_at) WHERE status = 'queued';
