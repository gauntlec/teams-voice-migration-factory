-- The platform audit log can only be added to, never changed or emptied (docs/SECURITY.md "Database access",
-- docs/DB-LEAST-PRIVILEGE.md). A trigger refuses UPDATE, DELETE and TRUNCATE for every database account, the
-- owner the application connects as included. INSERT is untouched.
--
-- Honest limits: the owner of the table can still run ALTER TABLE ... DISABLE TRIGGER (or DROP the trigger), and
-- DROP SCHEMA / DROP TABLE do not fire it. This stops application bugs and a compromised application code path, not
-- a database administrator. Nothing in the application updates or deletes these rows, so there is no bypass.
--
-- Safe on a populated database (no rows are read or written) and on a new one; running it twice does nothing new.

CREATE OR REPLACE FUNCTION platform.audit_refuse_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit table %.% is append-only: % is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_append_only_rows ON platform.platform_audit_log;
CREATE TRIGGER audit_append_only_rows
  BEFORE UPDATE OR DELETE ON platform.platform_audit_log
  FOR EACH ROW EXECUTE FUNCTION platform.audit_refuse_change();

DROP TRIGGER IF EXISTS audit_append_only_truncate ON platform.platform_audit_log;
CREATE TRIGGER audit_append_only_truncate
  BEFORE TRUNCATE ON platform.platform_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION platform.audit_refuse_change();
