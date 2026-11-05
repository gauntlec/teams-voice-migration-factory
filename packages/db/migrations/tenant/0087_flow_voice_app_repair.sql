-- An auto attendant or call queue Call flow is the capture of a voice app; Site Data now shows the two as one row, and deleting
-- either deletes both. Before, deleting a voice app left its Call flow behind with no voice app (voice_app_id ON DELETE SET NULL),
-- so Populate from Site Data never copied it. Give each such flow its voice app back (named and kinded as the flow) and join the
-- flow's resource account to it.
DO $$
DECLARE f record; app uuid;
BEGIN
  FOR f IN SELECT id, site_id, kind, name, resource_account_id FROM {{SCHEMA}}.discovery_flows
            WHERE voice_app_id IS NULL AND site_id IS NOT NULL AND kind IN ('auto_attendant', 'call_queue') LOOP
    INSERT INTO {{SCHEMA}}.discovery_voice_apps (site_id, name, kind) VALUES (f.site_id, f.name, f.kind) RETURNING id INTO app;
    UPDATE {{SCHEMA}}.discovery_flows SET voice_app_id = app WHERE id = f.id;
    IF f.resource_account_id IS NOT NULL THEN
      UPDATE {{SCHEMA}}.discovery_resource_accounts SET voice_app_id = app, updated_at = now()
       WHERE id = f.resource_account_id AND site_id = f.site_id AND voice_app_id IS NULL;
    END IF;
  END LOOP;
END $$;
