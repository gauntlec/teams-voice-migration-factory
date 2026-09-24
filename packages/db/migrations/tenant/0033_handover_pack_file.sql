-- Service Handover now generates a real branded .docx (see
-- HandoverDocumentService/HandoverService) instead of an empty content: {}
-- scaffold. handover_packs.file (an unused bytea column - the docs storing
-- it never got written) is replaced by file_id, a normal reference into the
-- shared `files` table (same pattern deployment_change_document/
-- number_port_document/resource_account_request already use), so the
-- generated pack is downloadable via the existing GET .../files/:id/download
-- route.

ALTER TABLE {{SCHEMA}}.handover_packs DROP COLUMN file;
ALTER TABLE {{SCHEMA}}.handover_packs
  ADD COLUMN file_id uuid REFERENCES {{SCHEMA}}.files(id) ON DELETE SET NULL;

ALTER TABLE {{SCHEMA}}.files DROP CONSTRAINT files_category_check;
ALTER TABLE {{SCHEMA}}.files ADD CONSTRAINT files_category_check
  CHECK (category IN ('deployment_change_document', 'number_port_document', 'resource_account_request', 'handover_pack'));
