-- LOA / number-port document collection & tracking (feature request "LOA
-- Data Collection and Tracking"). Three tiers, decided after review with the
-- requester:
--   1. port_document_types      - global catalog of every document type
--                                 Voxshift has ever needed, across every
--                                 country. Grows over time; editable by
--                                 PM/Engineer (discovery:sites:manage), no
--                                 code change needed to add a type.
--   2. site_port_document_types - which of the global catalog applies to
--                                 THIS site (country-specific subset).
--   3. number_port_request_items - for one specific number-port request,
--                                 PM/Engineer picks from the site's *enabled*
--                                 subset (not the whole catalog).
-- A request's overall status also mirrors onto the existing (previously
-- dead) discovery_number_ranges.port_status column, so the Number Ranges
-- grid can show port progress without a join.

CREATE TABLE {{SCHEMA}}.port_document_types (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text NOT NULL UNIQUE,
  label      text NOT NULL,
  ordinal    integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO {{SCHEMA}}.port_document_types (key, label, ordinal) VALUES
  ('loa', 'Letter of Authorization (LOA)', 0),
  ('csr', 'Customer Service Record (CSR)', 1),
  ('invoice', 'Invoice', 2),
  ('company_reg_doc', 'Company Registration Document', 3),
  ('id', 'ID', 4),
  ('company_reg_number', 'Company Registration Number', 5);

CREATE TABLE {{SCHEMA}}.site_port_document_types (
  site_id           uuid NOT NULL REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE CASCADE,
  document_type_id  uuid NOT NULL REFERENCES {{SCHEMA}}.port_document_types(id) ON DELETE CASCADE,
  enabled           boolean NOT NULL DEFAULT true,
  PRIMARY KEY (site_id, document_type_id)
);

CREATE TABLE {{SCHEMA}}.number_port_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  range_id         uuid NOT NULL REFERENCES {{SCHEMA}}.discovery_number_ranges(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'awaiting_documents', 'complete')),
  submitted_by     uuid,
  submitted_at     timestamptz,
  reminder_sent_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_number_port_requests_range ON {{SCHEMA}}.number_port_requests(range_id);

CREATE TABLE {{SCHEMA}}.number_port_request_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id       uuid NOT NULL REFERENCES {{SCHEMA}}.number_port_requests(id) ON DELETE CASCADE,
  document_type_id uuid NOT NULL REFERENCES {{SCHEMA}}.port_document_types(id) ON DELETE RESTRICT,
  -- e.g. "authorized signer: Jane Doe" for the ID item - the one document
  -- type in the requester's list that needs a per-request specifier.
  note             text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded', 'rejected', 'waived')),
  reject_reason    text,
  file_id          uuid REFERENCES {{SCHEMA}}.files(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_number_port_request_items_request ON {{SCHEMA}}.number_port_request_items(request_id);
