// Migration 0097: a customer whose discovered data was deleted before the purge also cleared the number inventory loses the
// "Found in Teams" ranges and what Teams said about each number; one that still has discovered data is left alone.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { useDb } from '../helpers';

const handle = useDb();
const DIR = join(__dirname, '../../../../packages/db/migrations/tenant');
const PURGED = 'tenant_mig0097a';
const SYNCED = 'tenant_mig0097b';

afterAll(async () => {
  for (const s of [PURGED, SYNCED]) await handle.pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
});

async function setup(schema: string, withDiscovery: boolean) {
  const all = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  const apply = async (files: string[]) => {
    for (const f of files) await handle.pool.query(readFileSync(join(DIR, f), 'utf8').replaceAll('{{SCHEMA}}', schema));
  };
  const q = async <T = Record<string, unknown>>(sql: string) => (await handle.pool.query(sql.replaceAll('{{S}}', schema))).rows as T[];
  await handle.pool.query(`CREATE SCHEMA ${schema}`);
  await apply(all.filter((f) => f < '0097'));
  await q(`INSERT INTO {{S}}.discovery_sites (sitecode, name) VALUES ('HQ','HQ')`);
  const [{ id: own }] = await q<{ id: string }>(`INSERT INTO {{S}}.discovery_number_ranges (range_start, range_end, kind, sitecode) VALUES ('+441000000001','+441000000001','new','HQ') RETURNING id`);
  const [{ id: found }] = await q<{ id: string }>(
    `INSERT INTO {{S}}.discovery_number_ranges (range_start, range_end, kind, sitecode, comments) VALUES ('+442000000001','+442000000001','retain',NULL,'Found in Teams by Discovery: assigned there, but in none of our ranges.') RETURNING id`,
  );
  await q(`INSERT INTO {{S}}.phone_numbers (range_id, e164, status, live_only, live_status, live_holder_upn) VALUES ('${own}','+441000000001','assigned',true,'Assigned','x@other.test'), ('${found}','+442000000001','assigned',true,'Assigned','y@other.test')`);
  if (withDiscovery) await q(`INSERT INTO {{S}}.tenant_objects (object_type, object_key, display_name, data) VALUES ('tenant','t1','Contoso','{}')`);
  await apply(all.filter((f) => f >= '0097'));
  return q;
}

describe('migration 0097: forget Teams numbers after a purge', () => {
  it('clears a customer with no discovered data left', async () => {
    const q = await setup(PURGED, false);
    expect(await q(`SELECT e164, status, live_only, live_holder_upn FROM {{S}}.phone_numbers ORDER BY e164`)).toEqual([
      { e164: '+441000000001', status: 'available', live_only: false, live_holder_upn: null },
    ]);
    expect(await q(`SELECT sitecode FROM {{S}}.discovery_number_ranges`)).toEqual([{ sitecode: 'HQ' }]);
  });

  it('leaves a customer that still has discovered data alone', async () => {
    const q = await setup(SYNCED, true);
    expect((await q(`SELECT e164 FROM {{S}}.phone_numbers ORDER BY e164`)).length).toBe(2);
    expect(await q(`SELECT live_holder_upn FROM {{S}}.phone_numbers WHERE e164 = '+441000000001'`)).toEqual([{ live_holder_upn: 'x@other.test' }]);
  });
});
