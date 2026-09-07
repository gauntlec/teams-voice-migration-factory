-- Narrative descriptions of the customer's existing call routing (auto
-- attendants, call queues, IVRs). Diagrams attach via attachments later.
CREATE TABLE {{SCHEMA}}.discovery_flows (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text NOT NULL CHECK (kind IN ('auto_attendant','call_queue','other')),
  name                 text NOT NULL,
  description          text,
  diagram_attachment_id uuid REFERENCES {{SCHEMA}}.attachments(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Track who accepted a submitted discovery and when.
ALTER TABLE {{SCHEMA}}.discovery
  ADD COLUMN IF NOT EXISTS accepted_by uuid,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
