// Site Data bulk delete: the ticked rows, or every row of a kind on one
// site. Each row must go exactly as a single delete would - its numbers back
// to the free pool, Design & Build rows kept but unlinked - and the usual
// site-scope rules apply, and a change to a submitted site is recorded for the engineer.
import { ForbiddenException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { seedCustomer, seedNumbers, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: TelephonyService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let siteA: string, siteB: string;

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  siteA = (await seedSite(c.s, { sitecode: 'LON01' })).id;
  siteB = (await seedSite(c.s, { sitecode: 'MAN01' })).id;
  const audit = new AuditService(handle.db);
  svc = new TelephonyService(handle.db, audit, new DataCollectionService(handle.db, audit));
});

const addUser = (site: string, upn: string) =>
  c.s.insertInto('discovery_users').values({ site_id: site, upn }).returning('id').executeTakeFirstOrThrow().then((r) => r.id);
const hold = (numberId: string, type: 'user' | 'cap' | 'resource_account', holderId: string) =>
  c.s.updateTable('phone_numbers').set({ status: 'assigned', holder_type: type, holder_id: holderId }).where('id', '=', numberId).execute();
const number = (id: string) =>
  c.s.selectFrom('phone_numbers').select(['status', 'holder_id']).where('id', '=', id).executeTakeFirstOrThrow();
const usersOn = (site: string) => c.s.selectFrom('discovery_users').select('upn').where('site_id', '=', site).orderBy('upn').execute();

describe('Site Data bulk delete', () => {
  it('deletes the ticked users and frees their numbers', async () => {
    const [n1] = (await seedNumbers(c.s, 'LON01', ['+442070000101'])).map((n) => n.id);
    const u1 = await addUser(siteA, 'a1@contoso.test');
    await addUser(siteA, 'a2@contoso.test');
    await hold(n1, 'user', u1);

    expect(await svc.bulkDelete(c.t, engineer, 'user', { ids: [u1] }, true)).toEqual({ deleted: 1 });
    expect(await usersOn(siteA)).toEqual([{ upn: 'a2@contoso.test' }]);
    expect(await number(n1)).toEqual({ status: 'available', holder_id: null });
  });

  it('deletes every user on one site only, keeping Design & Build rows unlinked', async () => {
    const u3 = await addUser(siteA, 'a3@contoso.test');
    await addUser(siteB, 'b1@contoso.test');
    const [n2] = (await seedNumbers(c.s, 'LON01', ['+442070000102'])).map((n) => n.id);
    await hold(n2, 'user', u3);
    const buildRow = await c.s
      .insertInto('build_users')
      .values({ site_id: siteA, upn: 'a3@contoso.test', discovery_user_id: u3, policies: {}, voicemail: {}, call_forwarding: {}, delegates: '[]', pickup_group: {}, validation: {}, status: {} } as never)
      .returning('id')
      .executeTakeFirstOrThrow();

    const res = await svc.bulkDelete(c.t, engineer, 'user', { site_id: siteA, all: true }, true);
    expect(res.deleted).toBe(2); // a2 + a3
    expect(await usersOn(siteA)).toEqual([]);
    expect(await usersOn(siteB)).toEqual([{ upn: 'b1@contoso.test' }]);
    expect(await number(n2)).toEqual({ status: 'available', holder_id: null });
    const kept = await c.s.selectFrom('build_users').select('discovery_user_id').where('id', '=', buildRow.id).executeTakeFirstOrThrow();
    expect(kept.discovery_user_id).toBeNull();
  });

  it('works for common area phones and resource accounts too', async () => {
    const cap = await c.s.insertInto('discovery_caps').values({ site_id: siteA, upn: 'lobby@contoso.test', display_name: 'Lobby' } as never).returning('id').executeTakeFirstOrThrow();
    const ra = await c.s.insertInto('discovery_resource_accounts').values({ site_id: siteA, name: 'Main line', kind: 'auto_attendant' } as never).returning('id').executeTakeFirstOrThrow();
    const [n3, n4] = (await seedNumbers(c.s, 'LON01', ['+442070000103', '+442070000104'])).map((n) => n.id);
    await hold(n3, 'cap', cap.id);
    await hold(n4, 'resource_account', ra.id);
    expect(await svc.bulkDelete(c.t, engineer, 'cap', { site_id: siteA, all: true }, true)).toEqual({ deleted: 1 });
    expect(await svc.bulkDelete(c.t, engineer, 'resource_account', { ids: [ra.id] }, true)).toEqual({ deleted: 1 });
    expect(await number(n3)).toEqual({ status: 'available', holder_id: null });
    expect(await number(n4)).toEqual({ status: 'available', holder_id: null });
  });

  it('respects site scope', async () => {
    await addUser(siteA, 'a4@contoso.test');
    const siteContact = { ...c.t, siteScope: [siteB] };
    await expect(svc.bulkDelete(siteContact, engineer, 'user', { site_id: siteA, all: true }, false)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await usersOn(siteA)).toEqual([{ upn: 'a4@contoso.test' }]);
  });

  it('is never locked by the review, but records the change once the site has been submitted', async () => {
    const changes = () => c.s.selectFrom('discovery_site_changes').select(['entity', 'entity_label', 'action']).where('site_id', '=', siteA).execute();
    // a draft site: nothing is recorded
    expect(await svc.bulkDelete(c.t, engineer, 'user', { site_id: siteA, all: true }, true)).toEqual({ deleted: 1 });
    expect(await changes()).toEqual([]);

    // a submitted (or accepted) site: still deletable, and the engineer is told
    await c.s.updateTable('discovery_sites').set({ review_status: 'accepted' }).where('id', '=', siteA).execute();
    await addUser(siteA, 'a5@contoso.test');
    expect(await svc.bulkDelete(c.t, engineer, 'user', { site_id: siteA, all: true }, true)).toEqual({ deleted: 1 });
    expect(await changes()).toEqual([{ entity: 'User', entity_label: 'a5@contoso.test', action: 'removed' }]);
    await c.s.updateTable('discovery_sites').set({ review_status: 'draft' }).where('id', '=', siteA).execute();
  });
});
