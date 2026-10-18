import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, inject } from 'vitest';
import { createDb, platformDb, provisionTenant, tenantDb, tenantSchemaName, type DbHandle } from '@tvmf/db';
import type { Role } from '@tvmf/shared';
import { quietly } from './quiet';
import type { AuthedUser, TenantContext } from '../../../apps/api/src/common/request';

export type Scoped = ReturnType<typeof tenantDb>;

/**
 * A database connection for this test file, closed after the file's tests.
 * Call once at the top of a test file (module scope).
 */
export function useDb(): DbHandle {
  const handle = createDb(inject('databaseUrl'));
  // pool.end() rather than handle.close(): Kysely's destroy() only ends the
  // pool if Kysely itself ran a query, and provisionTenant uses the pool directly.
  afterAll(() => handle.pool.end());
  return handle;
}

/**
 * The global agent state (the kill switch, which agents are built in) is shared by every test file, and files run in parallel. A
 * file that changes it holds this lock for the whole file, so two such files never overlap. Call right after `useDb()`.
 */
export function useGlobalAgentLock(handle: DbHandle) {
  let client: import('pg').PoolClient | undefined;
  beforeAll(async () => {
    client = await handle.pool.connect();
    await client.query('select pg_advisory_lock(7101)');
  }, 300_000);
  afterAll(async () => {
    await client?.query('select pg_advisory_unlock(7101)');
    client?.release();
  });
}

/**
 * platform.app_settings is ONE row for the whole platform (base URL, email switch, hub connection), so test files that change it must run one
 * at a time, or one file's settings leak into another's assertions. Hold this lock for the whole file.
 */
export function useGlobalSettingsLock(handle: DbHandle) {
  let client: import('pg').PoolClient | undefined;
  beforeAll(async () => {
    client = await handle.pool.connect();
    await client.query('select pg_advisory_lock(7102)');
  }, 300_000);
  afterAll(async () => {
    await client?.query('select pg_advisory_unlock(7102)');
    client?.release();
  });
}

/**
 * Single sign-on providers are platform-wide (one provider switched to "no local passwords" changes every password sign-in), so test files
 * that create providers hold this lock for the whole file. Call right after `useDb()`.
 */
export function useGlobalSsoLock(handle: DbHandle) {
  let client: import('pg').PoolClient | undefined;
  beforeAll(async () => {
    client = await handle.pool.connect();
    await client.query('select pg_advisory_lock(7103)');
  }, 300_000);
  afterAll(async () => {
    await client?.query('select pg_advisory_unlock(7103)');
    client?.release();
  });
}

export interface TestCustomer {
  /** what the API's TenantGuard hands every service */
  t: TenantContext;
  /** Kysely bound to this customer's tenant schema */
  s: Scoped;
}

/**
 * A customer (platform.tenants row) with its own, freshly provisioned tenant
 * schema - every tenant migration applied, nothing else in it. Use one per
 * test file (or per test, when a test needs a clean slate).
 */
export async function seedCustomer(
  { db, pool }: DbHandle,
  opts: { name?: string; managedServices?: boolean } = {},
): Promise<TestCustomer> {
  const id = randomUUID();
  const schema = tenantSchemaName(id);
  const name = opts.name ?? 'Contoso';
  await quietly(() => provisionTenant(pool, schema));
  await platformDb(db)
    .insertInto('tenants')
    .values({ id, slug: `t-${id.slice(0, 8)}`, name, schema_name: schema, managed_services_enabled: opts.managedServices ?? false })
    .execute();
  return {
    t: { id, slug: `t-${id.slice(0, 8)}`, name, schema, siteScope: null, teamsReadOnly: false, managedServices: opts.managedServices ?? false },
    s: tenantDb(db, schema),
  };
}

/** A platform user (a real platform.users row, so emails can find them), as the API sees them after login. */
export async function seedUser(
  { db }: DbHandle,
  role: Role = 'ENGINEER',
  opts: { displayName?: string } = {},
): Promise<AuthedUser> {
  const id = randomUUID();
  const email = `${role.toLowerCase()}-${id.slice(0, 8)}@msp.test`;
  const displayName = opts.displayName ?? role;
  await platformDb(db)
    .insertInto('users')
    .values({ id, email, password_hash: 'x', display_name: displayName, role, totp_enrolled: true } as never)
    .execute();
  return { id, email, displayName, role, totpEnrolled: true, enrolOnly: false, pwresetOnly: false };
}

/** A Data Collection site. */
export async function seedSite(s: Scoped, opts: { sitecode?: string; name?: string } = {}) {
  const sitecode = opts.sitecode ?? `S${randomUUID().slice(0, 6).toUpperCase()}`;
  return s
    .insertInto('discovery_sites')
    .values({ sitecode, name: opts.name ?? sitecode } as never)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Available numbers in the shared phone_numbers inventory, on one new range for the site. */
export async function seedNumbers(s: Scoped, sitecode: string, e164s: string[]) {
  const range = await s
    .insertInto('discovery_number_ranges')
    .values({ range_start: e164s[0], range_end: e164s[e164s.length - 1], kind: 'new', sitecode } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
  return s
    .insertInto('phone_numbers')
    .values(e164s.map((e164) => ({ range_id: range.id, e164 })))
    .returningAll()
    .execute();
}

/** An active customer-tenant sign-in (the "connection" a discovery run uses). */
export async function seedConnection(s: Scoped, owner: AuthedUser) {
  return s
    .insertInto('connections')
    .values({ started_by: owner.id, status: 'active', upn: 'admin@contoso.test' } as never)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Stands in for a constructor dependency the code under test shouldn't touch:
 * any call throws, naming the method, so an unexpected path fails loudly.
 */
export function unused<T>(name: string): T {
  return new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'then') return undefined; // not a thenable
      return () => {
        throw new Error(`${name}.${String(prop)} was called, but this test didn't expect it`);
      };
    },
  }) as T;
}
