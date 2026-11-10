-- A Design & Build auto attendant or call queue remembers the Teams object it deploys to (bug report "Site Data -> Design and Build
-- CQ/AA name change", Glasgow). Until now a row found its live object only through its Site Data voice app, so deleting or replacing
-- that entry made a deployed row plan New-CsCallQueue / New-CsAutoAttendant for something Teams already had. The worker records the
-- Identity when it creates the object or matches it; rows already linked to a discovered voice app are filled in here.
ALTER TABLE {{SCHEMA}}.build_auto_attendants ADD COLUMN teams_identity text;
ALTER TABLE {{SCHEMA}}.build_call_queues ADD COLUMN teams_identity text;

UPDATE {{SCHEMA}}.build_auto_attendants b
   SET teams_identity = o.data->>'Identity'
  FROM {{SCHEMA}}.discovery_voice_apps v
  JOIN {{SCHEMA}}.tenant_objects o ON o.id = v.tenant_object_id AND o.removed_at IS NULL
 WHERE v.id = b.discovery_voice_app_id AND o.data->>'Identity' IS NOT NULL;

UPDATE {{SCHEMA}}.build_call_queues b
   SET teams_identity = o.data->>'Identity'
  FROM {{SCHEMA}}.discovery_voice_apps v
  JOIN {{SCHEMA}}.tenant_objects o ON o.id = v.tenant_object_id AND o.removed_at IS NULL
 WHERE v.id = b.discovery_voice_app_id AND o.data->>'Identity' IS NOT NULL;

CREATE INDEX idx_build_auto_attendants_teams_identity ON {{SCHEMA}}.build_auto_attendants (lower(teams_identity)) WHERE teams_identity IS NOT NULL;
CREATE INDEX idx_build_call_queues_teams_identity ON {{SCHEMA}}.build_call_queues (lower(teams_identity)) WHERE teams_identity IS NOT NULL;
