// Bug report "Display name not showing": a Site Data user linked to Teams shows the name Teams has for them straight away,
// whether added, imported or given a new UPN. A name typed in Site Data is kept.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { seedCustomer, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: TelephonyService;
let pm: Awaited<ReturnType<typeof seedUser>>;
let site: string;

async function teamsUser(upn: string, name: string) {
  const obj = await c.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: upn, display_name: name, data: {} } as never).returning('id').executeTakeFirstOrThrow();
  return (await c.s.insertInto('tenant_users').values({ object_id: obj.id, upn, display_name: name, entra_id: `eid-${upn}`, account_enabled: true, enterprise_voice_enabled: false } as never).returning('id').executeTakeFirstOrThrow()).id;
}
const nameOf = async (upn: string) => (await c.s.selectFrom('discovery_users').select(['display_name', 'tenant_user_id']).where('upn', '=', upn).executeTakeFirstOrThrow());

beforeAll(async () => {
  c = await seedCustomer(handle);
  pm = await seedUser(handle, 'PROJECT_MANAGER');
  site = (await seedSite(c.s, { sitecode: 'LON01' })).id;
  const audit = new AuditService(handle.db);
  svc = new TelephonyService(handle.db, audit, new DataCollectionService(handle.db, audit));
  await teamsUser('alex@contoso.test', 'Alex Example');
  await teamsUser('sam@contoso.test', 'Sam Sample');
  await teamsUser('jo@contoso.test', 'Jo Bloggs');
  await teamsUser('kim@contoso.test', 'Kim Teams');
});

describe('the name of a linked Site Data user', () => {
  it('comes from Teams when a user is added with no name, and a typed name wins', async () => {
    await svc.addUser(c.t, pm, { site_id: site, upn: 'Alex@contoso.test' } as never, true);
    expect(await nameOf('Alex@contoso.test')).toMatchObject({ display_name: 'Alex Example', tenant_user_id: expect.any(String) });
    await svc.addUser(c.t, pm, { site_id: site, upn: 'kim@contoso.test', display_name: 'Kim (reception)' } as never, true);
    expect((await nameOf('kim@contoso.test')).display_name).toBe('Kim (reception)');
  });

  it('comes from Teams for users imported from Excel', async () => {
    const r = await svc.importUsers(c.t, pm, site, [{ upn: 'sam@contoso.test' }, { upn: 'nobody@contoso.test' }] as never, true);
    expect(r).toMatchObject({ created: 2, errors: [] });
    expect((await nameOf('sam@contoso.test')).display_name).toBe('Sam Sample');
    expect(await nameOf('nobody@contoso.test')).toMatchObject({ display_name: null, tenant_user_id: null });
  });

  it('comes from Teams when a new UPN links the user, but does not replace a name already there', async () => {
    const row = await c.s.selectFrom('discovery_users').select('id').where('upn', '=', 'nobody@contoso.test').executeTakeFirstOrThrow();
    await svc.updateUser(c.t, pm, row.id, { upn: 'jo@contoso.test' }, true);
    expect((await nameOf('jo@contoso.test')).display_name).toBe('Jo Bloggs');
    const kim = await c.s.selectFrom('discovery_users').select('id').where('upn', '=', 'kim@contoso.test').executeTakeFirstOrThrow();
    await svc.updateUser(c.t, pm, kim.id, { upn: 'KIM@contoso.test' }, true);
    expect((await nameOf('KIM@contoso.test')).display_name).toBe('Kim (reception)');
  });
});
