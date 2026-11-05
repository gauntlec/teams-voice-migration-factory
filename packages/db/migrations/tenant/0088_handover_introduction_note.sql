-- The handover pack's Introduction can be written as a note (docs/DATA-MODEL.md, Service Handover): the standard text is
-- printed until one is written. Adds 'introduction' to the sections a handover note may belong to.
ALTER TABLE {{SCHEMA}}.handover_notes DROP CONSTRAINT IF EXISTS handover_notes_section_key_check;
ALTER TABLE {{SCHEMA}}.handover_notes
  ADD CONSTRAINT handover_notes_section_key_check
  CHECK (section_key IN ('introduction', 'service_support_model', 'paging', 'teams_configuration', 'outstanding_actions'));
