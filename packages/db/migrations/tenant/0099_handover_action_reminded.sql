-- When an outstanding action was last in a reminder email (docs/HANDOVER-VIEW.md step 4): it is reminded again once the customer's
-- reminder interval has passed since then.
ALTER TABLE {{SCHEMA}}.handover_actions
  ADD COLUMN last_reminded_at timestamptz;
