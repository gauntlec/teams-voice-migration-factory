// Bug report "Delete All Data Button": a Teams sign-in to another company's Microsoft tenant, made while this customer was selected, read
// that company's Teams into this customer. Each customer now records its own Microsoft tenant, and a sign-in to any other is refused
// (packages/db/src/teams-tenant.ts); a sync or deployment on such a sign-in never starts.
import type { Job } from 'bullmq';
import { checkMicrosoftTenant, connectionTenantProblem, customerMicrosoftTenant, platformDb, WrongMicrosoftTenantError } from '@tvmf/db';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { TenantDiscoveryService } from '../../../../apps/api/src/modules/tenant-discovery/tenant-discovery.service';
import { handleTenantDiscoveryRun } from '../../../../apps/worker/src/discovery/run';
import type { TeamsExecutor } from '../../../../apps/worker/src/teams/executor';
import { seedConnection, seedCustomer, seedUser, TEST_MS_TENANT, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();

const OWN = { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Contoso Ltd' };
const OTHER = { id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'Fabrikam Inc' };

const recorded = async (c: TestCustomer) =>
  platformDb(handle.db).selectFrom('tenants').select(['teams_tenant_id', 'teams_tenant_name']).where('id', '=', c.t.id).executeTakeFirstOrThrow();

const discoveredTenant = (c: TestCustomer, t: { id: string; name: string }) =>
  c.s.insertInto('tenant_objects').values({ object_type: 'tenant', object_key: t.id, display_name: t.name, data: { TenantId: t.id, DisplayName: t.name } } as never).execute();

describe('checking a sign-in against the customer’s Microsoft tenant', () => {
  it('records the first sign-in’s tenant, accepts it again, and refuses any other naming both', async () => {
    const c = await seedCustomer(handle, { name: 'Contoso' });
    expect(await customerMicrosoftTenant(handle.db, c.t.schema)).toBeNull();

    expect(await checkMicrosoftTenant(handle.db, c.t.schema, OWN)).toBe('recorded');
    expect(await recorded(c)).toEqual({ teams_tenant_id: OWN.id, teams_tenant_name: OWN.name });
    // the same tenant, however the id is cased
    expect(await checkMicrosoftTenant(handle.db, c.t.schema, { id: OWN.id.toUpperCase(), name: null })).toBe('matched');

    const refused = await checkMicrosoftTenant(handle.db, c.t.schema, OTHER).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(WrongMicrosoftTenantError);
    expect((refused as Error).message).toContain(`Fabrikam Inc (${OTHER.id})`);
    expect((refused as Error).message).toContain(`Contoso Ltd (${OWN.id})`);
    // and the record is not changed by a refused sign-in
    expect(await recorded(c)).toEqual({ teams_tenant_id: OWN.id, teams_tenant_name: OWN.name });
  });

  it('takes the tenant from the discovered data when none is recorded, so the first sign-in cannot be another company’s', async () => {
    const c = await seedCustomer(handle);
    await discoveredTenant(c, OWN);
    expect(await customerMicrosoftTenant(handle.db, c.t.schema)).toMatchObject({ id: OWN.id, source: 'discovered' });

    await expect(checkMicrosoftTenant(handle.db, c.t.schema, OTHER)).rejects.toBeInstanceOf(WrongMicrosoftTenantError);
    expect((await recorded(c)).teams_tenant_id).toBe(OWN.id);
    expect(await checkMicrosoftTenant(handle.db, c.t.schema, OWN)).toBe('matched');
  });

  it('refuses a sync or deployment on a sign-in with no recorded tenant, or another company’s', async () => {
    const c = await seedCustomer(handle);
    const engineer = await seedUser(handle);
    const old = await c.s.insertInto('connections').values({ started_by: engineer.id, status: 'active' } as never).returning('id').executeTakeFirstOrThrow();
    expect(await connectionTenantProblem(handle.db, c.t.schema, old.id)).toMatch(/Sign in to the customer tenant again/);

    await checkMicrosoftTenant(handle.db, c.t.schema, OWN);
    const conn = await seedConnection(c.s, engineer); // reached TEST_MS_TENANT
    expect(await connectionTenantProblem(handle.db, c.t.schema, conn.id)).toMatch(/but Contoso is the Microsoft tenant/);
  });
});

describe('a discovery run on another company’s tenant', () => {
  it('fails before it reads anything', async () => {
    const c = await seedCustomer(handle);
    const engineer = await seedUser(handle);
    await checkMicrosoftTenant(handle.db, c.t.schema, OWN);
    const conn = await seedConnection(c.s, engineer); // reached TEST_MS_TENANT, not OWN
    const row = await c.s.insertInto('tenant_discovery_runs').values({ connection_id: conn.id, status: 'queued', started_by: engineer.id, kind: 'sync' } as never).returning('id').executeTakeFirstOrThrow();
    let queried = 0;
    const exec = { alive: true, signedIn: true, graphAlive: false, lastUsedAt: Date.now(), query: async () => (queried++, []) } as unknown as TeamsExecutor;
    const job = { data: { kind: 'tenant_discovery.run', tenantId: c.t.id, schema: c.t.schema, runId: row.id, connectionId: conn.id, operatorUserId: engineer.id } } as unknown as Job;

    await handleTenantDiscoveryRun(job, handle.db, () => exec, async () => undefined);

    const after = await c.s.selectFrom('tenant_discovery_runs').select(['status', 'error']).where('id', '=', row.id).executeTakeFirstOrThrow();
    expect(after.status).toBe('failed');
    expect(after.error).toContain(TEST_MS_TENANT);
    expect(queried).toBe(0);
    expect(await c.s.selectFrom('tenant_objects').select('id').execute()).toHaveLength(0);
  });
});

describe('Delete discovered data', () => {
  it('forgets the recorded tenant and ends open sign-ins, so a wrong record can be cleared', async () => {
    const c = await seedCustomer(handle);
    const admin = await seedUser(handle, 'SUPER_ADMIN');
    await discoveredTenant(c, OTHER);
    await checkMicrosoftTenant(handle.db, c.t.schema, OTHER); // the wrong company's sign-in, recorded before this check existed
    const conn = await seedConnection(c.s, admin);

    const svc = new TenantDiscoveryService(handle.db, unused('queue'), new AuditService(handle.db), unused('deployments'), unused('dataCollection'), unused('telephony'));
    expect((await svc.summary(c.t, admin)).microsoftTenant).toMatchObject({ id: OTHER.id, source: 'recorded' });
    const result = await svc.purge(c.t, admin);

    expect(result).toMatchObject({ microsoftTenantForgotten: OTHER.id, signInsEnded: 1 });
    expect(await recorded(c)).toEqual({ teams_tenant_id: null, teams_tenant_name: null });
    expect((await c.s.selectFrom('connections').select('status').where('id', '=', conn.id).executeTakeFirstOrThrow()).status).toBe('closed');
    expect((await svc.summary(c.t, admin)).microsoftTenant).toBeNull();
    // the customer's own tenant can now be signed in to
    expect(await checkMicrosoftTenant(handle.db, c.t.schema, OWN)).toBe('recorded');
  });
});
