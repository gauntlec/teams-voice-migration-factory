-- Service Handover: an Issue step, and editable notes for the sections that have
-- no structured data source in Voxshift.
--
-- Issuing locks a draft pack as final (who and when). A pack's .docx is generated
-- when the draft is created, so issuing does not regenerate it.
ALTER TABLE {{SCHEMA}}.handover_packs
  ADD COLUMN issued_by uuid,
  ADD COLUMN issued_at timestamptz;
ALTER TABLE {{SCHEMA}}.handover_packs
  ADD CONSTRAINT handover_packs_issued_check CHECK ((status = 'issued') = (issued_at IS NOT NULL));

-- One note per (section, site); site_id NULL = applies to every site. These are
-- the four template sections nothing else in the platform collects: the support
-- model, paging, tenant-wide Teams configuration decisions, outstanding actions.
CREATE TABLE {{SCHEMA}}.handover_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_key text NOT NULL
    CHECK (section_key IN ('service_support_model', 'paging', 'teams_configuration', 'outstanding_actions')),
  site_id     uuid REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE CASCADE,
  body        text NOT NULL,
  updated_by  uuid NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX handover_notes_section_site_uq
  ON {{SCHEMA}}.handover_notes (section_key, COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid));
