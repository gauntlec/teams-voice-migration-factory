-- Deleting a customer for good (docs/SECURITY.md "Deleting a customer"). The customer is first marked 'deleting': it disappears from
-- every list, nobody can open it any more, and background work skips it. Only then is its data removed, so a deletion that stops part
-- way can simply be started again and finish.
--
-- deletion_summary holds the counts shown to the Super Admin before they confirmed (numbers only, never customer content). It is kept
-- so that a second attempt can still report what was removed after the customer's own database has already gone.

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'platform.tenants'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%status%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE platform.tenants DROP CONSTRAINT %I', c); END IF;
END $$;

ALTER TABLE platform.tenants
  ADD CONSTRAINT tenants_status_check CHECK (status IN ('active', 'archived', 'deleting'));

ALTER TABLE platform.tenants
  ADD COLUMN deletion_started_at timestamptz,
  ADD COLUMN deletion_started_by uuid,
  ADD COLUMN deletion_summary    jsonb;
