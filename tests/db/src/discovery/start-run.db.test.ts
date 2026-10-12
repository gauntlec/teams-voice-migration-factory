// Discovery API: TenantDiscoveryService.startRun hands a new run row to the
// worker queue. If that hand-off fails the row must not sit at 'queued' -
// with one-run-in-flight (migration 0045) it would block every later run.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import type { DeploymentService } from '../../../../apps/api/src/modules/deployment/deployment.service';
import { TenantDiscoveryService } from '../../../../apps/api/src/modules/tenant-discovery/tenant-discovery.service';
import { seedConnection, seedCustomer, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;

beforeAll(async () => {
  c = await seedCustomer(handle);
});

describe('TenantDiscoveryService.startRun', () => {
  it('a queue failure leaves the run failed, and the next start succeeds', async () => {
    const engineer = await seedUser(handle, 'ENGINEER');
    const conn = await seedConnection(c.s, engineer);
    const queue = { add: vi.fn().mockRejectedValueOnce(new Error('redis unreachable')).mockResolvedValue({}) };
    const deployments = { getConnection: async () => conn } as unknown as DeploymentService;
    const svc = new TenantDiscoveryService(handle.db, queue as never, new AuditService(handle.db), deployments, unused('dataCollection'), unused('telephony'));

    await expect(svc.startRun(c.t, engineer, conn.id)).rejects.toThrow('redis unreachable');
    const runs = await c.s.selectFrom('tenant_discovery_runs').select(['status', 'finished_at', 'error']).execute();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].finished_at).not.toBeNull();
    expect(runs[0].error).toMatch(/hand the run to the worker/);

    const next = await svc.startRun(c.t, engineer, conn.id);
    expect(next.status).toBe('queued');
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenLastCalledWith('tenant_discovery.run', expect.objectContaining({ runId: next.id, schema: c.t.schema }));
  });
});
