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
 * Bring every existing tenant schema up to the latest tenant migration.
 * Runs on API start so schema changes roll out to customers created earlier.
 */
export async function migrateAllTenants(pool: Pool): Promise<Record<string, string[]>> {
  const { rows } = await pool.query<{ schema_name: string }>(
    `SELECT schema_name FROM platform.tenants ORDER BY created_at`,
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
