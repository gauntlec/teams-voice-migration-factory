// Drift: a deployed, unedited Design & Build row that no longer matches the live tenant (packages/shared/src/drift.ts).
import { beforeAll, describe, expect, it } from 'vitest';
import { computeSiteDrift } from '@tvmf/db';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { DeploymentDocumentService } from '../../../../apps/api/src/modules/deployment/deployment-document.service';
import { DeploymentService } from '../../../../apps/api/src/modules/deployment/deployment.service';
import { seedConnection, seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let siteId: string;
let rowId: string;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let connectionId: string;
let deployments: DeploymentService;
let build: BuildService;

const UPN = 'ann@contoso.test';
const at = (d: number) => new Date(Date.UTC(2026, 9, d, 12)).toISOString();

/** A live run that applied one command for the row on day `d`. */
async function liveRun(d: number, result: 'applied' | 'failed' = 'applied') {
  const dep = await c.s
    .insertInto('deployments')
    .values({ connection_id: connectionId, mode: 'execute', status: 'completed', scope: JSON.stringify({ siteId }), summary: JSON.stringify({}), created_by: engineer.id, created_at: at(d) } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
  await c.s
    .insertInto('deployment_changes')
    .values({ deployment_id: dep.id, seq: 1, at: at(d), correlation_id: `${dep.id}:1`, object_type: 'user', object_id: rowId, cmdlet: 'Set-CsOnlineVoicemailUserSettings', parameters: JSON.stringify({}), before: JSON.stringify({}), after: JSON.stringify({}), result } as never)
    .execute();
}

async function sync(d: number) {
  await c.s
    .insertInto('tenant_discovery_runs')
    .values({ connection_id: connectionId, status: 'completed', kind: 'sync', started_by: engineer.id, started_at: at(d), finished_at: at(d) } as never)
    .execute();
}

const touchRow = (d: number) => c.s.updateTable('build_users').set({ updated_at: at(d) } as never).where('id', '=', rowId).execute();

beforeAll(async () => {
  c = await seedCustomer(handle);
  siteId = (await seedSite(c.s, { sitecode: 'LTN01' })).id;
  engineer = await seedUser(handle, 'ENGINEER');
  connectionId = (await seedConnection(c.s, engineer)).id;
  deployments = new DeploymentService(handle.db, unused('queue'), new AuditService(handle.db), unused('files'), new DeploymentDocumentService());
  build = new BuildService(handle.db, new AuditService(handle.db), new BuildValidationService(handle.db), unused('discovery'), unused('documentBuilder'), unused('files'));
  // Live: voicemail switched off. Design: voicemail on - so the row plans Set-CsOnlineVoicemailUserSettings.
  const obj = await c.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: UPN, display_name: UPN, data: {} } as never).returning('id').executeTakeFirstOrThrow();
  await c.s
    .insertInto('tenant_users')
    .values({
      object_id: obj.id, upn: UPN, display_name: UPN, entra_id: 'eid-ann', account_enabled: true, enterprise_voice_enabled: false,
      voicemail_enabled: false, voicemail_prompt_language: 'en-GB',
      calling_settings: JSON.stringify({ callForwarding: null, pickupGroup: null, delegates: [] }),
    } as never)
    .execute();
  rowId = (
    await c.s
      .insertInto('build_users')
      .values({ site_id: siteId, upn: UPN, e164: null, policies: {}, voicemail: { enabled: true, language: 'en-GB' }, validation: {}, status: {}, created_at: at(1), updated_at: at(1) } as never)
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
});

describe('drift', () => {
  it('is not drift while the row has never been deployed - it is just a design', async () => {
    const rows = await deployments.previewChanges(c.t, { siteId, sheets: ['users'] } as never);
    expect(rows).toHaveLength(1);
    expect(rows[0].drift).toBeUndefined();
    expect((await computeSiteDrift(c.s, siteId)).rows).toEqual([]);
  });

  it('waits for a sync after a deployment, then reports drift once Discovery still sees the difference', async () => {
    await liveRun(5);
    expect((await computeSiteDrift(c.s, siteId)).rows.map((r) => r.state)).toEqual(['awaiting_sync']);
    await sync(6);
    const d = await computeSiteDrift(c.s, siteId);
    expect(d).toMatchObject({ drifted: 1, awaitingSync: 0 });
    expect(d.rows[0]).toMatchObject({ rowId, objectType: 'user', name: UPN, state: 'drift', cmdlets: ['Set-CsOnlineVoicemailUserSettings'] });
    const rollup = await deployments.siteRollup(c.t);
    expect(rollup.find((r) => r.id === siteId)?.drift).toMatchObject({ drifted: 1, awaitingSync: 0 });
    const preview = await deployments.previewChanges(c.t, { siteId, sheets: ['users'] } as never);
    expect(preview[0].drift).toBe('drift');
  });

  it('is a pending design change, not drift, once the row is edited after the deployment', async () => {
    await touchRow(7);
    expect((await computeSiteDrift(c.s, siteId)).rows).toEqual([]);
    await touchRow(2);
  });

  it('is not drift when the latest live run failed for the row', async () => {
    await liveRun(8, 'failed');
    await sync(9);
    expect((await computeSiteDrift(c.s, siteId)).rows).toEqual([]);
    await liveRun(10);
    await sync(11);
    expect((await computeSiteDrift(c.s, siteId)).drifted).toBe(1);
  });

  it('is not drift when the only command is voicemail Discovery has not read yet', async () => {
    await c.s.updateTable('tenant_users').set({ voicemail_enabled: null } as never).where('upn', '=', UPN).execute();
    const d = await computeSiteDrift(c.s, siteId);
    expect(d.rows).toEqual([]);
    await c.s.updateTable('tenant_users').set({ voicemail_enabled: false } as never).where('upn', '=', UPN).execute();
    expect((await computeSiteDrift(c.s, siteId)).drifted).toBe(1);
  });

  it('Accept into design takes the live voicemail setting, and the row no longer drifts', async () => {
    const res = await build.acceptDrift(c.t, { id: engineer.id, email: engineer.email, role: 'ENGINEER' } as never, { object_type: 'user', row_id: rowId });
    expect(res.remaining).toEqual([]);
    const row = await c.s.selectFrom('build_users').select('voicemail').where('id', '=', rowId).executeTakeFirstOrThrow();
    expect(row.voicemail).toEqual({ enabled: false, language: 'en-GB' });
    expect((await deployments.siteRollup(c.t)).find((r) => r.id === siteId)?.drift).toMatchObject({ drifted: 0 });
  });
});
