-- Handover packs carry a major.minor version (docs/DATA-MODEL.md, Service Handover): drafts are 0.1, 0.2, … until the first
-- pack is issued, which becomes 1.0; later packs are 1.1, 1.2, … (a draft until issued). Existing packs are labelled the same way
-- from their order.
ALTER TABLE {{SCHEMA}}.handover_packs ADD COLUMN IF NOT EXISTS version_label text;

WITH first_issued AS (SELECT min(version) AS v FROM {{SCHEMA}}.handover_packs WHERE status = 'issued')
UPDATE {{SCHEMA}}.handover_packs p
SET version_label = CASE
  WHEN f.v IS NULL OR p.version < f.v THEN '0.' || p.version
  WHEN p.version = f.v THEN '1.0'
  ELSE '1.' || (SELECT count(*) FROM {{SCHEMA}}.handover_packs q WHERE q.version > f.v AND q.version <= p.version)
END
FROM first_issued f
WHERE p.version_label IS NULL;
