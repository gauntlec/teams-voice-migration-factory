// Design & Build: a row's phone number is a real claim on the shared
// phone_numbers inventory. Regressions here leak numbers (stuck 'assigned' to
// a row that no longer uses them) or leave half-created rows behind.
import { ConflictException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { seedCustomer, seedNumbers, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let build: BuildService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;
let n1: string, n2: string, n3: string;

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  const site = await seedSite(c.s, { sitecode: 'LON01' });
  siteId = site.id;
  [n1, n2, n3] = (await seedNumbers(c.s, 'LON01', ['+442070000001', '+442070000002', '+442070000003'])).map((n) => n.id);
  build = new BuildService(handle.db, new AuditService(handle.db), unused('validation'), unused('discovery'), unused('documentBuilder'), unused('files'));
});

const number = (id: string) =>
  c.s.selectFrom('phone_numbers').select(['status', 'holder_type', 'holder_id']).where('id', '=', id).executeTakeFirstOrThrow();

describe('Design & Build phone numbers', () => {
  it('changing a user’s number frees the old one', async () => {
    const row = await build.createUser(c.t, engineer, { site_id: siteId, upn: 'jo@contoso.test', phone_number_id: n1 } as never);
    expect(row.phone_number_id).toBe(n1);
    expect(await number(n1)).toEqual({ status: 'assigned', holder_type: 'user', holder_id: row.id });

    const changed = await build.updateUser(c.t, engineer, row.id, { phone_number_id: n2 } as never);
    expect(changed.phone_number_id).toBe(n2);
    expect(changed.e164).toBe('+442070000002');
    expect(await number(n1)).toEqual({ status: 'available', holder_type: null, holder_id: null });
    expect(await number(n2)).toEqual({ status: 'assigned', holder_type: 'user', holder_id: row.id });

    // and clearing it frees that one too
    const cleared = await build.updateUser(c.t, engineer, row.id, { phone_number_id: null } as never);
    expect(cleared.phone_number_id).toBeNull();
    expect(await number(n2)).toEqual({ status: 'available', holder_type: null, holder_id: null });
  });

  it('a create whose number is already taken leaves no row behind, and a retry succeeds', async () => {
    const holder = await build.createUser(c.t, engineer, { site_id: siteId, upn: 'sam@contoso.test', phone_number_id: n3 } as never);
    expect(await number(n3)).toMatchObject({ status: 'assigned', holder_id: holder.id });

    await expect(
      build.createUser(c.t, engineer, { site_id: siteId, upn: 'alex@contoso.test', phone_number_id: n3 } as never),
    ).rejects.toBeInstanceOf(ConflictException);
    const leftovers = await c.s.selectFrom('build_users').select('id').where('upn', '=', 'alex@contoso.test').execute();
    expect(leftovers).toEqual([]);
    expect(await number(n3)).toMatchObject({ status: 'assigned', holder_id: holder.id });

    // Same UPN again, with a free number - no "UPN already on this site".
    const retry = await build.createUser(c.t, engineer, { site_id: siteId, upn: 'alex@contoso.test', phone_number_id: n1 } as never);
    expect(retry.phone_number_id).toBe(n1);
    expect(await number(n1)).toMatchObject({ status: 'assigned', holder_id: retry.id });
  });
});
