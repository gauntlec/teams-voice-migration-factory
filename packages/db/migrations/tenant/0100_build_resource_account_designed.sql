-- Bug report "Design and Build - Resource Account" (11 Nov 2026): a resource account brought in from Site Data showed as "designed"
-- before anyone had looked at it. It now shows "imported" until an engineer edits it or confirms nothing needs changing (designed_at).
-- Existing rows: made by hand, or edited since they were brought in, count as designed.
ALTER TABLE {{SCHEMA}}.build_resource_accounts
  ADD COLUMN designed_at timestamptz;

UPDATE {{SCHEMA}}.build_resource_accounts
   SET designed_at = updated_at
 WHERE discovery_resource_account_id IS NULL
    OR updated_at > created_at + interval '1 second';
