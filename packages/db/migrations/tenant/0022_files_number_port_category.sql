-- Files module (packages/db/migrations/tenant/0019_files.sql): number-port
-- document uploads are the first customer-initiated writer, alongside the
-- server-generated deployment_change_document category.

ALTER TABLE {{SCHEMA}}.files DROP CONSTRAINT files_category_check;
ALTER TABLE {{SCHEMA}}.files ADD CONSTRAINT files_category_check
  CHECK (category IN ('deployment_change_document', 'number_port_document'));
