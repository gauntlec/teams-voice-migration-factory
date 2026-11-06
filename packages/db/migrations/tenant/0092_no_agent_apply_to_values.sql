-- Get-CsCallQueue returns NoAgentApplyTo as a number, and Voxshift read it backwards: Teams has NewCalls=0, AllCalls=1. A design imported
-- from Teams therefore holds the opposite of what Teams has. Put each one right now the reading is fixed, or it would look different and
-- the next deployment would change the live queue. Teams itself isn't touched. updated_at is left alone: this isn't an edit, and drift
-- goes by it. A design with a different value from Teams couldn't be told apart from this, so it takes what Teams has.
WITH live AS (
  SELECT q.id,
         CASE o.data->>'NoAgentApplyTo' WHEN '0' THEN 'NewCalls' WHEN '1' THEN 'AllCalls' WHEN 'NewCalls' THEN 'NewCalls' WHEN 'AllCalls' THEN 'AllCalls' END AS real
  FROM {{SCHEMA}}.build_call_queues q
  LEFT JOIN {{SCHEMA}}.discovery_voice_apps a ON a.id = q.discovery_voice_app_id
  JOIN {{SCHEMA}}.tenant_objects o
    ON o.object_type = 'call_queue' AND o.removed_at IS NULL
   AND (o.id = a.tenant_object_id OR (a.tenant_object_id IS NULL AND lower(o.display_name) = lower(q.name)))
)
UPDATE {{SCHEMA}}.build_call_queues q
SET no_agent_apply_to = live.real
FROM live
WHERE q.id = live.id AND live.real IS NOT NULL AND q.no_agent_apply_to IS NOT NULL AND q.no_agent_apply_to <> live.real;

-- The same answer as saved in a Site Data call flow made from a live queue (Populate builds Design & Build rows from these).
WITH live AS (
  SELECT f.id,
         CASE o.data->>'NoAgentApplyTo' WHEN '0' THEN 'NewCalls' WHEN '1' THEN 'AllCalls' WHEN 'NewCalls' THEN 'NewCalls' WHEN 'AllCalls' THEN 'AllCalls' END AS real
  FROM {{SCHEMA}}.discovery_flows f
  JOIN {{SCHEMA}}.tenant_objects o
    ON o.object_type = 'call_queue' AND o.removed_at IS NULL AND lower(o.display_name) = lower(f.name)
  WHERE f.kind = 'call_queue' AND f.wizard_answers ? 'noAgentsApplyTo'
)
UPDATE {{SCHEMA}}.discovery_flows f
SET wizard_answers = jsonb_set(f.wizard_answers, '{noAgentsApplyTo}', to_jsonb(live.real))
FROM live
WHERE f.id = live.id AND live.real IS NOT NULL AND f.wizard_answers->>'noAgentsApplyTo' <> live.real;
