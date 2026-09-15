-- Same pattern as 0022_files_number_port_category.sql: a new files.category
-- value for the "Resource Account Request" document Design & Build can now
-- generate for a customer, listing not-yet-live resource accounts to create
-- and license.

ALTER TABLE {{SCHEMA}}.files DROP CONSTRAINT files_category_check;
ALTER TABLE {{SCHEMA}}.files ADD CONSTRAINT files_category_check
  CHECK (category IN ('deployment_change_document', 'number_port_document', 'resource_account_request'));
