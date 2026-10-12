// The discovery worker (apps/worker/src/discovery/run.ts) against a real
// tenant schema, with a fake PowerShell session. Covers the ways a run used to
// lose change history or get stuck in flight.
import type { Job } from 'bullmq';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleTenantDiscoveryRun } from '../../../../apps/worker/src/discovery/run';
import type { EnqueueMailInput } from '../../../../apps/worker/src/mail/enqueue';
import type { TeamsExecutor } from '../../../../apps/worker/src/teams/executor';
import { seedConnection, seedCustomer, seedUser, useDb, type TestCustomer } from '../helpers';

type Rec = Record<string, unknown>;

const handle = useDb();
let c: TestCustomer;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let connectionId: string;

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  connectionId = (await seedConnection(c.s, engineer)).id;
});

/**
 * A signed-in Teams session that answers `query` from `answer` (return the
 * records for that cmdlet call). Everything else on TeamsExecutor is unused by
 * a discovery run.
 */
function fakeExecutor(answer: (command: string, params: Rec) => Rec[], extra: Partial<TeamsExecutor> = {}): TeamsExecutor {
  const exec = {
    alive: true,
    signedIn: true,
    graphAlive: false,
    lastUsedAt: Date.now(),
    query: async (command: string, params: Rec = {}) => answer(command, params),
  };
  // copies getters as getters (a spread would call them here)
  return Object.defineProperties(exec, Object.getOwnPropertyDescriptors(extra)) as unknown as TeamsExecutor;
}

/** Insert the run row the API would have, then run it through the worker like BullMQ would. */
async function run(
  exec: TeamsExecutor,
  data: { kind?: 'sync' | 'targeted'; scopeTypes?: string[]; targetedUpns?: string[]; filterUsers?: boolean } = {},
) {
  const { kind = 'sync', ...jobData } = data;
  const row = await c.s
    .insertInto('tenant_discovery_runs')
    .values({ connection_id: connectionId, status: 'queued', started_by: engineer.id, kind, scope_types: data.scopeTypes ?? null } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
  const emails: EnqueueMailInput[] = [];
  const job = {
    data: { kind: 'tenant_discovery.run', tenantId: c.t.id, schema: c.t.schema, runId: row.id, connectionId, operatorUserId: engineer.id, ...jobData },
  } as unknown as Job;
  await handleTenantDiscoveryRun(job, handle.db, () => exec, async (m) => void emails.push(m));
  const after = await c.s.selectFrom('tenant_discovery_runs').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow();
  return { run: after, emails };
}

const versionsFor = (objectKey: string) =>
  c.s
    .selectFrom('tenant_object_versions')
    .select(['change_kind', 'changed_fields', 'run_id'])
    .where('object_key', '=', objectKey)
    .orderBy('changed_at')
    .execute();

const user = (identity: string, upn: string, more: Rec = {}): Rec => ({
  Identity: identity,
  UserPrincipalName: upn,
  DisplayName: upn.split('@')[0],
  AccountType: 'User',
  AccountEnabled: true,
  ...more,
});

describe('discovery worker', () => {
  it('a Validate check that sees a changed user records it in the history', async () => {
    let department = 'Sales';
    const exec = fakeExecutor((cmd, params) => {
      if (cmd === 'Get-CsOnlineUser' && params.Identity === 'jo@contoso.test') {
        return [user('id-jo', 'jo@contoso.test', { Department: department })];
      }
      return []; // Get-CsOnlineVoicemailUserSettings: no mailbox
    });

    const first = await run(exec, { kind: 'targeted', scopeTypes: ['user'], targetedUpns: ['jo@contoso.test'] });
    expect(first.run.status).toBe('completed');
    department = 'Finance';
    const second = await run(exec, { kind: 'targeted', scopeTypes: ['user'], targetedUpns: ['jo@contoso.test'] });
    expect(second.run.status).toBe('completed');

    expect(await versionsFor('id-jo')).toEqual([
      { change_kind: 'added', changed_fields: [], run_id: first.run.id },
      { change_kind: 'updated', changed_fields: ['Department'], run_id: second.run.id },
    ]);
    const stored = await c.s.selectFrom('tenant_users').select('department').where('upn', '=', 'jo@contoso.test').executeTakeFirstOrThrow();
    expect(stored.department).toBe('Finance');
    // a Validate check never emails
    expect([...first.emails, ...second.emails]).toEqual([]);
  });

  it('a step that fails part-way still records history for what it stored', async () => {
    // Two accounts with the same UPN but different Identity: the second
    // breaks tenant_users' unique UPN index, failing the users step after the
    // first was already written to tenant_objects.
    const exec = fakeExecutor((cmd, params) =>
      cmd === 'Get-CsOnlineUser' && String(params.Filter).includes("-like 'a*'")
        ? [user('id-alex-1', 'alex@contoso.test'), user('id-alex-2', 'alex@contoso.test')]
        : [],
    );
    const { run: r } = await run(exec, { scopeTypes: ['user'], filterUsers: false });

    expect(r.status).toBe('completed'); // a failed step is recorded, the run carries on
    expect((r.progress as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
    const obj = await c.s.selectFrom('tenant_objects').select('id').where('object_key', '=', 'id-alex-1').executeTakeFirst();
    expect(obj).toBeDefined();
    expect(await versionsFor('id-alex-1')).toEqual([{ change_kind: 'added', changed_fields: [], run_id: r.id }]);
  });

  it('an unexpected error marks the run failed and sends exactly one completion email', async () => {
    const exec = fakeExecutor(
      (cmd) => (cmd === 'Get-CsTenant' ? [{ TenantId: 'tid', DisplayName: 'Contoso' }] : []),
      {
        // Read after the step loop, outside any per-step handling.
        get graphAlive(): boolean {
          throw new Error('boom');
        },
      },
    );
    const { run: r, emails } = await run(exec, { scopeTypes: ['tenant'] });

    expect(r.status).toBe('failed');
    expect(r.finished_at).not.toBeNull();
    expect(r.error).toMatch(/stopped unexpectedly: boom/);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({
      template: 'discovery_completed',
      to: { email: engineer.email },
      related: { type: 'tenant_discovery_run', id: r.id },
      context: { outcome: 'failed' },
    });
    // nothing left in flight - the next run can start
    const inFlight = await c.s.selectFrom('tenant_discovery_runs').select('id').where('status', 'in', ['queued', 'running']).execute();
    expect(inFlight).toEqual([]);
  });

  it('refuses a second in-flight run (unique index, migration 0045)', async () => {
    const insert = (status: 'queued' | 'running') =>
      c.s
        .insertInto('tenant_discovery_runs')
        .values({ connection_id: connectionId, status, started_by: engineer.id } as never)
        .returning('id')
        .executeTakeFirstOrThrow();

    const first = await insert('queued');
    await expect(insert('running')).rejects.toMatchObject({ code: '23505' });
    await expect(insert('queued')).rejects.toMatchObject({ code: '23505' });

    await c.s.updateTable('tenant_discovery_runs').set({ status: 'completed', finished_at: new Date().toISOString() }).where('id', '=', first.id).execute();
    await expect(insert('queued')).resolves.toBeDefined();
  });
});
