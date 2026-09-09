import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from './schema';

export * from './schema';
export { migratePlatform, provisionTenant, migrateAllTenants } from './migrate';

export interface DbHandle {
  db: Kysely<DB>;
  pool: Pool;
  close: () => Promise<void>;
}

export function createDb(connectionString = process.env.DATABASE_URL): DbHandle {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  // `max` is per process (api and worker each get their own pool). Postgres
  // default max_connections is 100, so 20 each leaves plenty of headroom while
  // giving the API enough slots that a long discovery run on the worker can't
  // starve request handling. `PG_POOL_MAX` overrides if ever needed.
  const max = Math.max(2, Number(process.env.PG_POOL_MAX) || 20);
  const pool = new Pool({ connectionString, max });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool, close: async () => { await db.destroy(); } };
}

/** Deterministic schema name for a tenant id. */
export function tenantSchemaName(tenantId: string): string {
  const short = tenantId.replace(/-/g, '').slice(0, 12);
  return `tenant_${short}`;
}

/**
 * Returns a Kysely query builder bound to a tenant schema. Every tenant-scoped
 * query in the API must start from here so a schema is always present.
 */
export function tenantDb(db: Kysely<DB>, schema: string) {
  return db.withSchema(schema);
}

export function platformDb(db: Kysely<DB>) {
  return db.withSchema('platform');
}
