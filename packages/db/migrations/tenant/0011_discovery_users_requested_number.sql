-- Import from Excel: the phone number the customer asked for, as typed in the
-- spreadsheet. Kept separate from the inventory reference (phone_numbers.holder
-- / phone_number_id) - matching the requested number to a real one, or spotting
-- that the user already has a different number, is a Design & Build concern.
-- Data Collection just stores what was requested and flags the mismatch.
ALTER TABLE {{SCHEMA}}.discovery_users ADD COLUMN requested_number text;
