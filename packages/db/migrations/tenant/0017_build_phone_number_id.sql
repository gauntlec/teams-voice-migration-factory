-- build_users/build_caps/build_resource_accounts need a real link to the
-- phone_numbers row their e164 came from - not just a copied text value.
-- This is deliberately NOT the same thing as phone_numbers.holder_type/
-- holder_id (the exclusive "who currently owns this DID" claim, which stays
-- with discovery_users/discovery_caps for an imported number - see
-- BuildService.populateUsers). phone_number_id is a plain reference: it lets
-- the Edit dialog's picker show "(current)" correctly and lets duplicate
-- detection use a real id instead of comparing e164 strings, without
-- contending for the single holder slot Data Collection still occupies.
-- Set ON DELETE SET NULL: deleting a phone_numbers row (should basically
-- never happen) just un-links it rather than blocking or cascading.

ALTER TABLE {{SCHEMA}}.build_users
  ADD COLUMN phone_number_id uuid REFERENCES {{SCHEMA}}.phone_numbers(id) ON DELETE SET NULL;
ALTER TABLE {{SCHEMA}}.build_caps
  ADD COLUMN phone_number_id uuid REFERENCES {{SCHEMA}}.phone_numbers(id) ON DELETE SET NULL;
ALTER TABLE {{SCHEMA}}.build_resource_accounts
  ADD COLUMN phone_number_id uuid REFERENCES {{SCHEMA}}.phone_numbers(id) ON DELETE SET NULL;

-- Backfill: reconcile any row that already has an e164/phone_number (from
-- Populate before this column existed) against the inventory by exact match,
-- so existing data gets linked without needing a Reset + re-Populate.
UPDATE {{SCHEMA}}.build_users bu
  SET phone_number_id = pn.id
  FROM {{SCHEMA}}.phone_numbers pn
  WHERE bu.phone_number_id IS NULL AND bu.e164 IS NOT NULL AND pn.e164 = bu.e164;

UPDATE {{SCHEMA}}.build_caps bc
  SET phone_number_id = pn.id
  FROM {{SCHEMA}}.phone_numbers pn
  WHERE bc.phone_number_id IS NULL AND bc.e164 IS NOT NULL AND pn.e164 = bc.e164;

UPDATE {{SCHEMA}}.build_resource_accounts bra
  SET phone_number_id = pn.id
  FROM {{SCHEMA}}.phone_numbers pn
  WHERE bra.phone_number_id IS NULL AND bra.phone_number IS NOT NULL AND pn.e164 = bra.phone_number;
