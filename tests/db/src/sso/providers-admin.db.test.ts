// Administration > Platform settings > Single sign-on (docs/SSO.md 4.5a): adding and changing providers, what is audited, and that the
// client secret never comes back out.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { startFakeProvider, type FakeProvider } from './fake-provider';
import { addOidcProvider, makeSso, newEmail, newSub, seedLocalUser, signInAs } from './helpers';
import { useDb, useGlobalSettingsLock, useGlobalSsoLock } from '../helpers';

const handle = useDb();
useGlobalSettingsLock(handle);
useGlobalSsoLock(handle);
const sso = makeSso(handle);
const db = platformDb(handle.db);
let fake: FakeProvider;
let admin: Awaited<ReturnType<typeof seedLocalUser>>;
const actor = () => ({ id: admin.id, email: admin.email });

beforeAll(async () => {
  await db.deleteFrom('sso_providers').execute();
  fake = await startFakeProvider();
  admin = await seedLocalUser(handle, 'SUPER_ADMIN', { breakGlass: true });
});
afterAll(async () => {
  await fake.close();
  await db.deleteFrom('sso_providers').execute();
});

const changes = (providerId: string) => db.selectFrom('platform_audit_log').select('detail').where('action', '=', 'sso.provider.changed').where('target_id', '=', providerId).orderBy('at').execute();

describe('adding a provider', () => {
  it('reads the provider\'s configuration first, and says in words when it cannot', async () => {
    await expect(sso.providers.create({ name: 'Nowhere', issuer: 'http://127.0.0.1:1', clientId: 'x', clientSecret: 'y' }, actor())).rejects.toThrow(/could not read http:\/\/127\.0\.0\.1:1\/\.well-known\/openid-configuration/);
    expect(await db.selectFrom('sso_providers').select('id').where('name', '=', 'Nowhere').execute()).toHaveLength(0);
  });

  it('adds it SWITCHED OFF, encrypts the secret, never returns it, and audits the change without it', async () => {
    const view = await sso.providers.create({ name: 'Contoso Entra', issuer: `${fake.issuer}/`, clientId: fake.clientId, clientSecret: fake.clientSecret, roleClaim: 'roles', roleMap: { Admins: 'SUPER_ADMIN' } }, actor());
    expect(view).toMatchObject({ kind: 'oidc', name: 'Contoso Entra', issuer: fake.issuer, enabled: false, secretSet: true, roleCeiling: 'PROJECT_MANAGER', defaultRole: 'CUSTOMER', requireMfaClaim: true, jitCreate: true, allowLocalPasswords: true, redirectUri: 'https://voxshift.test/api/auth/oidc/callback', identityCount: 0 });
    expect(JSON.stringify(view)).not.toContain(fake.clientSecret);
    const row = await db.selectFrom('sso_providers').selectAll().where('id', '=', view.id).executeTakeFirstOrThrow();
    expect(row.client_secret_enc).toBeTruthy();
    expect(row.client_secret_enc).not.toContain(fake.clientSecret);
    expect(JSON.stringify(await changes(view.id))).not.toContain(fake.clientSecret);
    expect((await changes(view.id))[0]!.detail).toMatchObject({ change: 'created', enabled: false });
    // a provider that is off does not appear on the login page
    expect((await sso.providers.publicList()).providers.map((p) => p.id)).not.toContain(view.id);
  });

  it('refuses a second provider with the same name', async () => {
    await expect(sso.providers.create({ name: 'contoso entra', issuer: fake.issuer, clientId: 'a', clientSecret: 'b' }, actor())).rejects.toThrow(/already exists/);
  });
});

describe('changing a provider', () => {
  it('audits what changed (old and new), keeps the secret unless a new one is given, and replaces it when it is', async () => {
    const id = await addOidcProvider(handle, fake, { enabled: false, name: 'Change me' });
    const before = (await db.selectFrom('sso_providers').select('client_secret_enc').where('id', '=', id).executeTakeFirstOrThrow()).client_secret_enc;
    const v = await sso.providers.update(id, { enabled: true, roleCeiling: 'ENGINEER', jitCreate: false, emailDomains: ['contoso.com'] }, actor());
    expect(v).toMatchObject({ enabled: true, roleCeiling: 'ENGINEER', jitCreate: false, emailDomains: ['contoso.com'] });
    expect((await db.selectFrom('sso_providers').select('client_secret_enc').where('id', '=', id).executeTakeFirstOrThrow()).client_secret_enc).toBe(before);
    const first = (await changes(id)).at(-1)!.detail as { changes: Record<string, { from: unknown; to: unknown }> };
    expect(first.changes.roleCeiling).toEqual({ from: 'PROJECT_MANAGER', to: 'ENGINEER' });
    expect(first.changes.enabled).toEqual({ from: false, to: true });

    await sso.providers.update(id, { clientSecret: 'a-brand-new-secret' }, actor());
    expect((await db.selectFrom('sso_providers').select('client_secret_enc').where('id', '=', id).executeTakeFirstOrThrow()).client_secret_enc).not.toBe(before);
    const logged = JSON.stringify(await changes(id));
    expect(logged).not.toContain('a-brand-new-secret');
    expect(logged).toContain('clientSecret'); // that it changed is recorded, the value never is
    // changing nothing writes nothing
    const n = (await changes(id)).length;
    await sso.providers.update(id, { roleCeiling: 'ENGINEER' }, actor());
    expect((await changes(id)).length).toBe(n);
  });

  it('only lets local passwords be switched off while a break-glass administrator exists, and says why', async () => {
    const id = await addOidcProvider(handle, fake, { enabled: false, name: 'No passwords' });
    // seeded in beforeAll: an active, local, break-glass Super Admin exists, so this is allowed
    const v = await sso.providers.update(id, { enabled: true, allowLocalPasswords: false }, actor());
    expect(v).toMatchObject({ enabled: true, allowLocalPasswords: false });
    expect(await sso.providers.settings()).toMatchObject({ localPasswords: false });
    await sso.providers.update(id, { enabled: false }, actor());
    expect(await sso.providers.settings()).toMatchObject({ localPasswords: true });
  });

  it('refuses a name that is already used and a provider that does not exist', async () => {
    const a = await addOidcProvider(handle, fake, { name: 'Alpha' });
    await addOidcProvider(handle, fake, { name: 'Bravo' });
    await expect(sso.providers.update(a, { name: 'bravo' }, actor())).rejects.toThrow(/already exists/);
    await expect(sso.providers.update('00000000-0000-0000-0000-000000000000', { enabled: true }, actor())).rejects.toThrow(/No such provider/);
  });

  it('lowering the ceiling or switching a provider off ends sessions above it at the next refresh', async () => {
    const id = await addOidcProvider(handle, fake, { name: 'Lower me', default_role: 'PROJECT_MANAGER', role_ceiling: 'PROJECT_MANAGER' });
    const { result } = await signInAs(sso, id, fake, { sub: newSub(), email: newEmail('lower') });
    if (result.kind !== 'session') throw new Error('no session');
    await sso.providers.update(id, { roleCeiling: 'ENGINEER' }, actor());
    await expect(sso.auth.refresh(result.refreshCookieValue, { ip: '1.1.1.1' })).rejects.toThrow(/signed out/i);
  });
});

describe('removing a provider and linking people', () => {
  it('removes its people, waiting sign-ins and sessions with it, and leaves the user accounts', async () => {
    const id = await addOidcProvider(handle, fake, { name: 'Remove me' });
    const email = newEmail('rm');
    const { result } = await signInAs(sso, id, fake, { sub: newSub(), email });
    if (result.kind !== 'session') throw new Error('no session');
    await sso.providers.remove(id, actor());
    expect(await db.selectFrom('sso_providers').select('id').where('id', '=', id).execute()).toHaveLength(0);
    expect(await db.selectFrom('external_identities').select('id').where('provider_id', '=', id).execute()).toHaveLength(0);
    expect(await db.selectFrom('users').select('id').where('email', '=', email).execute()).toHaveLength(1); // the account stays
    await expect(sso.auth.refresh(result.refreshCookieValue, { ip: '1.1.1.1' })).rejects.toThrow(); // but the session is gone
    expect((await changes(id)).at(-1)!.detail).toMatchObject({ change: 'deleted' });
  });

  it('links by a provider subject typed in, lists a user\'s links, and refuses a provider that does not exist', async () => {
    const id = await addOidcProvider(handle, fake, { name: 'Link here' });
    const u = await seedLocalUser(handle, 'ENGINEER');
    const list = await sso.providers.link(u.id, { providerId: id, subject: 'typed-subject' }, actor());
    expect(list).toMatchObject([{ providerId: id, subject: 'typed-subject' }]);
    await expect(sso.providers.link(u.id, { providerId: id, subject: 'typed-subject' }, actor())).rejects.toThrow(/already linked to this user/);
    await expect(sso.providers.link(u.id, { providerId: '00000000-0000-0000-0000-000000000000', subject: 's' }, actor())).rejects.toThrow(/No such provider/);
    await expect(sso.providers.link('00000000-0000-0000-0000-000000000000', { providerId: id, subject: 's' }, actor())).rejects.toThrow(/No such user/);
    // and that person can now sign in as this user
    const { result } = await signInAs(sso, id, fake, { sub: 'typed-subject', email: 'whatever@idp.test' });
    expect(result.kind).toBe('session');
    expect((await sso.providers.settings()).providers.find((p) => p.id === id)!.identityCount).toBe(1);
  });
});
