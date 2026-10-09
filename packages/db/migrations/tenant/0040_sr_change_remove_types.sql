-- Managed Services, phase 2: change and remove requests (see
-- packages/shared/src/service-request-change.ts).
ALTER TABLE {{SCHEMA}}.service_requests DROP CONSTRAINT IF EXISTS service_requests_type_check;
ALTER TABLE {{SCHEMA}}.service_requests
  ADD CONSTRAINT service_requests_type_check CHECK (type IN (
    'new_site', 'new_user', 'new_phone_numbers', 'new_common_area_phone', 'new_call_queue', 'new_auto_attendant',
    'change_user', 'change_call_queue', 'change_auto_attendant', 'remove_user', 'remove_common_area_phone',
    'other'
  ));
