-- Two additions, both found while reverse-engineering OVP012's real Auto
-- Attendants/Call Queue against the live tenant:
--
-- 1. build_call_queues was missing Set-CsCallQueue's NoAgentAction/
--    NoAgentActionTarget/NoAgentApplyTo parameter set entirely (what
--    happens when zero agents are opted in - distinct from Overflow/
--    Timeout, which OVP012's real CQ-US-OVP012-BHA Parts & SalesCustomerService
--    queue actually has configured). Same shape as overflow/timeout
--    (0024_call_queues.sql).
--
-- 2. build_auto_attendants gets real Set-CsAutoAttendant-shaped columns,
--    replacing the narrative-only fields added in 0024 (kept alongside,
--    not removed) - business/after-hours/holiday call flows, each an
--    ordered DTMF menu, plus the schedules that gate them. Confirmed
--    against the real live OVP012 AAs and against Microsoft Learn's
--    New-CsAutoAttendant construction chain (New-CsAutoAttendantCallableEntity
--    -> ...Prompt -> ...MenuOption -> ...Menu -> ...CallFlow ->
--    New-CsOnlineSchedule -> ...CallHandlingAssociation -> New-CsAutoAttendant).

ALTER TABLE {{SCHEMA}}.build_call_queues
  ADD COLUMN no_agent_action jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN no_agent_apply_to text CHECK (no_agent_apply_to IN ('AllCalls', 'NewCalls'));

ALTER TABLE {{SCHEMA}}.build_auto_attendants
  ADD COLUMN language_id text,
  ADD COLUMN time_zone_id text,
  ADD COLUMN voice_id text,
  ADD COLUMN voice_response_enabled boolean NOT NULL DEFAULT false,
  -- A callable-entity reference ({kind:'user'|'external', upn|number}) - who
  -- Operator/TransferCallToOperator targets. Null = no operator configured.
  ADD COLUMN operator jsonb,
  -- Each *_call_flow is { greetings: [...], menu: { enableDialByName, directorySearchMethod, options: [...] } }.
  -- default_call_flow is mandatory to deploy (Set-CsAutoAttendant -DefaultCallFlow)
  -- but left nullable here until the engineer configures it, same as every
  -- other build_* column that's "required to deploy, not required to exist".
  ADD COLUMN default_call_flow jsonb,
  ADD COLUMN after_hours_call_flow jsonb,
  -- Array of { name, callFlow, schedule } - a site can have more than one
  -- holiday window (OVP012's BHA AA has one, but the shape doesn't assume
  -- exactly one).
  ADD COLUMN holiday_call_flows jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The after-hours schedule ({ type: 'weekly'|'fixed', weekly?, fixed? }) -
  -- each holiday_call_flows entry carries its own schedule inline instead.
  ADD COLUMN schedule jsonb;
