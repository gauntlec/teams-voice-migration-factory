-- Managed Services, phase 4.
--
-- * new_users: several new starters in one request; the free numbers picked
--   for them are in details.new_numbers ({ upn: e164 }).
-- * Approval: a request of a type the customer wants approved waits for one
--   of their approvers (platform.tenants.sr_settings.approval).
--   approval_status: null (not needed) | pending | approved | rejected.
-- * service_request_items: 'number_range' - numbers added to the site's
--   inventory for a "new phone numbers" request.
-- * Events: 'approval' (approved / rejected, body = note) and 'attachment'
--   (body = filename).
-- * files: 'service_request_attachment'.
ALTER TABLE {{SCHEMA}}.service_requests DROP CONSTRAINT IF EXISTS service_requests_type_check;
ALTER TABLE {{SCHEMA}}.service_requests
  ADD CONSTRAINT service_requests_type_check CHECK (type IN (
    'new_site', 'new_user', 'new_users', 'new_phone_numbers', 'new_common_area_phone', 'new_call_queue', 'new_auto_attendant',
    'change_user', 'change_call_queue', 'change_auto_attendant', 'remove_user', 'remove_common_area_phone',
    'other'
  ));
ALTER TABLE {{SCHEMA}}.service_requests
  ADD COLUMN approval_status text CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN approval_by uuid,
  ADD COLUMN approval_at timestamptz,
  ADD COLUMN approval_note text;

ALTER TABLE {{SCHEMA}}.service_request_items DROP CONSTRAINT IF EXISTS service_request_items_kind_check;
ALTER TABLE {{SCHEMA}}.service_request_items
  ADD CONSTRAINT service_request_items_kind_check
  CHECK (kind IN ('site', 'user', 'cap', 'resource_account', 'shared_calling_policy', 'call_queue', 'auto_attendant', 'number_range'));

ALTER TABLE {{SCHEMA}}.service_request_events DROP CONSTRAINT IF EXISTS service_request_events_kind_check;
ALTER TABLE {{SCHEMA}}.service_request_events
  ADD CONSTRAINT service_request_events_kind_check
  CHECK (kind IN ('created', 'status_changed', 'assigned', 'comment', 'build_drafted', 'deployment', 'waiting', 'resumed', 'approval', 'attachment'));

ALTER TABLE {{SCHEMA}}.files DROP CONSTRAINT IF EXISTS files_category_check;
ALTER TABLE {{SCHEMA}}.files
  ADD CONSTRAINT files_category_check
  CHECK (category IN ('deployment_change_document', 'number_port_document', 'resource_account_request', 'handover_pack', 'service_request_attachment'));
