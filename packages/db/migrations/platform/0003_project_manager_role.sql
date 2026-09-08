-- New PROJECT_MANAGER role: a delivery lead assigned to one or more customers
-- (like ENGINEER, always whole-customer). Widen the role CHECK constraints on
-- both platform.users and platform.invitations. Drop by discovered name so this
-- works whatever Postgres auto-named the original constraint.

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'platform.users'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%role%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE platform.users DROP CONSTRAINT %I', c); END IF;

  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'platform.invitations'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%role%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE platform.invitations DROP CONSTRAINT %I', c); END IF;
END $$;

ALTER TABLE platform.users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('SUPER_ADMIN', 'PROJECT_MANAGER', 'ENGINEER', 'CUSTOMER'));

ALTER TABLE platform.invitations
  ADD CONSTRAINT invitations_role_check
  CHECK (role IN ('SUPER_ADMIN', 'PROJECT_MANAGER', 'ENGINEER', 'CUSTOMER'));
