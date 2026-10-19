-- A customer's audit_log and deployment_changes can only be added to, never changed or emptied (docs/SECURITY.md
-- "Database access", docs/DB-LEAST-PRIVILEGE.md). A trigger refuses UPDATE, DELETE and TRUNCATE for every database
-- account, the owner the application connects as included. INSERT is untouched.
--
-- This is a tenant migration, so it runs for every existing customer when the API starts AND for every customer
-- created later (provisionTenant applies all tenant migrations): new customers are protected from the start.
--
-- Honest limits: the owner can still run ALTER TABLE ... DISABLE TRIGGER, and DROP SCHEMA ... CASCADE (removing a
-- whole customer) does not fire a row trigger, so it still works. This stops application bugs and a compromised
-- application code path, not a database administrator. Nothing in the application updates or deletes these rows.
--
-- deployment_changes.deployment_id is ON DELETE CASCADE from deployments: deleting a deployment would now be refused
-- while it has changes. Nothing deletes a deployment (they are kept as the change history).
--
-- The function lives in the customer's own schema so a customer schema stays self-contained.

CREATE OR REPLACE FUNCTION {{SCHEMA}}.audit_refuse_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit table %.% is append-only: % is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_append_only_rows ON {{SCHEMA}}.audit_log;
CREATE TRIGGER audit_append_only_rows
  BEFORE UPDATE OR DELETE ON {{SCHEMA}}.audit_log
  FOR EACH ROW EXECUTE FUNCTION {{SCHEMA}}.audit_refuse_change();
DROP TRIGGER IF EXISTS audit_append_only_truncate ON {{SCHEMA}}.audit_log;
CREATE TRIGGER audit_append_only_truncate
  BEFORE TRUNCATE ON {{SCHEMA}}.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION {{SCHEMA}}.audit_refuse_change();

DROP TRIGGER IF EXISTS audit_append_only_rows ON {{SCHEMA}}.deployment_changes;
CREATE TRIGGER audit_append_only_rows
  BEFORE UPDATE OR DELETE ON {{SCHEMA}}.deployment_changes
  FOR EACH ROW EXECUTE FUNCTION {{SCHEMA}}.audit_refuse_change();
DROP TRIGGER IF EXISTS audit_append_only_truncate ON {{SCHEMA}}.deployment_changes;
CREATE TRIGGER audit_append_only_truncate
  BEFORE TRUNCATE ON {{SCHEMA}}.deployment_changes
  FOR EACH STATEMENT EXECUTE FUNCTION {{SCHEMA}}.audit_refuse_change();
