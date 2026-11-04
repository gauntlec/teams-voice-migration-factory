-- A resource account linked to an auto attendant or call queue from the Resource accounts tab set only its own voice_app_id, so
-- the Call flow's resource_account_id (what the AA / CQ wizard shows) stayed empty. From now on the API keeps the two in step;
-- this fills the gap for flows saved before that: a flow with no resource account takes the first account linked to its voice app.
UPDATE {{SCHEMA}}.discovery_flows f
   SET resource_account_id = (
         SELECT r.id FROM {{SCHEMA}}.discovery_resource_accounts r
          WHERE r.voice_app_id = f.voice_app_id
          ORDER BY r.created_at, r.id
          LIMIT 1),
       updated_at = now()
 WHERE f.resource_account_id IS NULL
   AND f.voice_app_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM {{SCHEMA}}.discovery_resource_accounts r WHERE r.voice_app_id = f.voice_app_id);
