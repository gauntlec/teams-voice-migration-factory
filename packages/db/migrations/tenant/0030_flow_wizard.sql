-- Backs the new plain-language Auto Attendant / Call Queue creation wizard
-- (Data Collection site workspace, "Call flows" tab). The wizard writes its
-- structured, non-technical capture onto the same discovery_flows row the
-- existing free-text "Add" flow already creates - `wizard_answers` null
-- means "created the old freeform way" (Source: Manual in the UI), non-null
-- means "Source: Wizard". `resource_account_id` is the optional "which
-- phone identity will answer this" link, picked from this site's existing
-- discovery_resource_accounts. `imported_at`/`build_auto_attendant_id`/
-- `build_call_queue_id` track the one-click "Import to Design & Build"
-- action that converts the capture into a real, engineer-reviewable
-- build_auto_attendants/build_call_queues row.

ALTER TABLE {{SCHEMA}}.discovery_flows
  ADD COLUMN wizard_answers jsonb,
  ADD COLUMN wizard_version integer,
  ADD COLUMN resource_account_id uuid REFERENCES {{SCHEMA}}.discovery_resource_accounts(id) ON DELETE SET NULL,
  ADD COLUMN imported_at timestamptz,
  ADD COLUMN build_auto_attendant_id uuid REFERENCES {{SCHEMA}}.build_auto_attendants(id) ON DELETE SET NULL,
  ADD COLUMN build_call_queue_id uuid REFERENCES {{SCHEMA}}.build_call_queues(id) ON DELETE SET NULL;
