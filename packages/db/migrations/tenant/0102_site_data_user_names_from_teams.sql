-- Bug report "Display name not showing": a Site Data user linked to Teams by adding, importing or changing the UPN was given
-- no name, so the Name column stayed empty until the row was edited. Linking now takes the name Teams has; this fills it in
-- for users already linked with no name. A name typed in Site Data is never replaced.
UPDATE {{SCHEMA}}.discovery_users d
   SET display_name = tu.display_name
  FROM {{SCHEMA}}.tenant_users tu
 WHERE tu.id = d.tenant_user_id
   AND tu.removed_at IS NULL
   AND coalesce(btrim(tu.display_name), '') <> ''
   AND coalesce(btrim(d.display_name), '') = '';
