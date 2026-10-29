-- Parked numbers: a spare number the customer keeps with the carrier for a small retention fee instead of the full fee of a
-- working number. A project manager or engineer parks spare numbers before the site moves to operations; after that a number
-- is parked or brought back into use only through a "Park or unpark phone numbers" service request. A parked number cannot
-- be given to a user, phone or resource account until it is unparked.
ALTER TABLE {{SCHEMA}}.phone_numbers DROP CONSTRAINT IF EXISTS phone_numbers_status_check;
ALTER TABLE {{SCHEMA}}.phone_numbers
  ADD CONSTRAINT phone_numbers_status_check CHECK (status IN ('available', 'reserved', 'assigned', 'parked'));
ALTER TABLE {{SCHEMA}}.phone_numbers
  ADD COLUMN parked_at timestamptz,  -- when it was last parked; null while not parked
  ADD COLUMN parked_by uuid;         -- who parked it (the person, or the assistant that completed the request)

ALTER TABLE {{SCHEMA}}.service_requests DROP CONSTRAINT IF EXISTS service_requests_type_check;
ALTER TABLE {{SCHEMA}}.service_requests
  ADD CONSTRAINT service_requests_type_check CHECK (type IN (
    'new_site', 'new_user', 'new_users', 'new_phone_numbers', 'new_common_area_phone', 'new_call_queue', 'new_auto_attendant',
    'change_user', 'change_call_queue', 'change_auto_attendant', 'change_number_state', 'remove_user', 'remove_common_area_phone',
    'other'
  ));
