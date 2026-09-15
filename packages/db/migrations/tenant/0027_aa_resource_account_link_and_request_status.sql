-- Closing the greenfield gap found while auditing Data Collection -> Design
-- & Build -> Deployment for Auto Attendants/Call Queues: a manually-created
-- AA had no writable way to link to a resource account (unlike Call Queue's
-- own resource_accounts array) - build_auto_attendants.resource_accounts is
-- dead and discovery_resource_account_id was only ever set by Populate.
--
-- 1. A direct, writable AA -> resource account link, mirroring Call Queue's
--    own pattern but singular (an AA has exactly one).
-- 2. requested_at/linked_at on build_resource_accounts, for the new
--    "Resource Account Request" workflow: an engineer models a not-yet-live
--    account, generates a request document for the customer (stamps
--    requested_at), and Discovery's next sync auto-detects fulfillment
--    (stamps linked_at + application_id) instead of a manual toggle only.

ALTER TABLE {{SCHEMA}}.build_auto_attendants
  ADD COLUMN resource_account_id uuid REFERENCES {{SCHEMA}}.build_resource_accounts(id) ON DELETE SET NULL;

ALTER TABLE {{SCHEMA}}.build_resource_accounts
  ADD COLUMN requested_at timestamptz,
  ADD COLUMN linked_at timestamptz;
