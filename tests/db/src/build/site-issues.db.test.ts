// The Validation issues tab: every issue on a site in one list, with how serious each is.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { seedCustomer, seedNumbers, seedSite, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let build: BuildService;
let siteId: string;

async function tenantUser(upn: string, name: string, enabled: boolean) {
  const obj = await c.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: upn, display_name: name, data: {} } as never).returning('id').executeTakeFirstOrThrow();
  await c.s.insertInto('tenant_users').values({ object_id: obj.id, upn, display_name: name, entra_id: `eid-${upn}`, account_enabled: enabled, enterprise_voice_enabled: true, voicemail_enabled: false } as never).execute();
}

beforeAll(async () => {
  c = await seedCustomer(handle);
  siteId = (await seedSite(c.s, { sitecode: 'NYC01' })).id;
  build = new BuildService(handle.db, new AuditService(handle.db), new BuildValidationService(handle.db), unused('discovery'), unused('documentBuilder'), unused('files'));
});

describe('siteIssues', () => {
  it('lists blocking issues first, flags a number asked for but not assigned, and leaves clean rows out', async () => {
    const [n1] = (await seedNumbers(c.s, 'NYC01', ['+12125550101'])).map((n) => n.id);
    // asked for ...0999, holds ...0101
    const dc = await c.s.insertInto('discovery_users').values({ site_id: siteId, upn: 'asked@contoso.test', display_name: 'Ada Asked', requested_number: '+12125550999' } as never).returning('id').executeTakeFirstOrThrow();
    await c.s.updateTable('phone_numbers').set({ status: 'assigned', holder_type: 'user', holder_id: dc.id }).where('id', '=', n1).execute();
    await tenantUser('asked@contoso.test', 'Ada Asked', true);
    await tenantUser('off@contoso.test', 'Olly Off', false);
    await tenantUser('fine@contoso.test', 'Fay Fine', true);
    await c.s.insertInto('build_users').values({ site_id: siteId, upn: 'asked@contoso.test', discovery_user_id: dc.id } as never).execute();
    await c.s.insertInto('build_users').values({ site_id: siteId, upn: 'off@contoso.test' } as never).execute();
    await c.s.insertInto('build_users').values({ site_id: siteId, upn: 'fine@contoso.test' } as never).execute();
    await c.s.insertInto('build_users').values({ site_id: siteId, upn: 'ghost@contoso.test' } as never).execute();

    const rows = await build.siteIssues(c.t, siteId);
    const summary = rows.map((r) => `${r.issue.severity}:${r.upn}:${r.issue.code}`);
    expect(summary).toEqual([
      'blocking:asked@contoso.test:requested_number_mismatch',
      'blocking:ghost@contoso.test:not_in_tenant',
      'warning:off@contoso.test:account_disabled',
    ]);
    expect(rows.find((r) => r.upn === 'asked@contoso.test')?.displayName).toBe('Ada Asked');
    expect(rows.find((r) => r.upn === 'asked@contoso.test')?.issue.detail).toContain('+12125550999');
  });

  it('refuses a site id that is not an id', async () => {
    await expect(build.siteIssues(c.t, "x'; drop table")).rejects.toThrow(/site id/);
  });
});

describe('number changes', () => {
  async function liveUser(upn: string, lineUri: string | null) {
    const obj = await c.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: upn, display_name: upn, data: {} } as never).returning('id').executeTakeFirstOrThrow();
    await c.s.insertInto('tenant_users').values({ object_id: obj.id, upn, display_name: upn, entra_id: `eid-${upn}`, account_enabled: true, enterprise_voice_enabled: !!lineUri, voicemail_enabled: false, line_uri: lineUri } as never).execute();
  }
  const engineer = { id: '00000000-0000-0000-0000-000000000001', email: 'eng@example.test', displayName: 'Eng' } as never;
  const numberChange = async (upn: string) => (await build.siteIssues(c.t, siteId)).filter((r) => r.upn === upn && r.issue.code === 'number_change');

  it('flags a user who already has a different number live, and asks again if a number changes after the decision', async () => {
    await liveUser('moved@contoso.test', 'tel:+12125550200');
    await liveUser('same@contoso.test', 'tel:+12125550201');
    const moved = await c.s.insertInto('build_users').values({ site_id: siteId, upn: 'moved@contoso.test', e164: '+12125550299', number_type: 'CallingPlan' } as never).returning('id').executeTakeFirstOrThrow();
    await c.s.insertInto('build_users').values({ site_id: siteId, upn: 'same@contoso.test', e164: '+1 (212) 555-0201', number_type: 'CallingPlan' } as never).execute();

    const [pending] = await numberChange('moved@contoso.test');
    expect(pending.issue).toMatchObject({ severity: 'warning', decision: 'pending' });
    expect(pending.issue.detail).toContain('+12125550200');
    expect(await numberChange('same@contoso.test')).toEqual([]);

    await build.decideNumberChange(c.t, engineer, 'build_users', moved.id, 'accepted');
    expect((await numberChange('moved@contoso.test'))[0].issue).toMatchObject({ severity: 'info', decision: 'accepted' });

    // the engineer picks yet another number: the old answer no longer applies
    await c.s.updateTable('build_users').set({ e164: '+12125550298' }).where('id', '=', moved.id).execute();
    expect((await numberChange('moved@contoso.test'))[0].issue.decision).toBe('pending');

    await build.decideNumberChange(c.t, engineer, 'build_users', moved.id, 'rejected');
    expect((await numberChange('moved@contoso.test'))[0].issue.decision).toBe('rejected');
    await build.decideNumberChange(c.t, engineer, 'build_users', moved.id, 'reset');
    expect((await numberChange('moved@contoso.test'))[0].issue.decision).toBe('pending');
  });

  it('flags a number that differs from Data Collection only once the site has been submitted', async () => {
    const [n] = await seedNumbers(c.s, 'NYC01', ['+12125550301']);
    const dc = await c.s.insertInto('discovery_users').values({ site_id: siteId, upn: 'dc@contoso.test', display_name: 'Dee Cee' } as never).returning('id').executeTakeFirstOrThrow();
    await c.s.updateTable('phone_numbers').set({ status: 'assigned', holder_type: 'user', holder_id: dc.id }).where('id', '=', n.id).execute();
    await liveUser('dc@contoso.test', null);
    await c.s.insertInto('build_users').values({ site_id: siteId, upn: 'dc@contoso.test', e164: '+12125550399', number_type: 'CallingPlan', discovery_user_id: dc.id } as never).execute();

    expect(await numberChange('dc@contoso.test')).toEqual([]); // still a draft
    await c.s.updateTable('discovery_sites').set({ review_status: 'submitted' }).where('id', '=', siteId).execute();
    const [change] = await numberChange('dc@contoso.test');
    expect(change.issue.detail).toContain('+12125550301');
    expect(change.issue.detail).not.toContain('already has');
  });

  it('will not record a decision where there is no number change', async () => {
    const [{ id }] = await c.s.selectFrom('build_users').select('id').where('upn', '=', 'same@contoso.test').execute();
    await expect(build.decideNumberChange(c.t, engineer, 'build_users', id, 'accepted')).rejects.toThrow(/no number change/);
  });
});
