// Users and single sign-on (docs/SSO.md 4.4, 4.6): "Resend invitation" must never turn a provider-only account into a local one, and
// break-glass is given on purpose to a local Super Admin (and only to one).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { UsersService } from '../../../../apps/api/src/users/users.service';
import { addOidcProvider, makeSso, seedFederatedUser, seedLocalUser } from './helpers';
import { startFakeProvider, type FakeProvider } from './fake-provider';
import { seedCustomer, useDb, useGlobalSettingsLock, useGlobalSsoLock } from '../helpers';

const handle = useDb();
useGlobalSettingsLock(handle);
useGlobalSsoLock(handle);
const sso = makeSso(handle);
const db = platformDb(handle.db);
const sent: { template: string; to: { email: string }; context: Record<string, unknown> }[] = [];
const users = new UsersService(handle.db, sso.audit, { enqueue: async (m: never) => void sent.push(m) } as never, sso.cfg);
let fake: FakeProvider;
let admin: Awaited<ReturnType<typeof seedLocalUser>>;
const superAdmin = () => ({ id: admin.id, email: admin.email, role: 'SUPER_ADMIN' as const });

beforeAll(async () => {
  await db.deleteFrom('sso_providers').execute();
  fake = await startFakeProvider();
  admin = await seedLocalUser(handle, 'SUPER_ADMIN', { breakGlass: true });
});
afterAll(async () => {
  await fake.close();
  await db.deleteFrom('sso_providers').execute();
});

const hashOf = async (id: string) => (await db.selectFrom('users').select('password_hash').where('id', '=', id).executeTakeFirstOrThrow()).password_hash;

describe('Resend invitation', () => {
  it('refuses an account that exists only through a provider, for a Super Admin and for an Engineer, and changes nothing', async () => {
    const cust = await seedCustomer(handle);
    const fed = await seedFederatedUser(handle, 'CUSTOMER');
    const eng = await seedLocalUser(handle, 'ENGINEER');
    await db.insertInto('tenant_memberships').values([{ user_id: fed.id, tenant_id: cust.t.id }, { user_id: eng.id, tenant_id: cust.t.id }] as never).execute();
    const session = await db.insertInto('auth_sessions').values({ user_id: fed.id, refresh_hash: randomUUID(), family_id: randomUUID(), expires_at: new Date(Date.now() + 3_600_000).toISOString() } as never).returning('id').executeTakeFirstOrThrow();
    sent.length = 0;

    await expect(users.resendInvitation(fed.id, superAdmin())).rejects.toThrow(/single sign-on and has no local password/);
    await expect(users.resendInvitation(fed.id, { id: eng.id, email: eng.email, role: 'ENGINEER' })).rejects.toThrow(/single sign-on and has no local password/);

    expect(await hashOf(fed.id)).toBe('!federated');
    const row = await db.selectFrom('users').select('must_change_password').where('id', '=', fed.id).executeTakeFirstOrThrow();
    expect(row.must_change_password).toBe(false);
    expect(sent).toHaveLength(0); // no email with a temporary password went out
    const after = await db.selectFrom('auth_sessions').select('revoked_at').where('id', '=', session.id).executeTakeFirstOrThrow();
    expect(after.revoked_at).toBeNull(); // their session was not ended either
  });

  it('still re-sends to a local account, with a fresh temporary password', async () => {
    const cust = await seedCustomer(handle);
    const local = await seedLocalUser(handle, 'CUSTOMER');
    await db.insertInto('tenant_memberships').values({ user_id: local.id, tenant_id: cust.t.id } as never).execute();
    const before = await hashOf(local.id);
    sent.length = 0;
    const r = await users.resendInvitation(local.id, superAdmin());
    expect(r.tempPassword).toBeTruthy();
    expect(await hashOf(local.id)).not.toBe(before);
    expect(sent.map((m) => m.template)).toEqual(['user_invitation']);
  });

  it('lists which accounts have a local password, so the screen can hide the action', async () => {
    const fed = await seedFederatedUser(handle, 'ENGINEER');
    const local = await seedLocalUser(handle, 'ENGINEER');
    const list = await users.list({ id: admin.id, role: 'SUPER_ADMIN' });
    expect(list.find((u) => u.id === fed.id)!.has_password).toBe(false);
    expect(list.find((u) => u.id === local.id)!.has_password).toBe(true);
  });
});

describe('break-glass administrators', () => {
  it('a Super Admin created under Users is break-glass; one made through a provider is not (it has no password)', async () => {
    const created = await users.create({ email: `bg-${randomUUID().slice(0, 8)}@local.test`, displayName: 'BG', role: 'SUPER_ADMIN' } as never, superAdmin());
    expect((await db.selectFrom('users').select('break_glass').where('id', '=', created.id).executeTakeFirstOrThrow()).break_glass).toBe(true);
    const fed = await seedFederatedUser(handle, 'SUPER_ADMIN');
    expect((await db.selectFrom('users').select('break_glass').where('id', '=', fed.id).executeTakeFirstOrThrow()).break_glass).toBe(false);
    await expect(users.setBreakGlass(fed.id, true, superAdmin())).rejects.toThrow(/no local password/);
  });

  it('can be given to a local Super Admin who was promoted later, with an audit entry, and only to one', async () => {
    const promoted = await seedLocalUser(handle, 'ENGINEER');
    await db.updateTable('users').set({ role: 'SUPER_ADMIN' }).where('id', '=', promoted.id).execute(); // promoted some other way: break_glass stays false
    expect((await db.selectFrom('users').select('break_glass').where('id', '=', promoted.id).executeTakeFirstOrThrow()).break_glass).toBe(false);

    const eng = await seedLocalUser(handle, 'ENGINEER');
    await expect(users.setBreakGlass(eng.id, true, superAdmin())).rejects.toThrow(/Only a Super Admin/);

    expect(await users.setBreakGlass(promoted.id, true, superAdmin())).toEqual({ id: promoted.id, break_glass: true });
    const log = await db.selectFrom('platform_audit_log').select('detail').where('action', '=', 'user.break_glass_changed').where('target_id', '=', promoted.id).execute();
    expect(log).toHaveLength(1);
    await expect(users.setBreakGlass(randomUUID(), true, superAdmin())).rejects.toThrow(/not found/);
  });

  it('is refused for an account linked to a provider, because a break-glass account never signs in through one', async () => {
    const id = await addOidcProvider(handle, fake, { name: 'Linked' });
    const linked = await seedLocalUser(handle, 'SUPER_ADMIN');
    await db.insertInto('external_identities').values({ user_id: linked.id, provider_id: id, subject: randomUUID() }).execute();
    await expect(users.setBreakGlass(linked.id, true, superAdmin())).rejects.toThrow(/linked to a single sign-on provider/);
  });

  it('cannot be removed from the last break-glass administrator while a provider has local passwords off', async () => {
    const strict = await addOidcProvider(handle, fake, { name: 'Strict again', allow_local_passwords: false });
    await db.updateTable('users').set({ break_glass: false }).where('break_glass', '=', true).where('id', '!=', admin.id).execute();
    try {
      await expect(users.setBreakGlass(admin.id, false, superAdmin())).rejects.toThrow(/last local \(break-glass\) administrator/);
      const second = await seedLocalUser(handle, 'SUPER_ADMIN', { breakGlass: true });
      await expect(users.setBreakGlass(second.id, false, superAdmin())).resolves.toMatchObject({ break_glass: false });
    } finally {
      await db.updateTable('sso_providers').set({ enabled: false }).where('id', '=', strict).execute();
    }
  });
});
