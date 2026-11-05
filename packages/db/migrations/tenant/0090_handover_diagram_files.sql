-- A handover pack's call flow diagrams (docs/DATA-MODEL.md, Service Handover): pictures the browser draws when a pack is generated,
-- kept so issuing the pack later prints the same ones. They belong to the pack, so the Files page doesn't list them.
ALTER TABLE {{SCHEMA}}.files DROP CONSTRAINT IF EXISTS files_category_check;
ALTER TABLE {{SCHEMA}}.files
  ADD CONSTRAINT files_category_check
  CHECK (category IN ('deployment_change_document', 'number_port_document', 'resource_account_request', 'handover_pack', 'handover_diagram', 'service_request_attachment', 'incident_attachment'));
