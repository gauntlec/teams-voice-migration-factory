// Release safety: the "what would a release interrupt" check lists exactly
// what the worker's startup sweep (expireOrphanedWork) would end, across every
// customer schema; and the maintenance notice blocks new live work in its
// final minutes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { assertNoMaintenanceFreeze, currentMaintenance } from '../../../../apps/api/src/platform-ops/maintenance';
import { collectReleaseCheck } from '../../../../apps/api/src/platform-ops/release-check';
import { summarizeReleaseCheck } from '@tvmf/shared';
import { seedConnection, seedCustomer, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let a: TestCustomer;
let b: TestCustomer;

beforeAll(async () => {
  a = await seedCustomer(handle, { name: 'Alpha' });
  b = await seedCustomer(handle, { name: 'Bravo' });
});

// The notice is a single platform-wide row; leave none behind for other files.
afterAll(() => platformDb(handle.db).deleteFrom('maintenance_notice').execute());

describe('collectReleaseCheck', () => {
  it('lists live sign-ins, queued/running discovery runs and deployments with their owners - nothing finished', async () => {
    const sam = await seedUser(handle, 'ENGINEER', { displayName: 'Sam Engineer' });
    const kim = await seedUser(handle, 'SUPER_ADMIN', { displayName: 'Kim Admin' });

    // Alpha: everything a release would interrupt.
    const conn = await seedConnection(a.s, sam);
    await a.s.insertInto('connections').values({ started_by: kim.id, status: 'pending' } as never).execute();
    const run = await a.s
      .insertInto('tenant_discovery_runs')
      .values({ connection_id: conn.id, status: 'running', kind: 'sync', started_by: sam.id, started_at: new Date().toISOString() } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    const live = await a.s
      .insertInto('deployments')
      .values({ connection_id: conn.id, mode: 'execute', scope: {}, status: 'queued', created_by: sam.id, summary: {} } as never)
      .returning('id')
      .executeTakeFirstOrThrow();

    // Bravo: only finished work - a release interrupts nothing here.
    await b.s.insertInto('connections').values({ started_by: sam.id, status: 'expired' } as never).execute();
    await b.s.insertInto('connections').values({ started_by: sam.id, status: 'closed' } as never).execute();
    await b.s
      .insertInto('tenant_discovery_runs')
      .values({ status: 'completed', kind: 'sync', started_by: sam.id } as never)
      .execute();
    await b.s
      .insertInto('deployments')
      .values({ mode: 'dry_run', scope: {}, status: 'completed', created_by: sam.id, summary: {} } as never)
      .execute();

    const check = await collectReleaseCheck(handle.db);
    // Other test files run in parallel against the same database: look at ours only.
    const ours = <T extends { tenantId: string }>(xs: T[]) => xs.filter((x) => x.tenantId === a.t.id || x.tenantId === b.t.id);
    const connections = ours(check.connections);
    const discoveryRuns = ours(check.discoveryRuns);
    const deployments = ours(check.deployments);

    expect(connections.map((c) => [c.tenantName, c.status, c.ownerName]).sort()).toEqual([
      ['Alpha', 'active', 'Sam Engineer'],
      ['Alpha', 'pending', 'Kim Admin'],
    ]);
    expect(connections.find((c) => c.status === 'active')).toMatchObject({ id: conn.id, ownerEmail: sam.email, upn: 'admin@contoso.test' });
    expect(discoveryRuns).toEqual([
      expect.objectContaining({ id: run.id, tenantId: a.t.id, status: 'running', kind: 'sync', ownerName: 'Sam Engineer' }),
    ]);
    expect(deployments).toEqual([
      expect.objectContaining({ id: live.id, tenantName: 'Alpha', status: 'queued', mode: 'execute', ownerEmail: sam.email }),
    ]);
    expect(typeof deployments[0].startedAt).toBe('string');

    expect(summarizeReleaseCheck({ connections, discoveryRuns, deployments })).toMatchObject({
      safe: false,
      total: 4,
      headline: '4 things in progress: 1 deployment run (1 live), 1 discovery run, 2 customer-tenant sign-ins.',
    });
    expect(check.safe).toBe(false); // ours alone make it unsafe
  });
});

describe('maintenance notice', () => {
  it('shows in the release check and blocks new live work only in its final 10 minutes', async () => {
    // Far in the future, so the notice never freezes the other test files
    // running now; `now` is passed explicitly instead.
    const startsAt = new Date(Date.now() + 365 * 24 * 3_600_000);
    const admin = await seedUser(handle, 'SUPER_ADMIN', { displayName: 'Release Admin' });
    await platformDb(handle.db)
      .insertInto('maintenance_notice')
      .values({ id: true, message: 'Update at 18:00 - live tenant sessions will end', starts_at: startsAt.toISOString(), created_by: admin.id })
      .execute();

    const view = await currentMaintenance(handle.db);
    expect(view).toMatchObject({ phase: 'scheduled', message: 'Update at 18:00 - live tenant sessions will end', createdByName: 'Release Admin' });
    expect((await collectReleaseCheck(handle.db)).maintenance).toMatchObject({ phase: 'scheduled' });

    const minutesBefore = (m: number) => new Date(startsAt.getTime() - m * 60_000);
    await expect(assertNoMaintenanceFreeze(handle.db, 'live deployment', minutesBefore(11))).resolves.toBeUndefined();
    await expect(assertNoMaintenanceFreeze(handle.db, 'live deployment', minutesBefore(9))).rejects.toThrow(
      /due in 9 minutes.*Starting a new live deployment is paused/,
    );
    await expect(assertNoMaintenanceFreeze(handle.db, 'discovery run', minutesBefore(-45))).resolves.toBeUndefined(); // lapsed

    await platformDb(handle.db).deleteFrom('maintenance_notice').execute();
    await expect(assertNoMaintenanceFreeze(handle.db, 'live deployment', minutesBefore(1))).resolves.toBeUndefined();
  });
});
