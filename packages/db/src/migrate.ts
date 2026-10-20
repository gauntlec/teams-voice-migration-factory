/**
 * Plain-SQL migration runner. No ORM migration DSL - the .sql files in
 * migrations/ are the whole story. See docs/DATA-MODEL.md.
 *
 *   npm run migrate --workspace @tvmf/db      # apply platform migrations
 *
 * `provisionTenant(pool, schema)` is called by the API when a super admin
 * creates a customer.
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

function loadFiles(kind: 'platform' | 'tenant'): { id: string; sql: string }[] {
  const dir = join(MIGRATIONS_DIR, kind);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ id: f, sql: readFileSync(join(dir, f), 'utf8') }));
}

async function applyPending(
  pool: Pool,
  schema: string,
  files: { id: string; sql: string }[],
  transform: (sql: string) => string,
): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS "${schema}"."_migrations" (
         id text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM "${schema}"."_migrations"`,
    );
    const done = new Set(rows.map((r) => r.id));
    for (const file of files) {
      if (done.has(file.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(transform(file.sql));
        await client.query(
          `INSERT INTO "${schema}"."_migrations" (id) VALUES ($1)`,
          [file.id],
        );
        await client.query('COMMIT');
        applied.push(file.id);
        // eslint-disable-next-line no-console
        console.log(`  applied ${schema}/${file.id}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${schema}/${file.id} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    client.release();
  }
  return applied;
}

export async function migratePlatform(pool: Pool): Promise<string[]> {
  return applyPending(pool, 'platform', loadFiles('platform'), (sql) => sql);
}

/**
 * Create (if missing) and bring a tenant schema up to date. Idempotent.
 * `{{SCHEMA}}` in the tenant .sql templates is replaced with the schema name.
 */
export async function provisionTenant(pool: Pool, schema: string): Promise<string[]> {
  if (!/^tenant_[a-z0-9_]+$/.test(schema)) {
    throw new Error(`refusing to provision unexpected schema name: ${schema}`);
  }
  return applyPending(pool, schema, loadFiles('tenant'), (sql) =>
    sql.replaceAll('{{SCHEMA}}', schema),
  );
}

/**
 * Removes a customer's whole database schema, every table and every row in it, for good. Part of deleting a customer
 * (apps/api/src/tenants/tenant-deletion.service.ts). Safe to run again: a schema that is already gone is not an error.
 *
 * The audit tables inside a tenant schema refuse UPDATE, DELETE and TRUNCATE (migration tenant/0054), but DROP SCHEMA does not
 * fire those triggers, so the whole schema can still be dropped. The name is checked against the pattern provisionTenant uses
 * so nothing but a tenant schema can ever be dropped here.
 */
export async function dropTenantSchema(pool: Pool, schema: string): Promise<void> {
  if (!/^tenant_[a-z0-9_]+$/.test(schema)) {
    throw new Error(`refusing to drop unexpected schema name: ${schema}`);
  }
  const client = await pool.connect();
  try {
    // Give up rather than wait for ever behind someone else's open transaction on this customer's tables.
    await client.query(`SET lock_timeout = '15s'`);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.query('RESET lock_timeout').catch(() => undefined);
    client.release();
  }
}

/**
 * Bring every existing tenant schema up to the latest tenant migration.
 * Runs on API start so schema changes roll out to customers created earlier.
 */
export async function migrateAllTenants(pool: Pool): Promise<Record<string, string[]>> {
  // A customer being deleted is skipped: provisioning would create its schema again after the deletion has dropped it.
  const { rows } = await pool.query<{ schema_name: string }>(
    `SELECT schema_name FROM platform.tenants WHERE status <> 'deleting' ORDER BY created_at`,
  );
  const result: Record<string, string[]> = {};
  for (const { schema_name } of rows) {
    result[schema_name] = await provisionTenant(pool, schema_name);
  }
  return result;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // eslint-disable-next-line no-console
    console.log('Applying platform migrations...');
    const applied = await migratePlatform(pool);
    // eslint-disable-next-line no-console
    console.log(applied.length ? `Done (${applied.length} applied).` : 'Already up to date.');

    // eslint-disable-next-line no-console
    console.log('Applying tenant migrations to existing customers...');
    const perTenant = await migrateAllTenants(pool);
    const changed = Object.entries(perTenant).filter(([, v]) => v.length > 0);
    // eslint-disable-next-line no-console
    console.log(
      changed.length
        ? changed.map(([s, v]) => `  ${s}: ${v.join(', ')}`).join('\n')
        : `  ${Object.keys(perTenant).length} tenant(s) already up to date.`,
    );
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
