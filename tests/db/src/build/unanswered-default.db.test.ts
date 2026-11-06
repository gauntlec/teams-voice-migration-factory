// Site Data's choice for unanswered calls reaches Design & Build, and the default never reads as drift on rows already deployed.
import { beforeAll, describe, expect, it } from 'vitest';
import { computeSiteDrift } from '@tvmf/db';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { DeploymentDocumentService } from '../../../../apps/api/src/modules/deployment/deployment-document.service';
import { DeploymentService } from '../../../../apps/api/src/modules/deployment/deployment.service';
import { TenantDiscoveryService } from '../../../../apps/api/src/modules/tenant-discovery/tenant-discovery.service';
import { seedConnection, seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let tel: TelephonyService;
let build: BuildService;
let deployments: DeploymentService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;
const forwardToSam = { unanswered: { enabled: true, delaySeconds: 30, targetType: 'SingleTarget' as const, target: 'sam@contoso.test' } };

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  siteId = (await seedSite(c.s, { sitecode: 'GLA01' })).id;
  const audit = new AuditService(handle.db);
  const dc = new DataCollectionService(handle.db, audit);
  tel = new TelephonyService(handle.db, audit, dc);
  const discovery = new TenantDiscoveryService(handle.db, unused('queue'), audit, unused('deployments'), dc, tel);
  build = new BuildService(handle.db, audit, new BuildValidationService(handle.db), discovery, unused('documentBuilder'), unused('files'));
  deployments = new DeploymentService(handle.db, unused('queue'), audit, unused('files'), new DeploymentDocumentService(), unused('branding') as never);
});

describe('unanswered calls', () => {
  it('chosen in Site Data are saved and come through Populate; left alone, the row stays on the default', async () => {
    await c.s.insertInto('discovery_users').values({ site_id: siteId, upn: 'jo@contoso.test', voicemail_enabled: true } as never).execute();
    const chosen = await c.s.insertInto('discovery_users').values({ site_id: siteId, upn: 'ann@contoso.test', voicemail_enabled: true } as never).returning('id').executeTakeFirstOrThrow();
    const updated = await tel.updateUser(c.t, engineer, chosen.id, { call_forwarding: forwardToSam } as never, true);
    expect((updated as { call_forwarding: unknown }).call_forwarding).toEqual(forwardToSam);

    await build.populateUsers(c.t, engineer, siteId);
    const rows = await c.s.selectFrom('build_users').select(['upn', 'call_forwarding']).where('site_id', '=', siteId).execute();
    const of = (upn: string) => rows.find((r) => r.upn === upn)!.call_forwarding as Record<string, unknown>;
    expect(of('ann@contoso.test')).toEqual(forwardToSam);
    expect(of('jo@contoso.test').unanswered).toBeUndefined();

    const preview = await deployments.previewChanges(c.t, { siteId, sheets: ['users'] } as never);
    const commands = (upn: string) => preview.find((r) => r.upn === upn)!.renderedCommands.join('\n');
    expect(commands('jo@contoso.test')).toContain("-IsUnansweredEnabled:$true -UnansweredDelay '00:00:20' -UnansweredTargetType 'Voicemail'");
    expect(commands('ann@contoso.test')).toContain("-UnansweredDelay '00:00:30' -UnansweredTargetType 'SingleTarget' -UnansweredTarget 'sam@contoso.test'");
  });

  it("doesn't flag a row already deployed as drift just because the default is new", async () => {
    const connectionId = (await seedConnection(c.s, engineer)).id;
    const upn = 'jo@contoso.test';
    const obj = await c.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: upn, display_name: upn, data: {} } as never).returning('id').executeTakeFirstOrThrow();
    await c.s.insertInto('tenant_users').values({ object_id: obj.id, upn, display_name: upn, entra_id: 'eid-jo', account_enabled: true, enterprise_voice_enabled: false, voicemail_enabled: true, voicemail_prompt_language: null, calling_settings: JSON.stringify({ callForwarding: { unanswered: { enabled: false } }, pickupGroup: null, delegates: [] }) } as never).execute();
    const row = await c.s.selectFrom('build_users').select('id').where('upn', '=', upn).executeTakeFirstOrThrow();
    const at = new Date(Date.now() + 60_000).toISOString();
    const dep = await c.s.insertInto('deployments').values({ connection_id: connectionId, mode: 'execute', status: 'completed', scope: JSON.stringify({ siteId }), summary: JSON.stringify({ applied: 1 }), created_by: engineer.id, finished_at: at } as never).returning('id').executeTakeFirstOrThrow();
    await c.s.insertInto('deployment_changes').values({ deployment_id: dep.id, seq: 1, at, correlation_id: 'x', object_type: 'user', object_id: row.id, cmdlet: 'Set-CsOnlineVoicemailUserSettings', parameters: JSON.stringify({}), before: JSON.stringify({}), after: JSON.stringify({}), result: 'applied' } as never).execute();
    await c.s.insertInto('tenant_discovery_runs').values({ connection_id: connectionId, status: 'completed', kind: 'sync', started_by: engineer.id, started_at: new Date(Date.now() + 120_000).toISOString(), finished_at: new Date(Date.now() + 120_000).toISOString() } as never).execute();

    const preview = await deployments.previewChanges(c.t, { siteId, sheets: ['users'] } as never);
    const planned = preview.find((r) => r.upn === upn)!;
    expect(planned.renderedCommands.join('\n')).toContain('-UnansweredTargetType');
    expect(planned.drift).toBeUndefined();
    expect((await computeSiteDrift(c.s, siteId)).rows.map((r) => r.rowId)).not.toContain(row.id);
  });
});
