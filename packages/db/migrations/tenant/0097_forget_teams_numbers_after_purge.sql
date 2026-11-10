-- Bug report "Delete All Data Button": "Delete discovered data" left what Discovery syncs had written into the number inventory - the
-- site-less "Found in Teams" ranges and who Teams had each number on - so another tenant's numbers and UPNs stayed in the Number
-- management report. The purge now clears them (forgetTeamsNumbers, packages/db/src/number-reconcile.ts). This does the same, once,
-- for a customer that has no discovered data left (already purged, or never synced), where that copy can only be stale.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM {{SCHEMA}}.tenant_objects) THEN
    DELETE FROM {{SCHEMA}}.phone_numbers pn
     USING {{SCHEMA}}.discovery_number_ranges r
     WHERE r.id = pn.range_id
       AND r.sitecode IS NULL
       AND r.comments LIKE 'Found in Teams by Discovery%'
       AND pn.holder_id IS NULL
       AND pn.status NOT IN ('reserved', 'parked')
       AND NOT EXISTS (SELECT 1 FROM {{SCHEMA}}.build_users b WHERE b.phone_number_id = pn.id)
       AND NOT EXISTS (SELECT 1 FROM {{SCHEMA}}.build_caps b WHERE b.phone_number_id = pn.id)
       AND NOT EXISTS (SELECT 1 FROM {{SCHEMA}}.build_resource_accounts b WHERE b.phone_number_id = pn.id);

    DELETE FROM {{SCHEMA}}.discovery_number_ranges r
     WHERE r.sitecode IS NULL
       AND r.comments LIKE 'Found in Teams by Discovery%'
       AND NOT EXISTS (SELECT 1 FROM {{SCHEMA}}.phone_numbers pn WHERE pn.range_id = r.id);

    UPDATE {{SCHEMA}}.phone_numbers
       SET status = CASE WHEN live_only AND holder_id IS NULL THEN 'available' ELSE status END,
           live_status = NULL, live_holder_kind = NULL, live_holder_upn = NULL, live_holder_name = NULL, live_seen_at = NULL,
           live_only = false, conflict = NULL
     WHERE live_status IS NOT NULL OR live_only OR conflict IS NOT NULL OR live_holder_upn IS NOT NULL;

    DELETE FROM {{SCHEMA}}.deployment_drift;
  END IF;
END $$;
