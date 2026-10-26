-- Number cool-off: a number released in Teams (seen by a Discovery sync) is held back from reassignment for a period, so its new
-- holder does not get the previous holder's calls. packages/db/src/number-cooloff.ts.
ALTER TABLE {{SCHEMA}}.phone_numbers
  ADD COLUMN cooling_until  timestamptz,
  ADD COLUMN cooling_reason text;

-- One row: the customer's cool-off period. 0 turns cool-off off.
CREATE TABLE {{SCHEMA}}.number_policy (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  cooloff_days integer NOT NULL DEFAULT 90 CHECK (cooloff_days BETWEEN 0 AND 3650)
);
INSERT INTO {{SCHEMA}}.number_policy DEFAULT VALUES;
