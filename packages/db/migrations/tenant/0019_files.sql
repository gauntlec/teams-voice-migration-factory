-- General-purpose per-tenant file storage on local disk, indexed here.
-- First consumer: Deployment change-recording .docx files. Designed for
-- reuse by Data Collection, Discovery, Design & Build and Service Handover
-- as future producers - category + source_type/source_id discriminate what
-- a file belongs to without a schema change per consumer. Local disk
-- (FILES_DIR), not bytea - unlike the existing unused {{SCHEMA}}.attachments
-- table and handover_packs.file, both left alone this pass.

CREATE TABLE {{SCHEMA}}.files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category      text NOT NULL CHECK (category IN ('deployment_change_document')),
  source_type   text NOT NULL,   -- e.g. 'deployment_site' - polymorphic, not FK'd
  source_id     uuid NOT NULL,
  site_id       uuid REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE CASCADE,
  filename      text NOT NULL,
  content_type  text NOT NULL,
  byte_size     bigint NOT NULL,
  storage_path  text NOT NULL,   -- relative path under FILES_DIR
  uploaded_by   uuid,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_files_site ON {{SCHEMA}}.files(site_id);
CREATE INDEX idx_files_source ON {{SCHEMA}}.files(source_type, source_id);
CREATE INDEX idx_files_category ON {{SCHEMA}}.files(category);
