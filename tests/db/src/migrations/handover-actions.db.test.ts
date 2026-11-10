// Migration 0094: outstanding actions written as notes (a line per action, "description | owner") become handover_actions rows,
// in their order, with the note's author and time, and the notes go.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { useDb } from '../helpers';

const handle = useDb();
const DIR = join(__dirname, '../../../../packages/db/migrations/tenant');
const SCHEMA = 'tenant_mig0094';

afterAll(async () => {
  await handle.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
});

const apply = async (files: string[]) => {
  for (const f of files) await handle.pool.query(readFileSync(join(DIR, f), 'utf8').replaceAll('{{SCHEMA}}', SCHEMA));
};

describe('migration 0094: outstanding actions as records', () => {
  it('turns each line of the notes into an action and removes the notes, leaving other notes alone', async () => {
    const all = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    await handle.pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await apply(all.filter((f) => f < '0094'));
    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await handle.pool.query(sql.replaceAll('{{S}}', SCHEMA), params)).rows as T[];
    const [{ id: site }] = await q<{ id: string }>(`INSERT INTO {{S}}.discovery_sites (sitecode, name) VALUES ('LUT01','Luton') RETURNING id`);
    const author = '11111111-1111-4111-8111-111111111111';
    await q(`INSERT INTO {{S}}.handover_notes (section_key, site_id, body, updated_by, updated_at) VALUES ('outstanding_actions', NULL, $1, $2, '2026-11-01T10:00:00Z')`, [
      'Test 933 on the lobby phone | AT&T\n\n- Submit a ticket for the paging amp\r\n  Port the main number | Carrier | by Friday  ',
      author,
    ]);
    await q(`INSERT INTO {{S}}.handover_notes (section_key, site_id, body, updated_by) VALUES ('outstanding_actions', $1, 'Fix the diagram | AT&T', $2)`, [site, author]);
    await q(`INSERT INTO {{S}}.handover_notes (section_key, site_id, body, updated_by) VALUES ('paging', NULL, 'Paging is out of scope', $1)`, [author]);

    await apply(all.filter((f) => f >= '0094'));

    const actions = await q<{ site_id: string | null; description: string; owner: string; position: number; created_by: string; done_at: string | null }>(
      `SELECT site_id, description, owner, position, created_by, done_at FROM {{S}}.handover_actions ORDER BY site_id NULLS FIRST, position`,
    );
    expect(actions.map((a) => [a.site_id, a.description, a.owner])).toEqual([
      [null, 'Test 933 on the lobby phone', 'AT&T'],
      [null, 'Submit a ticket for the paging amp', ''],
      [null, 'Port the main number', 'Carrier | by Friday'],
      [site, 'Fix the diagram', 'AT&T'],
    ]);
    expect(actions.every((a) => a.created_by === author && a.done_at === null)).toBe(true);
    expect((await q<{ section_key: string }>(`SELECT section_key FROM {{S}}.handover_notes`)).map((n) => n.section_key)).toEqual(['paging']);
  });
});
