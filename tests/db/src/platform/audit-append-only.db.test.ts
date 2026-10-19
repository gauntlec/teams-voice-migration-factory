// The audit tables can only be added to: the database itself refuses UPDATE, DELETE and TRUNCATE (migrations platform/0035 and tenant/0054),
// for the platform audit log and for every customer's audit_log and deployment_changes, including customers created later. INSERT still works,
// and removing a whole customer (DROP SCHEMA ... CASCADE, DELETE of its platform row) still works. These tests fail without those migrations.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { provisionTenant, tenantDb, tenantSchemaName } from '@tvmf/db';
import { quietly } from '../quiet';
import { seedCustomer, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
const { pool } = handle;
const MIGRATIONS = join(__dirname, '..', '..', '..', '..', 'packages', 'db', 'migrations');
const REFUSED = /append-only/;

async function insertDeployment(c: TestCustomer): Promise<string> {
  const engineer = await seedUser(handle);
  const dep = await c.s
    .insertInto('deployments')
    .values({ mode: 'execute', status: 'completed', created_by: engineer.id, scope: {}, summary: {} } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
  await pool.query(
    `INSERT INTO "${c.t.schema}".deployment_changes (deployment_id, seq, correlation_id, object_type, cmdlet, result)
     VALUES ($1, 1, 'c1', 'user', 'Set-CsPhoneNumberAssignment', 'applied')`,
    [dep.id],
  );
  await pool.query(`INSERT INTO "${c.t.schema}".audit_log (action) VALUES ('test.seed')`);
  return dep.id;
}

/** The three ways to change an audit table; each must be refused. */
function attempts(table: string): Record<string, string> {
  return {
    UPDATE: `UPDATE ${table} SET action = 'tampered'`,
    DELETE: `DELETE FROM ${table}`,
    TRUNCATE: `TRUNCATE ${table}`,
  };
}

describe('platform audit log is append-only', () => {
  it('accepts new rows and refuses UPDATE, DELETE and TRUNCATE', async () => {
    const tag = randomUUID();
    await pool.query(`INSERT INTO platform.platform_audit_log (action, target_id) VALUES ('test.append', $1)`, [tag]);
    for (const [op, sql] of Object.entries(attempts('platform.platform_audit_log'))) {
      await expect(pool.query(sql), op).rejects.toThrow(REFUSED);
    }
    // a narrow, single-row attempt is refused too, and the row is untouched
    await expect(pool.query(`UPDATE platform.platform_audit_log SET action = 'x' WHERE target_id = $1`, [tag])).rejects.toThrow(REFUSED);
    await expect(pool.query(`DELETE FROM platform.platform_audit_log WHERE target_id = $1`, [tag])).rejects.toThrow(REFUSED);
    const { rows } = await pool.query(`SELECT action FROM platform.platform_audit_log WHERE target_id = $1`, [tag]);
    expect(rows).toEqual([{ action: 'test.append' }]);
  });
});

describe('a customer\'s audit tables are append-only', () => {
  it('refuses UPDATE, DELETE and TRUNCATE on audit_log and deployment_changes, and still takes INSERT', async () => {
    const c = await seedCustomer(handle);
    await insertDeployment(c);
    await pool.query(`INSERT INTO "${c.t.schema}".audit_log (action) VALUES ('test.more')`);
    for (const table of ['audit_log', 'deployment_changes']) {
      const column = table === 'audit_log' ? 'action' : 'message';
      for (const [op, sql] of Object.entries(attempts(`"${c.t.schema}".${table}`))) {
        const text = op === 'UPDATE' ? sql.replace('action', column) : sql;
        await expect(pool.query(text), `${table} ${op}`).rejects.toThrow(REFUSED);
      }
    }
    const log = await pool.query(`SELECT count(*)::int AS n FROM "${c.t.schema}".audit_log`);
    const changes = await pool.query(`SELECT count(*)::int AS n FROM "${c.t.schema}".deployment_changes`);
    expect(log.rows[0].n).toBe(2);
    expect(changes.rows[0].n).toBe(1);
  });

  it('deleting a deployment is refused while it has recorded changes (the change history is kept)', async () => {
    const c = await seedCustomer(handle);
    const depId = await insertDeployment(c);
    await expect(pool.query(`DELETE FROM "${c.t.schema}".deployments WHERE id = $1`, [depId])).rejects.toThrow(REFUSED);
  });

  it('a customer created later is protected from its first day', async () => {
    const id = randomUUID();
    const schema = tenantSchemaName(id);
    await quietly(() => provisionTenant(pool, schema));
    await pool.query(`INSERT INTO "${schema}".audit_log (action) VALUES ('test.first')`);
    await expect(pool.query(`UPDATE "${schema}".audit_log SET action = 'x'`)).rejects.toThrow(REFUSED);
    await expect(pool.query(`DELETE FROM "${schema}".audit_log`)).rejects.toThrow(REFUSED);
    await expect(pool.query(`TRUNCATE "${schema}".deployment_changes`)).rejects.toThrow(REFUSED);
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  });

  it('running the migrations again is harmless (existing customers are brought up on every start)', async () => {
    const c = await seedCustomer(handle);
    await pool.query(`INSERT INTO "${c.t.schema}".audit_log (action) VALUES ('test.row')`);
    expect(await quietly(() => provisionTenant(pool, c.t.schema))).toEqual([]);
    await expect(pool.query(`DELETE FROM "${c.t.schema}".audit_log`)).rejects.toThrow(REFUSED);
  });
});

describe('upgrading a database that already holds audit rows', () => {
  it('the tenant migration protects an existing customer without touching its rows', async () => {
    const c = await seedCustomer(handle);
    await insertDeployment(c);
    // put the customer back to how it was before the migration ran
    for (const table of ['audit_log', 'deployment_changes']) {
      await pool.query(`DROP TRIGGER audit_append_only_rows ON "${c.t.schema}".${table}`);
      await pool.query(`DROP TRIGGER audit_append_only_truncate ON "${c.t.schema}".${table}`);
    }
    await pool.query(`UPDATE "${c.t.schema}".audit_log SET action = 'test.unprotected'`); // proves the "before" state is really open
    const sql = readFileSync(join(MIGRATIONS, 'tenant', '0054_audit_tables_append_only.sql'), 'utf8').replaceAll('{{SCHEMA}}', c.t.schema);
    await pool.query(sql);
    await pool.query(sql); // twice
    await expect(pool.query(`DELETE FROM "${c.t.schema}".audit_log`)).rejects.toThrow(REFUSED);
    await expect(pool.query(`UPDATE "${c.t.schema}".deployment_changes SET message = 'x'`)).rejects.toThrow(REFUSED);
    const { rows } = await pool.query(`SELECT action FROM "${c.t.schema}".audit_log ORDER BY at`);
    expect(rows.map((r) => r.action)).toEqual(['test.unprotected']);
  });

  it('the platform migration can be applied again on top of existing rows', async () => {
    const tag = randomUUID();
    await pool.query(`INSERT INTO platform.platform_audit_log (action, target_id) VALUES ('test.upgrade', $1)`, [tag]);
    await pool.query(readFileSync(join(MIGRATIONS, 'platform', '0035_audit_log_append_only.sql'), 'utf8'));
    const { rows } = await pool.query(`SELECT action FROM platform.platform_audit_log WHERE target_id = $1`, [tag]);
    expect(rows).toHaveLength(1);
    await expect(pool.query(`DELETE FROM platform.platform_audit_log WHERE target_id = $1`, [tag])).rejects.toThrow(REFUSED);
  });
});

describe('removing a customer still works', () => {
  it('DROP SCHEMA CASCADE removes the tenant schema and its audit rows; the platform row can be deleted', async () => {
    const c = await seedCustomer(handle);
    await insertDeployment(c);
    await pool.query(`DROP SCHEMA "${c.t.schema}" CASCADE`);
    const gone = await pool.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [c.t.schema]);
    expect(gone.rowCount).toBe(0);
    await pool.query(`DELETE FROM platform.tenants WHERE id = $1`, [c.t.id]);
    const row = await pool.query(`SELECT 1 FROM platform.tenants WHERE id = $1`, [c.t.id]);
    expect(row.rowCount).toBe(0);
    // another customer is unaffected
    const other = await seedCustomer(handle);
    await pool.query(`INSERT INTO "${other.t.schema}".audit_log (action) VALUES ('test.row')`);
    await expect(pool.query(`DELETE FROM "${other.t.schema}".audit_log`)).rejects.toThrow(REFUSED);
    expect(tenantDb(handle.db, other.t.schema)).toBeTruthy();
  });
});
