// Searching for people matches both the UPN and the display name: Design & Build users and CAPs, and Data Collection's Number Assignments.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { seedCustomer, seedNumbers, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let build: BuildService;
let tel: TelephonyService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  siteId = (await seedSite(c.s, { sitecode: 'LON01' })).id;
  const audit = new AuditService(handle.db);
  build = new BuildService(handle.db, audit, new BuildValidationService(handle.db), unused('discovery'), unused('documentBuilder'), unused('files'));
  tel = new TelephonyService(handle.db, audit, new DataCollectionService(handle.db, audit));
});

const upnsOf = (r: { items: unknown[] }) => (r.items as { upn: string }[]).map((x) => x.upn).sort();
const list = (q: string) => build.listUsers(c.t, { siteId, q, page: 1, limit: 50 } as never);

describe('Design & Build user search', () => {
  it('matches the UPN, the name from Data Collection and the name from the tenant, and shows the name', async () => {
    // a row populated from Data Collection: its name lives on the Data Collection user
    const dcUser = await c.s.insertInto('discovery_users').values({ site_id: siteId, upn: 'jo.b@contoso.test', display_name: 'Joanna Brightwell' } as never).returning('id').executeTakeFirstOrThrow();
    await c.s.insertInto('build_users').values({ site_id: siteId, upn: 'jo.b@contoso.test', discovery_user_id: dcUser.id } as never).execute();
    // a row added by hand: its name only exists on the tenant user with that UPN
    await c.s.insertInto('build_users').values({ site_id: siteId, upn: 'p.sharma@contoso.test' } as never).execute();
    const obj = await c.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: 'p.sharma@contoso.test', display_name: 'Priya Sharma', data: {} } as never).returning('id').executeTakeFirstOrThrow();
    await c.s.insertInto('tenant_users').values({ object_id: obj.id, upn: 'p.sharma@contoso.test', display_name: 'Priya Sharma', entra_id: 'eid-priya', account_enabled: true, enterprise_voice_enabled: true, voicemail_enabled: false } as never).execute();
    await c.s.insertInto('build_users').values({ site_id: siteId, upn: 'someone.else@contoso.test' } as never).execute();

    expect(upnsOf(await list('brightwell'))).toEqual(['jo.b@contoso.test']);
    expect(upnsOf(await list('sharma'))).toEqual(['p.sharma@contoso.test']);
    expect(upnsOf(await list('someone.else'))).toEqual(['someone.else@contoso.test']);
    expect(upnsOf(await list('contoso'))).toHaveLength(3);
    expect(upnsOf(await list('nobody'))).toEqual([]);

    const names = Object.fromEntries(((await list('')).items as { upn: string; display_name: string | null }[]).map((r) => [r.upn, r.display_name]));
    expect(names).toEqual({ 'jo.b@contoso.test': 'Joanna Brightwell', 'p.sharma@contoso.test': 'Priya Sharma', 'someone.else@contoso.test': null });
  });
});

describe('Number Assignments search', () => {
  it('matches the number and who holds it, by UPN or name', async () => {
    const [n1, n2, n3] = (await seedNumbers(c.s, 'LON01', ['+442070000101', '+442070000102', '+442070000103'])).map((n) => n.id);
    const user = await c.s.insertInto('discovery_users').values({ site_id: siteId, upn: 'm.okafor@contoso.test', display_name: 'Marcus Okafor' } as never).returning('id').executeTakeFirstOrThrow();
    const ra = await c.s.insertInto('discovery_resource_accounts').values({ site_id: siteId, name: 'Reception Line', kind: 'auto_attendant' } as never).returning('id').executeTakeFirstOrThrow();
    await c.s.updateTable('phone_numbers').set({ status: 'assigned', holder_type: 'user', holder_id: user.id }).where('id', '=', n1).execute();
    await c.s.updateTable('phone_numbers').set({ status: 'assigned', holder_type: 'resource_account', holder_id: ra.id }).where('id', '=', n2).execute();
    const find = async (q: string) =>
      ((await tel.listNumbers(c.t, { siteId, q, page: 1, limit: 50 } as never)).items as { e164: string }[]).map((x) => x.e164).sort();

    expect(await find('okafor')).toEqual(['+442070000101']);
    expect(await find('m.okafor')).toEqual(['+442070000101']);
    expect(await find('reception')).toEqual(['+442070000102']);
    expect(await find('0000103')).toEqual(['+442070000103']);
    expect(await find('zzz')).toEqual([]);
    void n3;
  });
});
