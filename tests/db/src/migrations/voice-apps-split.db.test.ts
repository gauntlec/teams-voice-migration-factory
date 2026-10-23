// Migration 0063 splits the one Data Collection "resource accounts" list into voice apps and resource accounts. Run it over data shaped
// the way the old code left it (a record with several discovered resource accounts, a record with only a number, an empty record).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { useDb } from '../helpers';

const handle = useDb();
const DIR = join(__dirname, '../../../../packages/db/migrations/tenant');
const SCHEMA = 'tenant_mig0063';

afterAll(async () => {
  await handle.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
});

async function apply(files: string[]) {
  for (const f of files) {
    await handle.pool.query(readFileSync(join(DIR, f), 'utf8').replaceAll('{{SCHEMA}}', SCHEMA));
  }
}

describe('migration 0063: voice apps and resource accounts', () => {
  it('turns old records into voice apps, gives each discovered resource account its own row and moves the numbers and links', async () => {
    const all = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    const before = all.filter((f) => f < '0063');
    await handle.pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await apply(before);
    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await handle.pool.query(sql.replaceAll('{{S}}', SCHEMA), params)).rows as T[];

    const [{ id: site }] = await q<{ id: string }>(`INSERT INTO {{S}}.discovery_sites (sitecode, name) VALUES ('LUT01','Luton') RETURNING id`);
    const [{ id: range }] = await q<{ id: string }>(`INSERT INTO {{S}}.discovery_number_ranges (range_start, range_end, kind, sitecode) VALUES ('+442070000001','+442070000009','new','LUT01') RETURNING id`);
    const ra1 = (await q<{ id: string }>(`INSERT INTO {{S}}.tenant_objects (object_type, object_key, display_name, data) VALUES ('resource_account','ra1','Main RA 1', $1) RETURNING id`, [JSON.stringify({ UserPrincipalName: 'main1@x.test', PhoneNumber: 'tel:+442070000001' })]))[0]!.id;
    const ra2 = (await q<{ id: string }>(`INSERT INTO {{S}}.tenant_objects (object_type, object_key, display_name, data) VALUES ('resource_account','ra2','Main RA 2', $1) RETURNING id`, [JSON.stringify({ UserPrincipalName: 'main2@x.test', PhoneNumber: 'tel:+442070000002' })]))[0]!.id;

    const rec = async (name: string, kind = 'auto_attendant') => (await q<{ id: string }>(`INSERT INTO {{S}}.discovery_resource_accounts (site_id, name, kind) VALUES ($1,$2,$3) RETURNING id`, [site, name, kind]))[0]!.id;
    const main = await rec('Main');
    const plain = await rec('Plain');
    const empty = await rec('Empty', 'call_queue');
    await q(`INSERT INTO {{S}}.discovery_resource_account_members (resource_account_id, tenant_object_id) VALUES ($1,$2),($1,$3)`, [main, ra1, ra2]);
    const num = async (e164: string, holder: string) => q(`INSERT INTO {{S}}.phone_numbers (range_id, e164, status, holder_type, holder_id) VALUES ($1,$2,'assigned','resource_account',$3)`, [range, e164, holder]);
    await num('+442070000001', main);
    await num('+442070000002', main);
    await num('+442070000003', plain);
    const buildRa = (await q<{ id: string }>(`INSERT INTO {{S}}.build_resource_accounts (upn, kind, site_id, discovery_resource_account_id) VALUES ('main2@x.test','auto_attendant',$1,$2) RETURNING id`, [site, main]))[0]!.id;
    const buildAa = (await q<{ id: string }>(`INSERT INTO {{S}}.build_auto_attendants (name, site_id, discovery_resource_account_id) VALUES ('Main',$1,$2) RETURNING id`, [site, main]))[0]!.id;
    const flow = (await q<{ id: string }>(`INSERT INTO {{S}}.discovery_flows (kind, name, site_id, resource_account_id) VALUES ('auto_attendant','Main',$1,$2) RETURNING id`, [site, main]))[0]!.id;

    await apply(['0063_voice_apps_and_resource_accounts.sql']);

    // the old records are the voice apps, ids kept
    const apps = await q<{ id: string; name: string }>(`SELECT id, name FROM {{S}}.discovery_voice_apps ORDER BY name`);
    expect(apps.map((a) => a.id).sort()).toEqual([main, plain, empty].sort());
    // one resource account row per discovered account of "Main", named and addressed as in Teams; "Plain" holds a number so keeps one; "Empty" gets none
    const ras = await q<{ id: string; name: string; upn: string | null; voice_app_id: string; tenant_object_id: string | null }>(`SELECT id, name, upn, voice_app_id, tenant_object_id FROM {{S}}.discovery_resource_accounts ORDER BY name`);
    expect(ras.filter((r) => r.voice_app_id === main).map((r) => [r.name, r.upn])).toEqual([['Main RA 1', 'main1@x.test'], ['Main RA 2', 'main2@x.test']]);
    expect(ras.filter((r) => r.voice_app_id === plain)).toHaveLength(1);
    expect(ras.filter((r) => r.voice_app_id === empty)).toHaveLength(0);
    const raOf = (obj: string) => ras.find((r) => r.tenant_object_id === obj)!;
    // each number is held by the resource account that has it live
    const held = await q<{ e164: string; holder_id: string }>(`SELECT e164, holder_id FROM {{S}}.phone_numbers ORDER BY e164`);
    expect(held[0]).toMatchObject({ e164: '+442070000001', holder_id: raOf(ra1).id });
    expect(held[1]).toMatchObject({ e164: '+442070000002', holder_id: raOf(ra2).id });
    expect(held[2]!.holder_id).toBe(ras.find((r) => r.voice_app_id === plain)!.id);
    // Design & Build follows: the resource account row by UPN, the attendant and the call flow by voice app
    expect((await q<{ discovery_resource_account_id: string }>(`SELECT discovery_resource_account_id FROM {{S}}.build_resource_accounts WHERE id = $1`, [buildRa]))[0]!.discovery_resource_account_id).toBe(raOf(ra2).id);
    expect((await q<{ discovery_voice_app_id: string }>(`SELECT discovery_voice_app_id FROM {{S}}.build_auto_attendants WHERE id = $1`, [buildAa]))[0]!.discovery_voice_app_id).toBe(main);
    const f = (await q<{ voice_app_id: string; resource_account_id: string }>(`SELECT voice_app_id, resource_account_id FROM {{S}}.discovery_flows WHERE id = $1`, [flow]))[0]!;
    expect(f.voice_app_id).toBe(main);
    expect(f.resource_account_id).toBe(raOf(ra1).id);
    // the members table is gone
    expect(await q(`SELECT to_regclass('${SCHEMA}.discovery_resource_account_members') AS t`)).toEqual([{ t: null }]);
  });
});
