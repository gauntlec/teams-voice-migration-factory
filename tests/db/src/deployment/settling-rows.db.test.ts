// Straight after a live run the stored live state is still from before it, so its rows look undeployed until they have been read back.
// The planned changes say so, and the same rows can't be sent again meanwhile: on dev on 6 Nov 2026 a user's six changes went out twice.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DeploymentDocumentService } from '../../../../apps/api/src/modules/deployment/deployment-document.service';
import { DeploymentService } from '../../../../apps/api/src/modules/deployment/deployment.service';
import { verifyDeployment } from '../../../../apps/worker/src/deployment-verify';
import { seedConnection, seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: DeploymentService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let connectionId: string;
let siteId: string;
let jo: string;
let sam: string;
const can = () => true;
const queue = { add: async () => ({}) };
const live = (rowIds?: string[]) => ({ connectionId, mode: 'execute' as const, scope: { siteId, sheets: ['users' as const], ...(rowIds ? { rowIds } : {}) } });
const whatIf = (rowIds: string[]) => ({ ...live(rowIds), mode: 'dry_run' as const });

/** A live run that has finished sending this row, in whatever state of re-check. */
async function sent(rowId: string, verification: unknown, finishedAt = new Date().toISOString(), result: 'applied' | 'failed' = 'applied') {
  const dep = await c.s.insertInto('deployments').values({ connection_id: connectionId, mode: 'execute', scope: { siteId, sheets: ['users'], rowIds: [rowId] }, status: 'completed', created_by: engineer.id, summary: { applied: 1 }, finished_at: finishedAt, verification } as never).returning('id').executeTakeFirstOrThrow();
  await c.s.insertInto('deployment_changes').values({ deployment_id: dep.id, seq: 1, operator_user_id: engineer.id, correlation_id: 'x', object_type: 'user', object_id: rowId, cmdlet: 'Set-CsPhoneNumberAssignment', parameters: {}, before: {}, after: {}, result } as never).execute();
  return dep.id;
}
const activityOf = async (rowId: string) => (await svc.previewChanges(c.t, { siteId, sheets: ['users'] } as never)).find((r) => r.rowId === rowId)?.activity;

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  connectionId = (await seedConnection(c.s, engineer)).id;
  siteId = (await seedSite(c.s, { sitecode: 'GLA01' })).id;
  const row = (upn: string, e164: string) => c.s.insertInto('build_users').values({ site_id: siteId, upn, e164, number_type: 'DirectRouting', policies: { calling_policy: 'AllowCalling' } } as never).returning('id').executeTakeFirstOrThrow();
  jo = (await row('jo@contoso.test', '+441413025024')).id;
  sam = (await row('sam@contoso.test', '+441413025025')).id;
  svc = new DeploymentService(handle.db, queue as never, new AuditService(handle.db), unused('files'), new DeploymentDocumentService(), unused('branding') as never);
});

describe('rows just sent to Teams', () => {
  it('are marked on the planned changes while being checked, and refused for a second live run', async () => {
    const dep = await sent(jo, { status: 'pending', startedAt: new Date().toISOString() });
    expect(await activityOf(jo)).toBe('checking');
    expect(await activityOf(sam)).toBeUndefined();
    await expect(svc.createDeployment(c.t, engineer, live([jo]), can)).rejects.toThrow(/still being checked in Teams/);
    await expect(svc.createDeployment(c.t, engineer, live(), can)).rejects.toThrow(/still being checked in Teams/);
    // a What-If sends nothing, and other rows aren't held up
    expect(await svc.createDeployment(c.t, engineer, whatIf([jo]), can)).toMatchObject({ mode: 'dry_run' });
    const other = await svc.createDeployment(c.t, engineer, live([sam]), can);
    expect(await activityOf(sam)).toBe('deploying');
    await c.s.updateTable('deployments').set({ status: 'completed', verification: { status: 'verified' } } as never).where('id', '=', other.id).execute();

    // once it has been read back, the row is an ordinary row again and can be deployed
    await c.s.updateTable('deployments').set({ verification: { status: 'verified', checkedAt: new Date().toISOString() } } as never).where('id', '=', dep).execute();
    expect(await activityOf(jo)).toBeUndefined();
    const again = await svc.createDeployment(c.t, engineer, live([jo]), can);
    await c.s.updateTable('deployments').set({ status: 'completed', verification: { status: 'verified' } } as never).where('id', '=', again.id).execute();
  });

  it('are not held up by a re-check that never finished', async () => {
    const dep = await sent(sam, { status: 'pending', startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
    expect(await activityOf(sam)).toBeUndefined();
    await c.s.updateTable('deployments').set({ verification: { status: 'verified' } } as never).where('id', '=', dep).execute();
  });

  it('are flagged, but still deployable, when the re-check was skipped, until Teams is next read', async () => {
    const finished = new Date(Date.now() - 60_000).toISOString();
    const dep = await sent(jo, { status: 'skipped', checkedAt: finished, reason: 'x' }, finished);
    expect(await activityOf(jo)).toBe('unconfirmed');
    const run = await svc.createDeployment(c.t, engineer, live([jo]), can);
    await c.s.updateTable('deployments').set({ status: 'completed', verification: { status: 'verified' } } as never).where('id', '=', run.id).execute();
    await c.s.insertInto('tenant_discovery_runs').values({ connection_id: connectionId, status: 'completed', kind: 'sync', started_by: engineer.id, started_at: new Date().toISOString(), finished_at: new Date().toISOString() } as never).execute();
    expect(await activityOf(jo)).toBeUndefined();
    await c.s.updateTable('deployments').set({ verification: { status: 'verified' } } as never).where('id', '=', dep).execute();
  });

  it("aren't called sent when the change failed, as a call queue's did at Glasgow", async () => {
    const dep = await sent(jo, { status: 'skipped', checkedAt: new Date().toISOString(), reason: 'Nothing was changed live, so there was nothing to check.' }, new Date(Date.now() + 120_000).toISOString(), 'failed');
    expect(await activityOf(jo)).toBeUndefined();
    await c.s.updateTable('deployments').set({ verification: { status: 'verified' } } as never).where('id', '=', dep).execute();
  });

  it("says when it was another deployment's re-check that got in the way", async () => {
    const running = await c.s.insertInto('tenant_discovery_runs').values({ connection_id: connectionId, status: 'running', kind: 'targeted', started_by: engineer.id, started_at: new Date().toISOString() } as never).returning('id').executeTakeFirstOrThrow();
    const earlier = await sent(sam, { status: 'pending', startedAt: new Date().toISOString() });
    const second = await sent(jo, null);
    const v = await verifyDeployment(c.s, unused('exec') as never, { deploymentId: second, siteId, connectionId, operatorUserId: engineer.id });
    expect(v).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/Another deployment's re-check was still running/) });
    await c.s.updateTable('tenant_discovery_runs').set({ status: 'completed', finished_at: new Date().toISOString() }).where('id', '=', running.id).execute();
    await c.s.updateTable('deployments').set({ verification: { status: 'verified' } } as never).where('id', '=', earlier).execute();
  });
});
