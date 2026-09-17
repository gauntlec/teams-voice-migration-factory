-- Corrects the AA<->resource-account relationship: Microsoft Learn confirms
-- New-CsOnlineApplicationInstanceAssociation's -Identities takes an array,
-- and a real Get-CsAutoAttendant's ApplicationInstances can list several
-- resource accounts against one AA (one documented example associates
-- three) - a one-to-many relationship, not the 1:1
-- build_auto_attendants.resource_account_id (added last migration) modeled.
-- Call Queue already gets this right via its own resource_accounts array;
-- build_auto_attendants has carried the identical column, unused, since
-- 0001_init.sql - this just backfills and wires it up the same way.

-- 1. Backfill from the Populate-time correlation: any AA row without its
--    own resource_accounts yet, matched to a build_resource_accounts row
--    that shares the same discovery_resource_account_id (both were created
--    together by BuildService.populateResourceAccounts).
UPDATE {{SCHEMA}}.build_auto_attendants aa
SET resource_accounts = to_jsonb(ARRAY[ra.id])
FROM {{SCHEMA}}.build_resource_accounts ra
WHERE aa.discovery_resource_account_id IS NOT NULL
  AND ra.discovery_resource_account_id = aa.discovery_resource_account_id
  AND (aa.resource_accounts IS NULL OR aa.resource_accounts = '[]'::jsonb);

-- 2. Fold in any manually-set singular link too (append, de-duplicated -
--    in case a row somehow already picked up a different id from step 1).
UPDATE {{SCHEMA}}.build_auto_attendants
SET resource_accounts = (
  SELECT to_jsonb(array_agg(DISTINCT x))
  FROM jsonb_array_elements_text(coalesce(resource_accounts, '[]'::jsonb) || to_jsonb(ARRAY[resource_account_id::text])) AS x
)
WHERE resource_account_id IS NOT NULL;

-- 3. Retire the singular column - added this same session, never reached
--    real use beyond what this migration just folded into the array above.
ALTER TABLE {{SCHEMA}}.build_auto_attendants DROP COLUMN resource_account_id;
