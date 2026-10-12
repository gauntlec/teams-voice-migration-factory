// After a live deployment: the worker's re-check of what the run touched
// (apps/worker/src/deployment-verify.ts) and the rollback script built from the
// run's recorded before-state (DeploymentService.rollbackScript).
import { beforeAll, describe, expect, it } from 'vitest';
import type { DeploymentVerification } from '@tvmf/shared';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DeploymentService } from '../../../../apps/api/src/modules/deployment/deployment.service';
import { beforeStateResolver, planIdentityRows, verifyDeployment } from '../../../../apps/worker/src/deployment-verify';
import type { TeamsExecutor } from '../../../../apps/worker/src/teams/executor';
import { seedConnection, seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

type Rec = Record<string, unknown>;

const handle = useDb();
let c: TestCustomer;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let connectionId: string;
let siteId: string;
let jo: string;
let sam: string;

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  connectionId = (await seedConnection(c.s, engineer)).id;
  siteId = (await seedSite(c.s, { sitecode: 'NYC01' })).id;
  const row = (upn: string, e164: string, more: Rec = {}) =>
    c.s
      .insertInto('build_users')
      .values({ site_id: siteId, upn, e164, number_type: 'CallingPlan', policies: { calling_policy: 'AllowCalling' }, ...more } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
  jo = (await row('jo@contoso.test', '+15550000002', { call_forwarding: { forwarding: { enabled: true, type: 'Immediate', targetType: 'Voicemail' } } })).id;
  sam = (await row('sam@contoso.test', '+15550000003')).id;
});

/** A signed-in Teams session that only answers Get-CsOnlineUser, from `users`. */
function fakeExecutor(users: Record<string, Rec>): TeamsExecutor {
  return {
    alive: true,
    signedIn: true,
    graphAlive: false,
    lastUsedAt: Date.now(),
    query: async (command: string, params: Rec = {}) => {
      const u = command === 'Get-CsOnlineUser' ? users[String(params.Identity)] : undefined;
      return u ? [u] : [];
    },
  } as unknown as TeamsExecutor;
}

const liveUser = (identity: string, upn: string, lineUri: string, callingPolicy: string): Rec => ({
  Identity: identity,
  UserPrincipalName: upn,
  DisplayName: upn,
  AccountType: 'User',
  AccountEnabled: true,
  EnterpriseVoiceEnabled: true,
  LineUri: lineUri,
  TeamsCallingPolicy: callingPolicy,
});

async function seedRun(changes: { object_type: string; object_id: string | null; cmdlet: string; parameters: Rec; result: string; before?: Rec }[]) {
  const dep = await c.s
    .insertInto('deployments')
    .values({ connection_id: connectionId, mode: 'execute', status: 'completed', created_by: engineer.id, scope: { siteId }, summary: {}, finished_at: new Date().toISOString() } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
  let seq = 0;
  for (const ch of changes) {
    seq += 1;
    await c.s
      .insertInto('deployment_changes')
      .values({
        deployment_id: dep.id,
        seq,
        operator_user_id: engineer.id,
        correlation_id: `${dep.id}:${seq}`,
        object_type: ch.object_type,
        object_id: ch.object_id,
        cmdlet: ch.cmdlet,
        parameters: ch.parameters,
        before: ch.before ?? {},
        after: {},
        result: ch.result,
        message: null,
      } as never)
      .execute();
  }
  return dep.id;
}

const stored = async (id: string) =>
  (await c.s.selectFrom('deployments').select('verification').where('id', '=', id).executeTakeFirstOrThrow()).verification as DeploymentVerification;

const finishRuns = () =>
  c.s.updateTable('tenant_discovery_runs').set({ status: 'completed', finished_at: new Date().toISOString() }).where('status', 'in', ['queued', 'running']).execute();

describe('post-deployment verification', () => {
  it('re-reads what the run touched and stores which rows still differ', async () => {
    const id = await seedRun([
      { object_type: 'user', object_id: jo, cmdlet: 'Set-CsPhoneNumberAssignment', parameters: { Identity: 'jo@contoso.test', PhoneNumber: '+15550000002' }, result: 'applied' },
      { object_type: 'user', object_id: jo, cmdlet: 'Grant-CsTeamsCallingPolicy', parameters: { Identity: 'jo@contoso.test', PolicyName: 'AllowCalling' }, result: 'applied' },
      { object_type: 'user', object_id: jo, cmdlet: 'Set-CsUserCallingSettings', parameters: { Identity: 'jo@contoso.test' }, result: 'applied' },
      { object_type: 'user', object_id: sam, cmdlet: 'Set-CsPhoneNumberAssignment', parameters: { Identity: 'sam@contoso.test', PhoneNumber: '+15550000003' }, result: 'applied' },
      { object_type: 'call_queue', object_id: null, cmdlet: 'New-CsCallQueue', parameters: { Name: 'Sales' }, result: 'applied' },
    ]);
    const exec = fakeExecutor({
      'jo@contoso.test': liveUser('id-jo', 'jo@contoso.test', 'tel:+15550000002', 'AllowCalling'),
      // the number didn't land
      'sam@contoso.test': liveUser('id-sam', 'sam@contoso.test', 'tel:+15550000099', 'AllowCalling'),
    });

    const v = await verifyDeployment(c.s, exec, { deploymentId: id, siteId, connectionId, operatorUserId: engineer.id });

    expect(v).toMatchObject({
      status: 'verified',
      checked: 2,
      matched: 1,
      notChecked: 0,
      unverifiableSettings: 1,
      differing: [{ objectType: 'user', objectId: sam, upn: 'sam@contoso.test', differences: ['Phone number: designed +15550000003, live +15550000099'] }],
    });
    expect(await stored(id)).toEqual(v);
    // it ran as a targeted Discovery check, and freed the in-flight slot after
    const runs = await c.s.selectFrom('tenant_discovery_runs').select(['id', 'kind', 'status']).execute();
    expect(runs).toEqual([{ id: (v as { discoveryRunId: string }).discoveryRunId, kind: 'targeted', status: 'completed' }]);
  });

  it('skips (and says why) when a Discovery run is already in flight', async () => {
    const id = await seedRun([
      { object_type: 'user', object_id: jo, cmdlet: 'Grant-CsTeamsCallingPolicy', parameters: { Identity: 'jo@contoso.test', PolicyName: 'AllowCalling' }, result: 'applied' },
    ]);
    await c.s.insertInto('tenant_discovery_runs').values({ connection_id: connectionId, status: 'running', started_by: engineer.id } as never).execute();
    try {
      const v = await verifyDeployment(c.s, fakeExecutor({}), { deploymentId: id, siteId, connectionId, operatorUserId: engineer.id });
      expect(v).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/already in progress/) });
      expect(await stored(id)).toEqual(v);
    } finally {
      await finishRuns();
    }
  });

  it('a person the re-check cannot find counts as still different', async () => {
    const id = await seedRun([
      { object_type: 'user', object_id: sam, cmdlet: 'Set-CsPhoneNumberAssignment', parameters: { Identity: 'sam@contoso.test' }, result: 'failed' },
      { object_type: 'user', object_id: jo, cmdlet: 'Grant-CsTeamsCallingPolicy', parameters: { Identity: 'jo@contoso.test' }, result: 'applied' },
    ]);
    const v = await verifyDeployment(c.s, fakeExecutor({ 'jo@contoso.test': liveUser('id-jo', 'jo@contoso.test', 'tel:+15550000002', 'AllowCalling') }), {
      deploymentId: id,
      siteId,
      connectionId,
      operatorUserId: engineer.id,
    });
    expect(v).toMatchObject({ status: 'verified', checked: 2, matched: 1, differing: [{ upn: 'sam@contoso.test', differences: ['Not found in Teams when re-checked'] }] });
  });

  it('a run that applied nothing is not checked', async () => {
    const id = await seedRun([{ object_type: 'user', object_id: jo, cmdlet: 'Grant-CsTeamsCallingPolicy', parameters: {}, result: 'whatif' }]);
    const v = await verifyDeployment(c.s, fakeExecutor({}), { deploymentId: id, siteId, connectionId, operatorUserId: engineer.id });
    expect(v).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/Nothing was changed live/) });
  });
});

describe('rollback script', () => {
  it('records the previous number (with its type) and policy, and the script puts them back', async () => {
    // jo's last snapshot: an old Direct Routing number and a different calling policy
    await c.s.updateTable('tenant_users').set({ line_uri: 'tel:+15550000001', policies: { TeamsCallingPolicy: 'Restricted' } }).where('upn', '=', 'jo@contoso.test').execute();
    const obj = await c.s.selectFrom('tenant_users').select('object_id').where('upn', '=', 'jo@contoso.test').executeTakeFirstOrThrow();
    await c.s
      .insertInto('tenant_objects')
      .values({ object_type: 'phone_number', object_key: '+15550000001', display_name: '+15550000001', data: { TelephoneNumber: '+15550000001', NumberType: 'DirectRouting', AssignedPstnTargetId: obj.object_id } } as never)
      .execute();

    const [row] = await planIdentityRows(c.s, 'build_users', 'user', siteId, [jo]);
    const beforeOf = await beforeStateResolver(c.s, [row!]);
    const changes = row!.calls
      .filter((call) => call.cmdlet !== 'Set-CsUserCallingSettings')
      .map((call) => ({ object_type: 'user', object_id: jo, cmdlet: call.cmdlet, parameters: call.parameters, before: beforeOf(row!, call), result: 'applied' }));
    expect(changes.map((ch) => [ch.cmdlet, ch.before])).toEqual([
      ['Set-CsPhoneNumberAssignment', { source: 'discovery_snapshot', lineUri: 'tel:+15550000001', phoneNumberType: 'DirectRouting', enterpriseVoiceEnabled: true }],
      ['Grant-CsTeamsCallingPolicy', { source: 'discovery_snapshot', policyName: 'Restricted' }],
    ]);
    const id = await seedRun([
      ...changes,
      { object_type: 'user', object_id: jo, cmdlet: 'Set-CsUserCallingSettings', parameters: { Identity: 'jo@contoso.test' }, result: 'applied' },
    ]);

    const svc = new DeploymentService(handle.db, unused('queue'), new AuditService(handle.db), unused('files'), unused('documentBuilder'));
    const { filename, content } = await svc.rollbackScript(c.t, engineer, id);
    expect(filename).toBe(`rollback-${id}.ps1`);
    expect(content).toContain("  Grant-CsTeamsCallingPolicy -Identity 'jo@contoso.test' -PolicyName 'Restricted'");
    expect(content).toContain("  Set-CsPhoneNumberAssignment -Identity 'jo@contoso.test' -PhoneNumber '+15550000001' -PhoneNumberType 'DirectRouting'");
    expect(content).toMatch(/NOT REVERSED BY THIS SCRIPT \(1\)[\s\S]*Set-CsUserCallingSettings jo@contoso.test/);
    // newest change undone first
    expect(content.indexOf('Grant-CsTeamsCallingPolicy -Identity')).toBeLessThan(content.indexOf('Set-CsPhoneNumberAssignment -Identity'));
  });

  it('is refused for a dry run', async () => {
    const dry = await c.s
      .insertInto('deployments')
      .values({ mode: 'dry_run', status: 'completed', created_by: engineer.id, scope: { siteId } } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    const svc = new DeploymentService(handle.db, unused('queue'), new AuditService(handle.db), unused('files'), unused('documentBuilder'));
    await expect(svc.rollbackScript(c.t, engineer, dry.id)).rejects.toThrow(/only a live run/);
  });
});
