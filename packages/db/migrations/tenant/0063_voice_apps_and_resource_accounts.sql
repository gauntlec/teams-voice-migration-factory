-- Voice apps (auto attendants and call queues) and resource accounts are two different things in Teams: a voice app has its own
-- name and settings and lists its resource accounts (zero, one or several); a resource account has its own UPN, name and phone
-- number and answers for one voice app. Data Collection used to keep one list that mixed them. From here:
--   discovery_voice_apps         the voice apps (what the old discovery_resource_accounts rows really were; ids are kept)
--   discovery_resource_accounts  real resource accounts, each optionally belonging to a voice app; phone numbers attach to these

-- 1. The existing rows are voice apps: rename the table (and its constraints and indexes) and keep every id, so what points at it keeps working.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = '{{SCHEMA}}.discovery_resource_accounts'::regclass LOOP
    IF replace(r.conname, 'discovery_resource_accounts', 'discovery_voice_apps') <> r.conname THEN
      EXECUTE format('ALTER TABLE {{SCHEMA}}.discovery_resource_accounts RENAME CONSTRAINT %I TO %I', r.conname, replace(r.conname, 'discovery_resource_accounts', 'discovery_voice_apps'));
    END IF;
  END LOOP;
END $$;
ALTER INDEX IF EXISTS {{SCHEMA}}.idx_discovery_ra_site RENAME TO idx_discovery_voice_apps_site;
ALTER INDEX IF EXISTS {{SCHEMA}}.discovery_resource_accounts_tenant_object_idx RENAME TO discovery_voice_apps_tenant_object_idx;
ALTER TABLE {{SCHEMA}}.discovery_resource_accounts RENAME TO discovery_voice_apps;

-- 2. What pointed at those rows now says voice app.
ALTER TABLE {{SCHEMA}}.build_auto_attendants RENAME COLUMN discovery_resource_account_id TO discovery_voice_app_id;
ALTER TABLE {{SCHEMA}}.build_call_queues     RENAME COLUMN discovery_resource_account_id TO discovery_voice_app_id;
ALTER TABLE {{SCHEMA}}.discovery_flows       RENAME COLUMN resource_account_id           TO voice_app_id;
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass::text AS tbl
      FROM pg_constraint c
     WHERE c.conrelid IN ('{{SCHEMA}}.build_auto_attendants'::regclass, '{{SCHEMA}}.build_call_queues'::regclass, '{{SCHEMA}}.discovery_flows'::regclass)
       AND (c.conname LIKE '%discovery_resource_account_id_fkey' OR c.conname LIKE 'discovery_flows_resource_account_id_fkey')
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.conname,
      CASE WHEN r.conname LIKE 'discovery_flows_%' THEN 'discovery_flows_voice_app_id_fkey' ELSE replace(r.conname, 'discovery_resource_account_id', 'discovery_voice_app_id') END);
  END LOOP;
END $$;

-- 3. Real resource accounts.
CREATE TABLE {{SCHEMA}}.discovery_resource_accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id          uuid REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE SET NULL,
  -- the voice app it answers for; null = not (yet) tied to one
  voice_app_id     uuid REFERENCES {{SCHEMA}}.discovery_voice_apps(id) ON DELETE SET NULL,
  name             text NOT NULL,
  -- which kind of voice app it is for (its application id)
  kind             text NOT NULL CHECK (kind IN ('auto_attendant','call_queue')),
  -- blank until the account exists; matched to the live account when it does
  upn              text,
  -- the exact discovered resource account this row was made from
  tenant_object_id uuid REFERENCES {{SCHEMA}}.tenant_objects(id) ON DELETE SET NULL,
  comments         text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_discovery_ra_site ON {{SCHEMA}}.discovery_resource_accounts(site_id);
CREATE INDEX discovery_ra_voice_app_idx ON {{SCHEMA}}.discovery_resource_accounts(voice_app_id);
CREATE UNIQUE INDEX discovery_resource_accounts_tenant_object_idx ON {{SCHEMA}}.discovery_resource_accounts (tenant_object_id) WHERE tenant_object_id IS NOT NULL;

-- 4. Carry the existing data over. A resource account row for every discovered resource account that belonged to a record ...
INSERT INTO {{SCHEMA}}.discovery_resource_accounts (site_id, voice_app_id, name, kind, upn, tenant_object_id)
SELECT va.site_id, va.id, COALESCE(o.display_name, va.name), va.kind, o.data->>'UserPrincipalName', o.id
  FROM {{SCHEMA}}.discovery_resource_account_members m
  JOIN {{SCHEMA}}.discovery_voice_apps va ON va.id = m.resource_account_id
  JOIN {{SCHEMA}}.tenant_objects o ON o.id = m.tenant_object_id;

-- ... and one for any other record that holds a number or has a Design & Build resource account row (what the old record stood for).
INSERT INTO {{SCHEMA}}.discovery_resource_accounts (site_id, voice_app_id, name, kind)
SELECT va.site_id, va.id, va.name, va.kind
  FROM {{SCHEMA}}.discovery_voice_apps va
 WHERE NOT EXISTS (SELECT 1 FROM {{SCHEMA}}.discovery_resource_accounts ra WHERE ra.voice_app_id = va.id)
   AND (EXISTS (SELECT 1 FROM {{SCHEMA}}.phone_numbers n WHERE n.holder_type = 'resource_account' AND n.holder_id = va.id)
     OR EXISTS (SELECT 1 FROM {{SCHEMA}}.build_resource_accounts b WHERE b.discovery_resource_account_id = va.id));

-- Numbers move to the resource account that has them live, else to the record's first resource account.
UPDATE {{SCHEMA}}.phone_numbers n
   SET holder_id = COALESCE(
         (SELECT ra.id FROM {{SCHEMA}}.discovery_resource_accounts ra
            JOIN {{SCHEMA}}.tenant_objects o ON o.id = ra.tenant_object_id
           WHERE ra.voice_app_id = n.holder_id
             AND regexp_replace(COALESCE(o.data->>'PhoneNumber', ''), '^tel:|;.*$', '', 'gi') = n.e164
           LIMIT 1),
         (SELECT ra.id FROM {{SCHEMA}}.discovery_resource_accounts ra WHERE ra.voice_app_id = n.holder_id ORDER BY ra.name, ra.id LIMIT 1),
         n.holder_id)
 WHERE n.holder_type = 'resource_account'
   AND EXISTS (SELECT 1 FROM {{SCHEMA}}.discovery_voice_apps va WHERE va.id = n.holder_id);

-- Design & Build resource account rows now point at the resource account row (by UPN, else the record's first one).
ALTER TABLE {{SCHEMA}}.build_resource_accounts DROP CONSTRAINT IF EXISTS build_resource_accounts_discovery_resource_account_id_fkey;
UPDATE {{SCHEMA}}.build_resource_accounts b
   SET discovery_resource_account_id = (
         SELECT ra.id FROM {{SCHEMA}}.discovery_resource_accounts ra
          WHERE ra.voice_app_id = b.discovery_resource_account_id
          ORDER BY (ra.upn IS NOT NULL AND lower(ra.upn) = lower(b.upn)) DESC, ra.created_at, ra.id
          LIMIT 1)
 WHERE b.discovery_resource_account_id IS NOT NULL;
ALTER TABLE {{SCHEMA}}.build_resource_accounts
  ADD CONSTRAINT build_resource_accounts_discovery_resource_account_id_fkey
  FOREIGN KEY (discovery_resource_account_id) REFERENCES {{SCHEMA}}.discovery_resource_accounts(id) ON DELETE SET NULL;

-- A Call flow keeps pointing at its voice app, and names the resource account that answers it (if one does).
ALTER TABLE {{SCHEMA}}.discovery_flows ADD COLUMN resource_account_id uuid REFERENCES {{SCHEMA}}.discovery_resource_accounts(id) ON DELETE SET NULL;
UPDATE {{SCHEMA}}.discovery_flows f
   SET resource_account_id = (SELECT ra.id FROM {{SCHEMA}}.discovery_resource_accounts ra WHERE ra.voice_app_id = f.voice_app_id ORDER BY ra.name, ra.id LIMIT 1)
 WHERE f.voice_app_id IS NOT NULL;

-- 5. The members list is now the resource account rows.
DROP TABLE {{SCHEMA}}.discovery_resource_account_members;
