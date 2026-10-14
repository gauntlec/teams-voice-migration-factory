-- Knowledge saved from resolved incidents (docs/INTAKE.md): the symptoms, the fix, and a tip a customer can try. Suggested on new incidents.
CREATE TABLE {{SCHEMA}}.incident_knowledge (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL,
  category      text NOT NULL,
  subcategory   text,
  symptoms      text NOT NULL DEFAULT '',
  fix           text NOT NULL,
  -- Shown to customers on the raise form when it matches; empty = staff only.
  customer_text text NOT NULL DEFAULT '',
  source_incident_id uuid REFERENCES {{SCHEMA}}.incidents(id) ON DELETE SET NULL,
  helpful       integer NOT NULL DEFAULT 0,
  not_helpful   integer NOT NULL DEFAULT 0,
  archived      boolean NOT NULL DEFAULT false,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_knowledge_category_idx ON {{SCHEMA}}.incident_knowledge (category) WHERE NOT archived;
