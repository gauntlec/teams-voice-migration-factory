// Scheduled cutover: a live run queued to start at a set time on the engineer's sign-in, and cancellable until then.
import { beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DeploymentDocumentService } from '../../../../apps/api/src/modules/deployment/deployment-document.service';
import { DeploymentService } from '../../../../apps/api/src/modules/deployment/deployment.service';
import { seedConnection, seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: DeploymentService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let other: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;
let connectionId: string;
const added: { name: string; data: unknown; opts: { jobId?: string; delay?: number } | undefined }[] = [];
const removed: string[] = [];
const queue = {
  add: async (name: string, data: unknown, opts?: { jobId?: string; delay?: number }) => {
    added.push({ name, data, opts });
    return { id: opts?.jobId };
  },
  getJob: async (id: string) => ({ remove: async () => void removed.push(id) }),
};
const can = () => true;
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const input = (runAt?: string) => ({ connectionId, mode: 'execute' as const, scope: { siteId, sheets: ['users' as const] }, ...(runAt ? { runAt } : {}) });

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  other = await seedUser(handle, 'ENGINEER');
  siteId = (await seedSite(c.s, { sitecode: 'LTN01' })).id;
  connectionId = (await seedConnection(c.s, engineer)).id;
  svc = new DeploymentService(handle.db, queue as never, new AuditService(handle.db), unused('files'), new DeploymentDocumentService());
});

describe('scheduled live runs', () => {
  it('queues the run with a delay until its start time, keyed by the deployment', async () => {
    const at = inHours(3);
    const dep = await svc.createDeployment(c.t, engineer, input(at), can);
    expect(dep).toMatchObject({ status: 'queued', mode: 'execute' });
    expect(new Date(dep.run_at!).toISOString()).toBe(at);
    const job = added.at(-1)!;
    expect(job.opts?.jobId).toBe(dep.id);
    expect(job.opts!.delay!).toBeGreaterThan(2.9 * 3_600_000);
  });

  it('refuses a past time, more than a day ahead, a What-If, and a second live run on the same sign-in', async () => {
    await expect(svc.createDeployment(c.t, engineer, input(inHours(-1)), can)).rejects.toThrow(/at least a minute/);
    await expect(svc.createDeployment(c.t, engineer, input(inHours(30)), can)).rejects.toThrow(/up to 24 hours/);
    await expect(svc.createDeployment(c.t, engineer, { ...input(inHours(2)), mode: 'dry_run' }, can)).rejects.toThrow(/Only a live deployment can be scheduled/);
    await expect(svc.createDeployment(c.t, engineer, input(), can)).rejects.toThrow(/already queued or running/);
  });

  it('refuses a time after a planned Voxshift update (the restart would end the sign-in)', async () => {
    await platformDb(handle.db).insertInto('maintenance_notice').values({ message: 'Update', starts_at: inHours(5), created_by: engineer.id } as never).execute();
    try {
      await expect(svc.createDeployment(c.t, engineer, input(inHours(6)), can)).rejects.toThrow(/update is planned/);
    } finally {
      await platformDb(handle.db).deleteFrom('maintenance_notice').execute();
    }
  });

  it('can be cancelled before it starts, by the engineer who scheduled it', async () => {
    const [dep] = await svc.listDeployments(c.t, siteId);
    await expect(svc.cancelScheduled(c.t, other, dep.id)).rejects.toThrow(/Only the engineer who scheduled/);
    await svc.cancelScheduled(c.t, engineer, dep.id);
    expect(removed).toEqual([dep.id]);
    expect((await svc.listDeployments(c.t, siteId))[0].status).toBe('cancelled');
    await expect(svc.cancelScheduled(c.t, engineer, dep.id)).rejects.toThrow(/has not started can be cancelled/);
  });
});
