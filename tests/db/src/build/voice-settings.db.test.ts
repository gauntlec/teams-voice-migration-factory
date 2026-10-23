// Teams voice settings per user: read by the sync for voice-enabled users, used to start Design & Build rows, and compared at deployment.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { DeploymentDocumentService } from '../../../../apps/api/src/modules/deployment/deployment-document.service';
import { DeploymentService } from '../../../../apps/api/src/modules/deployment/deployment.service';
import { emptyProgress, syncUserVoiceSettings } from '../../../../apps/worker/src/discovery/run';
import type { TeamsExecutor } from '../../../../apps/worker/src/teams/executor';
import { seedConnection, seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let build: BuildService;
let deploy: DeploymentService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let site: string;

async function tenantUser(upn: string, more: Record<string, unknown> = {}) {
  const obj = await c.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: upn, display_name: upn, data: {} } as never).returning('id').executeTakeFirstOrThrow();
  await c.s.insertInto('tenant_users').values({ object_id: obj.id, upn, display_name: upn, entra_id: `eid-${upn}`, account_enabled: true, enterprise_voice_enabled: true, ...more } as never).execute();
  return obj.id;
}

/** What Teams answers for each user: unanswered after 20 s to voicemail for ann; simultaneous ring to a colleague for bob. */
const TEAMS: Record<string, Record<string, unknown>> = {
  'ann@contoso.test': { IsForwardingEnabled: false, ForwardingType: 'Immediate', ForwardingTargetType: 'Voicemail', IsUnansweredEnabled: true, UnansweredTargetType: 'Voicemail', UnansweredDelay: '00:00:20', CallGroupOrder: 'InOrder', CallGroupTargets: [], Delegates: [] },
  'bob@contoso.test': { IsForwardingEnabled: true, ForwardingType: 'Simultaneous', ForwardingTarget: 'sip:ann@contoso.test', ForwardingTargetType: 'SingleTarget', IsUnansweredEnabled: false, CallGroupOrder: 'InOrder', CallGroupTargets: ['sip:cy@contoso.test'], Delegates: [{ Id: 'sip:ann@contoso.test', MakeCalls: true, ReceiveCalls: true, ManageSettings: false, PickUpHeldCalls: true, JoinActiveCalls: false }] },
};
const fakeTeams = {
  alive: true,
  queryMany: async (items: { key: string; command: string; params?: Record<string, unknown> }[]) =>
    items.map((i) => {
      const upn = String(i.params?.Identity);
      if (i.command === 'Get-CsUserCallingSettings') return TEAMS[upn] ? { key: i.key, records: [TEAMS[upn]] } : { key: i.key, error: 'not found' };
      return TEAMS[upn] ? { key: i.key, records: [{ VoicemailEnabled: true, PromptLanguage: 'en-US' }] } : { key: i.key, error: 'not found' };
    }),
} as unknown as TeamsExecutor;

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  site = (await seedSite(c.s, { sitecode: 'NYC01' })).id;
  const audit = new AuditService(handle.db);
  build = new BuildService(handle.db, audit, new BuildValidationService(handle.db), unused('discovery'), unused('documentBuilder'), unused('files'));
  deploy = new DeploymentService(handle.db, unused('queue'), audit, unused('files'), new DeploymentDocumentService());
});

describe('reading voice settings from the tenant', () => {
  it('stores calling and voicemail settings for voice-enabled users and says when one could not be read', async () => {
    const ann = await tenantUser('ann@contoso.test');
    const bob = await tenantUser('bob@contoso.test');
    const ghost = await tenantUser('ghost@contoso.test');
    const progress = emptyProgress();
    const conn = await seedConnection(c.s, engineer);
    const run = await c.s.insertInto('tenant_discovery_runs').values({ connection_id: conn.id, status: 'running', kind: 'sync', started_by: engineer.id } as never).returning('id').executeTakeFirstOrThrow();
    const res = await syncUserVoiceSettings(c.s, fakeTeams, run.id, [ann, bob, ghost].map((objectId, i) => ({ objectId, upn: ['ann', 'bob', 'ghost'][i] + '@contoso.test' })), progress);
    expect(res).toMatchObject({ read: 2, failed: 1 });
    expect(progress.errors.map((e) => e.message)).toEqual(['ghost@contoso.test: not found']);
    const row = await c.s.selectFrom('tenant_users').select(['calling_settings', 'voicemail_settings', 'voicemail_enabled', 'voice_settings_at']).where('upn', '=', 'ann@contoso.test').executeTakeFirstOrThrow();
    expect(row.calling_settings).toMatchObject({ callForwarding: { forwarding: { enabled: false }, unanswered: { enabled: true, delaySeconds: 20, targetType: 'Voicemail' } } });
    expect(row.voicemail_enabled).toBe(true);
    expect(row.voice_settings_at).toBeTruthy();
  });
});

describe('Design & Build starts from what the tenant has', () => {
  it('fills forwarding, delegates, call group and voicemail on Quick add, and never replaces a designed setting', async () => {
    const res = await build.quickAddUsers(c.t, engineer, site, ['ann@contoso.test', 'bob@contoso.test']);
    expect(res.added).toHaveLength(2);
    const ann = await c.s.selectFrom('build_users').selectAll().where('upn', '=', 'ann@contoso.test').executeTakeFirstOrThrow();
    expect(ann.call_forwarding).toMatchObject({ unanswered: { enabled: true, delaySeconds: 20, targetType: 'Voicemail' } });
    const bob = await c.s.selectFrom('build_users').selectAll().where('upn', '=', 'bob@contoso.test').executeTakeFirstOrThrow();
    expect(bob.call_forwarding).toMatchObject({ forwarding: { enabled: true, type: 'Simultaneous', targetType: 'SingleTarget', target: 'ann@contoso.test' } });
    expect(bob.pickup_group).toEqual({ order: 'InOrder', targets: ['cy@contoso.test'] });
    expect(bob.delegates).toEqual([{ delegateUpn: 'ann@contoso.test', makeCalls: true, receiveCalls: true, manageSettings: false, pickUpHeldCalls: true, joinActiveCalls: false }]);

    // a designed setting stays; the import fills only what is empty
    await c.s.updateTable('build_users').set({ call_forwarding: { unanswered: { enabled: true, delaySeconds: 30, targetType: 'Voicemail' } } as never, delegates: JSON.stringify([]) as never }).where('id', '=', ann.id).execute();
    await build.importVoiceSettings(c.t, engineer, 'users', site);
    const again = await c.s.selectFrom('build_users').select('call_forwarding').where('id', '=', ann.id).executeTakeFirstOrThrow();
    expect(again.call_forwarding).toMatchObject({ unanswered: { delaySeconds: 30 } });
  });
});

describe('deployment compares calling settings with the tenant', () => {
  it('plans nothing for a setting the tenant already has, and the change for one that differs', async () => {
    // bob matches what Teams has: nothing to do for forwarding, call group or the delegate
    const before = await deploy.previewChanges(c.t, { siteId: site, sheets: ['users'] } as never);
    const cmds = (upn: string) => (before.find((r) => r.upn === upn)?.calls ?? []).map((x) => x.cmdlet);
    expect(cmds('bob@contoso.test').filter((x) => /CallingSettings|CallingDelegate/.test(x))).toEqual([]);

    // ann is designed with 30 s but Teams has 20 s: only that change is planned
    const annCalls = (before.find((r) => r.upn === 'ann@contoso.test')?.calls ?? []).filter((x) => x.cmdlet === 'Set-CsUserCallingSettings');
    expect(annCalls).toHaveLength(1);
    expect(JSON.stringify(annCalls[0]!.parameters)).toContain('00:00:30');

    // a user the sync has never read still always plans the designed setting
    await tenantUser('new@contoso.test');
    await c.s.insertInto('build_users').values({ site_id: site, upn: 'new@contoso.test', e164: null, policies: {}, call_forwarding: { unanswered: { enabled: true, delaySeconds: 20, targetType: 'Voicemail' } }, delegates: JSON.stringify([]), pickup_group: {}, voicemail: {}, validation: {}, status: {} } as never).execute();
    const after = await deploy.previewChanges(c.t, { siteId: site, sheets: ['users'] } as never);
    expect((after.find((r) => r.upn === 'new@contoso.test')?.calls ?? []).filter((x) => x.cmdlet === 'Set-CsUserCallingSettings')).toHaveLength(1);
  });
});
