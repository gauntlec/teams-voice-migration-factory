// How a sync stores what it reads (apps/worker/src/discovery/run.ts, migration 0080): unchanged objects are not rewritten, objects
// stored before content hashes existed are compared on their data, and voice settings for users outside Site Data and Design & Build
// are read after the run has finished.
import type { Job } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { TenantDiscoveryService } from '../../../../apps/api/src/modules/tenant-discovery/tenant-discovery.service';
import { handleTenantDiscoveryRun } from '../../../../apps/worker/src/discovery/run';
import type { TeamsExecutor } from '../../../../apps/worker/src/teams/executor';
import { seedConnection, seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

type Rec = Record<string, unknown>;

const handle = useDb();

async function setup() {
  const c = await seedCustomer(handle);
  const engineer = await seedUser(handle, 'ENGINEER');
  const connectionId = (await seedConnection(c.s, engineer)).id;
  return { c, engineer, connectionId };
}

async function run(env: Awaited<ReturnType<typeof setup>>, exec: TeamsExecutor) {
  const { c, engineer, connectionId } = env;
  const row = await c.s
    .insertInto('tenant_discovery_runs')
    .values({ connection_id: connectionId, status: 'queued', started_by: engineer.id, kind: 'sync', scope_types: ['user'] } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
  const job = {
    data: { kind: 'tenant_discovery.run', tenantId: c.t.id, schema: c.t.schema, runId: row.id, connectionId, operatorUserId: engineer.id, scopeTypes: ['user'], filterUsers: false },
  } as unknown as Job;
  await handleTenantDiscoveryRun(job, handle.db, () => exec, async () => undefined);
  return c.s.selectFrom('tenant_discovery_runs').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow();
}

const user = (n: number, more: Rec = {}): Rec => ({
  Identity: `id-${n}`,
  UserPrincipalName: `a${String(n).padStart(4, '0')}@contoso.test`,
  DisplayName: `User ${n}`,
  AccountType: 'User',
  AccountEnabled: true,
  Department: 'Sales',
  AssignedPlan: [{ Capability: 'MCOEV', CapabilityStatus: 'Enabled' }],
  ...more,
});

/** Answers the users slice for `a*` with `users()`; every other slice is empty. */
function teams(users: () => Rec[], queryMany: TeamsExecutor['queryMany'] = async () => []): TeamsExecutor {
  return {
    alive: true,
    graphAlive: false,
    lastUsedAt: Date.now(),
    query: async (command: string, params: Rec = {}) => (command === 'Get-CsOnlineUser' && String(params.Filter).includes("-like 'a*'") ? users() : []),
    queryMany,
  } as unknown as TeamsExecutor;
}

const changes = (r: { summary: unknown }) => (r.summary as { changed: Rec }).changed;
const versionCount = (c: TestCustomer, runId: string) =>
  c.s.selectFrom('tenant_object_versions').select((eb) => eb.fn.countAll<number>().as('n')).where('run_id', '=', runId).executeTakeFirstOrThrow().then((r) => Number(r.n));

describe('a sync stores only what changed', () => {
  it('rewrites the changed user, moves the rest on, and still marks a user Teams no longer has as removed', async () => {
    const env = await setup();
    const { c } = env;
    let tenant = Array.from({ length: 1200 }, (_, i) => user(i + 1)); // more than two batches of 500
    const exec = teams(() => tenant);

    const first = await run(env, exec);
    expect(first.status).toBe('completed');
    expect(changes(first)).toMatchObject({ added: 1200, updated: 0, removed: 0 });
    const before = await c.s.selectFrom('tenant_objects').select(['object_key', 'content_changed_at', 'content_hash']).where('object_key', '=', 'id-7').executeTakeFirstOrThrow();
    expect(before.content_hash).toMatch(/^[0-9a-f]{40}$/);

    // user 5 moves department, user 9 is gone, the rest are as they were (keys in another order)
    tenant = tenant.filter((u) => u.Identity !== 'id-9').map((u) => (u.Identity === 'id-5' ? { ...u, Department: 'Finance' } : Object.fromEntries(Object.entries(u).reverse())));
    const second = await run(env, exec);
    expect(second.status).toBe('completed');
    expect(changes(second)).toMatchObject({ added: 0, updated: 1, removed: 1 });
    // where the time went, per step
    expect((second.summary as Rec).timings).toMatchObject({
      totalSeconds: expect.any(Number),
      steps: { users: { seconds: expect.any(Number), waitingOnTeams: expect.any(Number), storing: expect.any(Number) }, reconcile: expect.any(Object) },
    });
    expect(await versionCount(c, second.id)).toBe(2);

    const changed = await c.s.selectFrom('tenant_object_versions').select(['change_kind', 'changed_fields']).where('run_id', '=', second.id).where('object_key', '=', 'id-5').executeTakeFirstOrThrow();
    expect(changed).toEqual({ change_kind: 'updated', changed_fields: ['Department'] });
    expect((await c.s.selectFrom('tenant_users').select('department').where('upn', '=', 'a0005@contoso.test').executeTakeFirstOrThrow()).department).toBe('Finance');

    // an unchanged user is not written at all: its rows still say the first run; the sweep says it was seen by the second
    const after = await c.s.selectFrom('tenant_objects').select(['id', 'last_seen_run_id', 'content_changed_at', 'removed_at']).where('object_key', '=', 'id-7').executeTakeFirstOrThrow();
    expect(after).toMatchObject({ last_seen_run_id: first.id, content_changed_at: before.content_changed_at, removed_at: null });
    expect((await c.s.selectFrom('tenant_users').select('last_seen_run_id').where('upn', '=', 'a0007@contoso.test').executeTakeFirstOrThrow()).last_seen_run_id).toBe(first.id);
    expect(await c.s.selectFrom('tenant_object_sweeps').select(['object_type', 'run_id']).execute()).toEqual([{ object_type: 'user', run_id: second.id }]);
    // so Discovery shows it as last seen by the second run
    const discovery = new TenantDiscoveryService(handle.db, unused('queue'), new AuditService(handle.db), unused('deployments'), unused('dataCollection'), unused('telephony'));
    const shown = await discovery.getObject({ id: c.t.id, schema: c.t.schema } as never, after.id);
    expect(shown.last_seen_run_id).toBe(second.id);
    // the changed user was written by the second run
    expect((await c.s.selectFrom('tenant_users').select('last_seen_run_id').where('upn', '=', 'a0005@contoso.test').executeTakeFirstOrThrow()).last_seen_run_id).toBe(second.id);

    // the user Teams no longer has
    expect((await c.s.selectFrom('tenant_objects').select('removed_at').where('object_key', '=', 'id-9').executeTakeFirstOrThrow()).removed_at).not.toBeNull();
    expect((await c.s.selectFrom('tenant_users').select('removed_at').where('upn', '=', 'a0009@contoso.test').executeTakeFirstOrThrow()).removed_at).not.toBeNull();

    // it comes back: re-added, and live again in both tables
    tenant = [...tenant, user(9)];
    const third = await run(env, exec);
    expect(changes(third)).toMatchObject({ added: 0, updated: 0, readded: 1, removed: 0 });
    expect((await c.s.selectFrom('tenant_users').select('removed_at').where('upn', '=', 'a0009@contoso.test').executeTakeFirstOrThrow()).removed_at).toBeNull();
  });

  it('compares objects stored before content hashes existed on their data, and fills the hash in', async () => {
    const env = await setup();
    const { c } = env;
    const tenant = Array.from({ length: 30 }, (_, i) => user(i + 1));
    const exec = teams(() => tenant);
    await run(env, exec);
    // as every object is after migration 0080, before its first sync
    await c.s.updateTable('tenant_objects').set({ content_hash: null }).execute();

    const again = await run(env, exec);
    expect(changes(again)).toMatchObject({ added: 0, updated: 0, removed: 0 });
    expect(await versionCount(c, again.id)).toBe(0);
    const empty = await c.s.selectFrom('tenant_objects').select('id').where('content_hash', 'is', null).execute();
    expect(empty).toEqual([]);
  });
});

describe('a sync is never run twice at once', () => {
  it('a second delivery of the same job leaves the run to the first', async () => {
    const env = await setup();
    const { c, engineer, connectionId } = env;
    const asked: string[] = [];
    const exec = teams(() => {
      asked.push('users');
      return [user(1)];
    });
    const row = await c.s
      .insertInto('tenant_discovery_runs')
      .values({ connection_id: connectionId, status: 'running', started_by: engineer.id, kind: 'sync', scope_types: ['user'] } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    const job = { data: { kind: 'tenant_discovery.run', tenantId: c.t.id, schema: c.t.schema, runId: row.id, connectionId, scopeTypes: ['user'] } } as unknown as Job;
    await handleTenantDiscoveryRun(job, handle.db, () => exec, async () => undefined);
    expect(asked).toEqual([]); // Teams was never asked
    expect((await c.s.selectFrom('tenant_discovery_runs').select('status').where('id', '=', row.id).executeTakeFirstOrThrow()).status).toBe('running');
  });

  it('rewrites every user once when what a user row is built from changes', async () => {
    const env = await setup();
    const { c } = env;
    const exec = teams(() => [user(1), user(2)]);
    await run(env, exec);
    // as if the projection gained a column: every stored hash is now different from what the code computes
    await c.s.updateTable('tenant_users').set({ projection_hash: 'old', department: 'stale' }).execute();
    const again = await run(env, exec);
    const rows = await c.s.selectFrom('tenant_users').select(['department', 'last_seen_run_id']).orderBy('upn').execute();
    expect(rows).toEqual([
      { department: 'Sales', last_seen_run_id: again.id },
      { department: 'Sales', last_seen_run_id: again.id },
    ]);
  });
});

describe('voice settings during and after a sync', () => {
  it('reads the Site Data users during the run and everyone else once it has finished', async () => {
    const env = await setup();
    const { c } = env;
    const site = await seedSite(c.s, { sitecode: 'LON01' });
    await c.s.insertInto('discovery_users').values({ site_id: site.id, upn: 'a0001@contoso.test', display_name: 'User 1' } as never).execute();
    const voice = { EnterpriseVoiceEnabled: true };
    const tenant = [user(1, voice), user(2, voice), user(3)]; // user 3 has no voice features: never read
    const seen: { upn: string; runStatus: string }[] = [];
    let runId = '';
    const exec = teams(
      () => tenant,
      async (items) => {
        const status = (await c.s.selectFrom('tenant_discovery_runs').select('status').where('id', '=', runId).executeTakeFirstOrThrow()).status;
        for (const upn of new Set(items.map((i) => String(i.params?.Identity)))) seen.push({ upn, runStatus: status });
        return items.map((i) => ({ key: i.key, records: [i.command === 'Get-CsUserCallingSettings' ? { IsForwardingEnabled: false } : { VoicemailEnabled: true }] }));
      },
    );
    // the run id is only known once the row exists, so find it from the first query
    const origQuery = exec.query.bind(exec);
    exec.query = async (command, params, opts) => {
      runId ||= (await c.s.selectFrom('tenant_discovery_runs').select('id').where('status', '=', 'running').executeTakeFirstOrThrow()).id;
      return origQuery(command, params, opts);
    };

    const r = await run(env, exec);
    expect(r.status).toBe('completed');
    expect(seen).toEqual([
      { upn: 'a0001@contoso.test', runStatus: 'running' },
      { upn: 'a0002@contoso.test', runStatus: 'completed' },
    ]);
    expect((r.summary as Rec).voiceSettings).toMatchObject({ due: 1, read: 1, failed: 0, unfinished: false });
    const read = await c.s.selectFrom('tenant_users').select(['upn', 'voicemail_enabled']).where('voice_settings_at', 'is not', null).orderBy('upn').execute();
    expect(read).toEqual([
      { upn: 'a0001@contoso.test', voicemail_enabled: true },
      { upn: 'a0002@contoso.test', voicemail_enabled: true },
    ]);
  });
});
