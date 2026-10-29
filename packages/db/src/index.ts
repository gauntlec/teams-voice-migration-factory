import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from './schema';

export * from './schema';
export * from './live-state';
export * from './app-settings';
export * from './mail-config';
export * from './sso-settings';
export * from './sso-revocations';
export * from './platform-audit';
export * from './sso-staff-access';
export * from './plan-rows';
export * from './validate-rows';
export * from './preview';
export * from './device-alerts';
export * from './device-inventory';
export * from './device-status';
export * from './device-sync';
export * from './monitoring-admin';
export * from './drift';
export * from './number-cooloff';
export * from './number-reconcile';
export * from './number-parking';
export * from './site-suggestions';
export * from './site-handsets';
export * from './voice-audio';
export { migratePlatform, provisionTenant, migrateAllTenants, dropTenantSchema } from './migrate';

export interface DbHandle {
  db: Kysely<DB>;
  pool: Pool;
  close: () => Promise<void>;
}

export interface DbOptions {
  /** Pool size. Given, it wins over `PG_POOL_MAX` (the worker sets its own from WORKER_PG_POOL_MAX / DISCOVERY_PG_POOL_MAX). */
  max?: number;
  /**
   * false: this pool's commits do not wait for the write to reach the disk (`synchronous_commit = off`). Only for background work
   * that is simply run again (a discovery sync), so it does not queue the website behind every flush on a slow disk. A crash of
   * Postgres or the host can lose the last fraction of a second of its commits; nothing is ever left half-written.
   */
  synchronousCommit?: boolean;
}

export function createDb(connectionString = process.env.DATABASE_URL, opts: DbOptions = {}): DbHandle {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  // `max` is per process (api and worker each get their own pool). Postgres
  // default max_connections is 100, so 20 each leaves plenty of headroom while
  // giving the API enough slots that a long discovery run on the worker can't
  // starve request handling. `PG_POOL_MAX` overrides if ever needed.
  const max = Math.max(2, opts.max || Number(process.env.PG_POOL_MAX) || 20);
  const pool = new Pool({ connectionString, max, ...(opts.synchronousCommit === false ? { options: '-c synchronous_commit=off' } : {}) });
  // An idle pooled connection that Postgres closes (a restart, say) emits 'error' on the pool. With no listener Node treats that as an
  // unhandled error and the whole process exits - the worker did on the dev host (2026-10-29). The pool drops the connection and opens a
  // new one when next needed, so a note is enough.
  pool.on('error', (e) => {
    // eslint-disable-next-line no-console
    console.warn(`[db] an idle database connection was closed: ${e.message}`);
  });
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
