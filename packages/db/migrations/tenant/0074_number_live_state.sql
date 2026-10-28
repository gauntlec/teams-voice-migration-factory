-- What Teams says about each number, written by the Discovery sync (number-reconcile.ts). Teams wins: a number live in Teams is shown as
-- assigned to its real holder whatever the plan says. When the Data Collection holder differs, `conflict` says so for an engineer to resolve.
ALTER TABLE {{SCHEMA}}.phone_numbers
  ADD COLUMN live_status       text,         -- Teams' PstnAssignmentStatus while the number is assigned there; null = not assigned in Teams
  ADD COLUMN live_holder_kind  text,         -- user | resource_account | other
  ADD COLUMN live_holder_upn   text,
  ADD COLUMN live_holder_name  text,
  ADD COLUMN live_seen_at      timestamptz,  -- the Discovery sync that last saw it assigned
  ADD COLUMN live_only         boolean NOT NULL DEFAULT false, -- the number is assigned only because Teams has it (nothing in Data Collection claims it)
  ADD COLUMN conflict          text;         -- plain-words clash between Teams and the Data Collection holder, null = none
CREATE INDEX idx_phone_conflict ON {{SCHEMA}}.phone_numbers(conflict) WHERE conflict IS NOT NULL;
-- Assigned means a Data Collection holder has it, or Teams does (live_only).
ALTER TABLE {{SCHEMA}}.phone_numbers DROP CONSTRAINT assigned_iff_held;
ALTER TABLE {{SCHEMA}}.phone_numbers ADD CONSTRAINT assigned_iff_held CHECK ((status = 'assigned') = (holder_id IS NOT NULL OR live_only));
