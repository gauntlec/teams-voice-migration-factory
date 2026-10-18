// Signing in through an OpenID Connect provider, end to end against a stand-in provider on a local port (docs/SSO.md 4.2-4.6, 7):
// success, just-in-time users, no linking by email, an explicit link, disabled users, break glass, replays, and every way a token can be wrong.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { startFakeProvider, type FakeProvider } from './fake-provider';
import { META, PASSWORD, addOidcProvider, makeSso, newEmail, newSub, seedFederatedUser, seedLocalUser, signInAs } from './helpers';
import { useDb, useGlobalSettingsLock, useGlobalSsoLock } from '../helpers';
import { JwtAuthGuard } from '../../../../apps/api/src/auth/jwt-auth.guard';

const handle = useDb();
useGlobalSettingsLock(handle);
useGlobalSsoLock(handle);
const sso = makeSso(handle);
const db = platformDb(handle.db);
let fake: FakeProvider;

beforeAll(async () => {
  await db.deleteFrom('sso_providers').execute();
  fake = await startFakeProvider();
});
afterAll(async () => {
  await fake.close();
  await db.deleteFrom('sso_providers').execute();
});

const auditFor = (email: string, action: string) => db.selectFrom('platform_audit_log').selectAll().where('actor_email', '=', email).where('action', '=', action).execute();
const refusedReasons = async (email: string) => (await auditFor(email, 'sso.login.refused')).map((r) => (r.detail as { reason: string }).reason);
const userByEmail = (email: string) => db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();

describe('a successful sign-in', () => {
  it('creates the user just in time, starts a federated session and records how', async () => {
    const providerId = await addOidcProvider(handle, fake, { default_role: 'ENGINEER' });
    const email = newEmail('jit');
    const sub = newSub();
    const { result } = await signInAs(sso, providerId, fake, { sub, email, name: 'Jo Federated' });
    expect(result.kind).toBe('session');
    if (result.kind !== 'session') return;
    expect(result.redirectTo).toBe('/');

    const user = (await userByEmail(email))!;
    expect(user).toMatchObject({ role: 'ENGINEER', display_name: 'Jo Federated', totp_enrolled: false, must_change_password: false, break_glass: false, status: 'active' });
    expect(user.password_hash).toBe('!federated'); // no usable password

    const identity = await db.selectFrom('external_identities').selectAll().where('provider_id', '=', providerId).where('subject', '=', sub).executeTakeFirstOrThrow();
    expect(identity.user_id).toBe(user.id);
    expect(identity.last_login_at).not.toBeNull();

    // the session: provider, methods, and an absolute end (12 hours by default)
    const [sessionId] = result.refreshCookieValue.split('.');
    const session = await db.selectFrom('auth_sessions').selectAll().where('id', '=', sessionId!).executeTakeFirstOrThrow();
    expect(session).toMatchObject({ idp: providerId, amr: ['pwd', 'otp', 'mfa'], user_id: user.id });
    const hours = (new Date(session.absolute_expires_at!).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThanOrEqual(12);

    // the audit trail
    expect(await auditFor(email, 'sso.user.created')).toHaveLength(1);
    const success = (await auditFor(email, 'sso.login.success'))[0]!;
    expect(success.detail).toMatchObject({ subject: sub, role: 'ENGINEER', created: true, amr: ['pwd', 'otp', 'mfa'] });
    expect(JSON.stringify(success.detail)).not.toMatch(/eyJ|secret|code-/); // no token, code or secret

    // and it is a real session: it refreshes, the access token says where it came from, the guard needs no local authenticator
    const refreshed = await sso.auth.refresh(result.refreshCookieValue, META);
    const payload = sso.tokens.verifyAccess(refreshed.accessToken);
    expect(payload).toMatchObject({ sub: user.id, typ: 'access', idp: providerId });
    const guard = new JwtAuthGuard({ getAllAndOverride: () => false } as never, sso.tokens, handle.db);
    const req: { headers: Record<string, string>; user?: { idp?: string } } = { headers: { authorization: `Bearer ${refreshed.accessToken}` } };
    await expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }), getHandler: () => null, getClass: () => null } as never)).resolves.toBe(true);
    expect(req.user?.idp).toBe(providerId);
    expect(await sso.auth.me(user.id, providerId)).toMatchObject({ signInMethod: 'sso', ssoProviderName: expect.any(String), totpEnrolled: false });
  });

  it('signs the same person in again as the same user, without creating another', async () => {
    const providerId = await addOidcProvider(handle, fake);
    const email = newEmail('again');
    const sub = newSub();
    await signInAs(sso, providerId, fake, { sub, email });
    const second = await signInAs(sso, providerId, fake, { sub, email: 'changed@idp.test' });
    expect(second.result.kind).toBe('session');
    expect(await db.selectFrom('users').select('id').where('email', '=', email).execute()).toHaveLength(1);
    expect(await db.selectFrom('external_identities').select('id').where('provider_id', '=', providerId).where('subject', '=', sub).execute()).toHaveLength(1);
    expect(await auditFor(email, 'sso.user.created')).toHaveLength(1);
  });

  it('lands on the page asked for, but only a path inside the application', async () => {
    const providerId = await addOidcProvider(handle, fake);
    const begun = await sso.signIn.begin({ providerId, returnTo: 'https://evil.example.com/steal', meta: META });
    if (!begun.ok) throw new Error('begin failed');
    const cb = fake.authorize(begun.redirectUrl, { sub: newSub(), email: newEmail() });
    const r = await sso.signIn.complete({ ...cb, stateCookie: begun.stateCookie, meta: META });
    expect(r.kind === 'session' && r.redirectTo).toBe('/');
    const begun2 = await sso.signIn.begin({ providerId, returnTo: '/incidents/42', meta: META });
    if (!begun2.ok) throw new Error('begin failed');
    const r2 = await sso.signIn.complete({ ...fake.authorize(begun2.redirectUrl, { sub: newSub(), email: newEmail() }), stateCookie: begun2.stateCookie, meta: META });
    expect(r2.kind === 'session' && r2.redirectTo).toBe('/incidents/42');
  });
});

describe('no linking by email', () => {
  it('refuses a sign-in whose email belongs to an existing local account, and changes nothing', async () => {
    const providerId = await addOidcProvider(handle, fake);
    const local = await seedLocalUser(handle, 'SUPER_ADMIN', { breakGlass: true });
    const sub = newSub();
    const { result } = await signInAs(sso, providerId, fake, { sub, email: local.email });
    expect(result).toEqual({ kind: 'refused', error: 'email_exists' });
    expect(await db.selectFrom('external_identities').select('id').where('provider_id', '=', providerId).execute()).toHaveLength(0);
    expect(await db.selectFrom('users').select('id').where('email', '=', local.email).execute()).toHaveLength(1);
    expect(await refusedReasons(local.email)).toContain('email_exists_unlinked');
    // kept as a waiting sign-in the administrator can link on purpose
    const waiting = await sso.providers.linkRequests();
    expect(waiting.find((w) => w.email === local.email && w.providerId === providerId)).toBeTruthy();
    // and the local account still works exactly as before
    expect('accessToken' in (await sso.auth.login(local.email, PASSWORD, local.code(), META))).toBe(true);
  });

  it('matches the email in any letter case, and never by a different email that merely looks similar', async () => {
    const providerId = await addOidcProvider(handle, fake);
    const local = await seedLocalUser(handle, 'ENGINEER');
    expect((await signInAs(sso, providerId, fake, { sub: newSub(), email: local.email.toUpperCase() })).result).toEqual({ kind: 'refused', error: 'email_exists' });
    const other = await signInAs(sso, providerId, fake, { sub: newSub(), email: `x${local.email}` });
    expect(other.result.kind).toBe('session'); // a different address is a different person
  });

  it('lets an administrator link on purpose, and then the person signs in as that user', async () => {
    const providerId = await addOidcProvider(handle, fake, { default_role: 'ENGINEER' });
    const local = await seedLocalUser(handle, 'PROJECT_MANAGER');
    const admin = await seedLocalUser(handle, 'SUPER_ADMIN', { breakGlass: true });
    const sub = newSub();
    expect((await signInAs(sso, providerId, fake, { sub, email: local.email })).result.kind).toBe('refused');

    const waiting = (await sso.providers.linkRequests(local.id)).find((w) => w.email === local.email)!;
    expect(waiting.matchesUser).toBe(true);
    const linked = await sso.providers.link(local.id, { requestId: waiting.id }, { id: admin.id, email: admin.email });
    expect(linked).toHaveLength(1);
    expect(await auditFor(admin.email, 'sso.user.linked')).toHaveLength(1);
    expect((await sso.providers.linkRequests()).find((w) => w.id === waiting.id)).toBeUndefined();

    const { result } = await signInAs(sso, providerId, fake, { sub, email: local.email });
    expect(result.kind).toBe('session');
    const user = (await userByEmail(local.email))!;
    expect(user.id).toBe(local.id); // the same account, not a new one
    expect(user.role).toBe('ENGINEER'); // the provider decides the role from now on (default role, within the ceiling)
    expect(user.password_hash).not.toBe('!federated'); // linking does not remove the local password
  });

  it('will not link a break-glass administrator, or one person at a provider to two users', async () => {
    const providerId = await addOidcProvider(handle, fake);
    const admin = await seedLocalUser(handle, 'SUPER_ADMIN', { breakGlass: true });
    const a = await seedLocalUser(handle, 'ENGINEER');
    const b = await seedLocalUser(handle, 'ENGINEER');
    await expect(sso.providers.link(admin.id, { providerId, subject: 'x' }, { id: admin.id })).rejects.toThrow(/break-glass/);
    await sso.providers.link(a.id, { providerId, subject: 'shared-subject' }, { id: admin.id });
    await expect(sso.providers.link(b.id, { providerId, subject: 'shared-subject' }, { id: admin.id })).rejects.toThrow(/already linked to a different user/);
  });

  it('unlinking signs the person out at once', async () => {
    const providerId = await addOidcProvider(handle, fake);
    const admin = await seedLocalUser(handle, 'SUPER_ADMIN', { breakGlass: true });
    const email = newEmail('unlink');
    const { result } = await signInAs(sso, providerId, fake, { sub: newSub(), email });
    if (result.kind !== 'session') throw new Error('no session');
    const user = (await userByEmail(email))!;
    const [identity] = await sso.providers.identitiesOf(user.id);
    await sso.providers.unlink(identity!.id, { id: admin.id });
    await expect(sso.auth.refresh(result.refreshCookieValue, META)).rejects.toThrow();
  });
});

describe('who may sign in', () => {
  it('refuses when automatic account creation is off', async () => {
    const providerId = await addOidcProvider(handle, fake, { jit_create: false });
    const email = newEmail('nojit');
    expect((await signInAs(sso, providerId, fake, { sub: newSub(), email })).result).toEqual({ kind: 'refused', error: 'no_account' });
    expect(await userByEmail(email)).toBeUndefined();
    expect(await refusedReasons(email)).toContain('no_identity_jit_off');
  });

  it('refuses a disabled user, with a clear message and an audit event', async () => {
    const providerId = await addOidcProvider(handle, fake);
    const email = newEmail('disabled');
    const sub = newSub();
    await signInAs(sso, providerId, fake, { sub, email });
    await db.updateTable('users').set({ status: 'disabled' }).where('email', '=', email).execute();
    expect((await signInAs(sso, providerId, fake, { sub, email })).result).toEqual({ kind: 'refused', error: 'disabled' });
    expect(await refusedReasons(email)).toContain('user_disabled');
  });

  it('keeps a break-glass administrator on password and authenticator, whatever a provider says', async () => {
    const providerId = await addOidcProvider(handle, fake, { allow_local_passwords: false, role_ceiling: 'SUPER_ADMIN' });
    const admin = await seedLocalUser(handle, 'SUPER_ADMIN', { breakGlass: true });
    // local sign-in still works even though the provider switched local passwords off
    expect('accessToken' in (await sso.auth.login(admin.email, PASSWORD, admin.code(), META))).toBe(true);
    // and an identity row that somehow points at a break-glass account is never honoured
    const sub = newSub();
    await db.insertInto('external_identities').values({ user_id: admin.id, provider_id: providerId, subject: sub, email: admin.email }).execute();
    expect((await signInAs(sso, providerId, fake, { sub, email: admin.email })).result).toEqual({ kind: 'refused', error: 'local_only' });
    expect((await userByEmail(admin.email))!.role).toBe('SUPER_ADMIN'); // untouched
    await db.updateTable('sso_providers').set({ enabled: false }).where('id', '=', providerId).execute();
  });

  it('applies the email domain allow-list', async () => {
    const providerId = await addOidcProvider(handle, fake, { email_domains: ['contoso.com'] });
    expect((await signInAs(sso, providerId, fake, { sub: newSub(), email: 'x@fabrikam.com' })).result).toEqual({ kind: 'refused', error: 'domain' });
    expect((await signInAs(sso, providerId, fake, { sub: newSub(), email: newEmail().replace('idp.test', 'contoso.com') })).result.kind).toBe('session');
    expect((await signInAs(sso, providerId, fake, { sub: newSub(), email: null })).result).toEqual({ kind: 'refused', error: 'no_email' });
  });

  it('refuses an email the provider says is not verified, and a provider that is switched off', async () => {
    const providerId = await addOidcProvider(handle, fake);
    expect((await signInAs(sso, providerId, fake, { sub: newSub(), email: newEmail(), email_verified: false })).result).toEqual({ kind: 'refused', error: 'no_email' });
    await db.updateTable('sso_providers').set({ enabled: false }).where('id', '=', providerId).execute();
    const off = await signInAs(sso, providerId, fake, { sub: newSub(), email: newEmail() });
    expect(off.begun).toEqual({ ok: false, error: 'provider_off' });
  });

  it('can sign in with the sign-in name when the provider sends no email claim (Entra ID)', async () => {
    const providerId = await addOidcProvider(handle, fake);
    const upn = newEmail('upn');
    const { result } = await signInAs(sso, providerId, fake, { sub: newSub(), email: null, extra: { preferred_username: upn } });
    expect(result.kind).toBe('session');
    expect(await userByEmail(upn)).toBeTruthy();
  });
});

describe('a token that is wrong in any way is refused', () => {
  const cases: [string, Parameters<typeof signInAs>[4], string][] = [
    ['another audience', { aud: 'some-other-client' }, 'token_audience'],
    ['another issuer', { iss: 'https://evil.example.com' }, 'token_issuer'],
    ['another nonce', { nonce: 'not-the-one-we-sent' }, 'token_nonce'],
    ['no nonce', { nonce: null }, 'token_nonce'],
    ['expired', { expOffset: -3600, iatOffset: -3700 }, 'token_expired'],
    ['issued in the future', { iatOffset: 3600, expOffset: 4000 }, 'token_not_yet_valid'],
    ['alg none', { alg: 'none' }, 'token_alg_not_allowed'],
    ['alg HS256', { alg: 'HS256' }, 'token_alg_not_allowed'],
    ['a key the provider does not publish', { alg: 'wrongKey' }, 'token_signature'],
    ['an unknown key id', { kid: 'never-published' }, 'unknown_key'],
    ['a token endpoint error', { tokenStatus: 500 }, 'token_endpoint_error'],
  ];
  for (const [name, tweaks, reason] of cases) {
    it(`refuses ${name}`, async () => {
      const providerId = await addOidcProvider(handle, fake);
      const email = newEmail('bad');
      const { result } = await signInAs(sso, providerId, fake, { sub: newSub(), email }, tweaks);
      expect(result).toEqual({ kind: 'refused', error: 'failed' });
      expect(await userByEmail(email)).toBeUndefined(); // nobody was created
      const log = await db.selectFrom('platform_audit_log').select('detail').where('action', '=', 'sso.login.refused').where('target_id', '=', providerId).execute();
      expect(log.map((l) => (l.detail as { reason: string }).reason)).toContain(reason);
    });
  }

  it('says so plainly when the provider did not prove a second factor, unless that is not required', async () => {
    const strict = await addOidcProvider(handle, fake, { require_mfa_claim: true });
    expect((await signInAs(sso, strict, fake, { sub: newSub(), email: newEmail(), amr: ['pwd'] })).result).toEqual({ kind: 'refused', error: 'mfa_required' });
    const relaxed = await addOidcProvider(handle, fake, { require_mfa_claim: false });
    expect((await signInAs(sso, relaxed, fake, { sub: newSub(), email: newEmail(), amr: ['pwd'] })).result.kind).toBe('session');
  });

  it('accepts a token signed with a key published after the first fetch (key rotation)', async () => {
    const providerId = await addOidcProvider(handle, fake);
    await signInAs(sso, providerId, fake, { sub: newSub(), email: newEmail() }); // the key set is now cached
    await fake.rotateKey({ keepOld: false });
    const { result } = await signInAs(sso, providerId, fake, { sub: newSub(), email: newEmail() });
    expect(result.kind).toBe('session');
  });

  it('refuses a replayed callback, and a replayed ID token', async () => {
    const providerId = await addOidcProvider(handle, fake);
    const begun = await sso.signIn.begin({ providerId, meta: META });
    if (!begun.ok) throw new Error('begin failed');
    const cb = fake.authorize(begun.redirectUrl, { sub: newSub(), email: newEmail() });
    const first = await sso.signIn.complete({ ...cb, stateCookie: begun.stateCookie, meta: META });
    const again = await sso.signIn.complete({ ...cb, stateCookie: begun.stateCookie, meta: META });
    expect(first.kind).toBe('session');
    expect(again).toEqual({ kind: 'refused', error: 'failed' });
    const log = await db.selectFrom('platform_audit_log').select('detail').where('action', '=', 'sso.login.refused').where('target_id', '=', providerId).execute();
    expect(log.map((l) => (l.detail as { reason: string }).reason)).toContain('code_replayed');

    // a different code, but an ID token carrying a jti already seen
    const a = await signInAs(sso, providerId, fake, { sub: newSub(), email: newEmail() }, { jti: 'fixed-jti-1' });
    const b = await signInAs(sso, providerId, fake, { sub: newSub(), email: newEmail() }, { jti: 'fixed-jti-1' });
    expect(a.result.kind).toBe('session');
    expect(b.result).toEqual({ kind: 'refused', error: 'failed' });
  });

  it('refuses a callback that does not belong to this browser', async () => {
    const providerId = await addOidcProvider(handle, fake);
    const begun = await sso.signIn.begin({ providerId, meta: META });
    if (!begun.ok) throw new Error('begin failed');
    const cb = fake.authorize(begun.redirectUrl, { sub: newSub(), email: newEmail() });
    expect(await sso.signIn.complete({ ...cb, state: 'forged-state', stateCookie: begun.stateCookie, meta: META })).toEqual({ kind: 'refused', error: 'failed' });
    const cb2 = fake.authorize(begun.redirectUrl, { sub: newSub(), email: newEmail() });
    expect(await sso.signIn.complete({ ...cb2, stateCookie: undefined, meta: META })).toEqual({ kind: 'refused', error: 'failed' });
    const cb3 = fake.authorize(begun.redirectUrl, { sub: newSub(), email: newEmail() });
    expect(await sso.signIn.complete({ ...cb3, stateCookie: 'a.forged.cookie', meta: META })).toEqual({ kind: 'refused', error: 'failed' });
    expect(await sso.signIn.complete({ code: undefined, state: cb3.state, stateCookie: begun.stateCookie, error: 'access_denied', meta: META })).toEqual({ kind: 'refused', error: 'failed' });
  });

  it('sends the client secret to the provider only in the token request, and never writes it to the audit log', async () => {
    const providerId = await addOidcProvider(handle, fake);
    await signInAs(sso, providerId, fake, { sub: newSub(), email: newEmail() });
    const call = fake.tokenRequests().at(-1)!;
    expect(call.auth).toMatch(/^Basic /);
    expect(call.body.get('client_secret')).toBeNull();
    const rows = await db.selectFrom('platform_audit_log').select('detail').where('target_id', '=', providerId).execute();
    expect(JSON.stringify(rows)).not.toContain(fake.clientSecret);
  });
});

describe('the session', () => {
  it('ends at the absolute cap whatever refreshing does, and the cap is a setting', async () => {
    await db.insertInto('app_settings').values({ id: true, base_url: null, sso_session_max_hours: 1 } as never).onConflict((oc) => oc.column('id').doUpdateSet({ sso_session_max_hours: 1 })).execute();
    try {
      const providerId = await addOidcProvider(handle, fake);
      const { result } = await signInAs(sso, providerId, fake, { sub: newSub(), email: newEmail() });
      if (result.kind !== 'session') throw new Error('no session');
      const [id] = result.refreshCookieValue.split('.');
      const row = await db.selectFrom('auth_sessions').select(['absolute_expires_at', 'expires_at']).where('id', '=', id!).executeTakeFirstOrThrow();
      const hours = (new Date(row.absolute_expires_at!).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(0.9);
      expect(hours).toBeLessThanOrEqual(1);
      expect(new Date(row.expires_at).getTime()).toBeLessThanOrEqual(new Date(row.absolute_expires_at!).getTime()); // the refresh cookie does not outlive it

      const next = await sso.auth.refresh(result.refreshCookieValue, META);
      const [nextId] = next.refreshCookieValue.split('.');
      const nextRow = await db.selectFrom('auth_sessions').select(['absolute_expires_at', 'idp', 'amr']).where('id', '=', nextId!).executeTakeFirstOrThrow();
      expect(new Date(nextRow.absolute_expires_at!).getTime()).toBe(new Date(row.absolute_expires_at!).getTime()); // carried, not extended
      expect(nextRow.idp).toBe(providerId);

      await db.updateTable('auth_sessions').set({ absolute_expires_at: new Date(Date.now() - 1000).toISOString() }).where('id', '=', nextId!).execute();
      await expect(sso.auth.refresh(next.refreshCookieValue, META)).rejects.toThrow(/expired/i);
    } finally {
      await db.updateTable('app_settings').set({ sso_session_max_hours: 12 }).execute();
    }
  });

  it('signs a federated user out at the next refresh when the provider is switched off, the identity is removed, the person is disabled or the ceiling drops', async () => {
    const make = async (role: 'ENGINEER' | 'PROJECT_MANAGER' = 'ENGINEER') => {
      const providerId = await addOidcProvider(handle, fake, { default_role: role, role_ceiling: 'PROJECT_MANAGER' });
      const email = newEmail('rev');
      const { result } = await signInAs(sso, providerId, fake, { sub: newSub(), email });
      if (result.kind !== 'session') throw new Error('no session');
      return { providerId, email, cookie: result.refreshCookieValue };
    };

    const off = await make();
    await sso.auth.refresh(off.cookie, META).then((r) => expect(r.accessToken).toBeTruthy());
    const off2 = await make();
    await db.updateTable('sso_providers').set({ enabled: false }).where('id', '=', off2.providerId).execute();
    await expect(sso.auth.refresh(off2.cookie, META)).rejects.toThrow(/signed out/i);

    const gone = await make();
    await db.deleteFrom('external_identities').where('provider_id', '=', gone.providerId).execute();
    await expect(sso.auth.refresh(gone.cookie, META)).rejects.toThrow(/signed out/i);

    const dis = await make();
    await db.updateTable('users').set({ status: 'disabled' }).where('email', '=', dis.email).execute();
    await expect(sso.auth.refresh(dis.cookie, META)).rejects.toThrow();

    const lowered = await make('PROJECT_MANAGER');
    await sso.auth.refresh(lowered.cookie, META).then((r) => expect(r.accessToken).toBeTruthy()); // allowed at first (rotates the cookie though)
    const fresh = await signInAs(sso, lowered.providerId, fake, { sub: newSub(), email: newEmail('rev2') });
    if (fresh.result.kind !== 'session') throw new Error('no session');
    await db.updateTable('sso_providers').set({ role_ceiling: 'CUSTOMER' }).where('id', '=', lowered.providerId).execute();
    await expect(sso.auth.refresh(fresh.result.refreshCookieValue, META)).rejects.toThrow(/signed out/i);
    const revoked = await db.selectFrom('platform_audit_log').select('detail').where('action', '=', 'sso.revoked').where('target_type', '=', 'user').execute();
    const reasons = revoked.map((r) => (r.detail as { reason: string }).reason);
    expect(reasons).toEqual(expect.arrayContaining(['provider-off', 'identity-removed', 'ceiling-lowered']));
  });

  it('leaves password sessions alone', async () => {
    const local = await seedLocalUser(handle, 'ENGINEER');
    const login = await sso.auth.login(local.email, PASSWORD, local.code(), META);
    if (!('refreshCookieValue' in login)) throw new Error('no session');
    expect((await sso.auth.refresh(login.refreshCookieValue, META)).accessToken).toBeTruthy();
    const [id] = login.refreshCookieValue.split('.');
    const row = await db.selectFrom('auth_sessions').select(['idp', 'absolute_expires_at', 'amr']).where('id', '=', id!).executeTakeFirstOrThrow();
    expect(row).toEqual({ idp: null, absolute_expires_at: null, amr: [] });
  });
});

describe('"Test sign-in"', () => {
  it('proves the provider and the role it would give, and creates nothing', async () => {
    const providerId = await addOidcProvider(handle, fake, { enabled: false, role_claim: 'groups', role_map: { vox: 'SUPER_ADMIN' }, role_ceiling: 'ENGINEER' });
    const email = newEmail('test');
    const admin = await seedLocalUser(handle, 'SUPER_ADMIN', { breakGlass: true });
    const { result } = await signInAs(sso, providerId, fake, { sub: newSub(), email, extra: { groups: ['vox'] } }, {}, { testBy: admin.id });
    expect(result).toEqual({ kind: 'tested', providerId });
    expect(await userByEmail(email)).toBeUndefined();
    expect(await db.selectFrom('external_identities').select('id').where('provider_id', '=', providerId).execute()).toHaveLength(0);
    const p = await db.selectFrom('sso_providers').selectAll().where('id', '=', providerId).executeTakeFirstOrThrow();
    expect(p.last_test_ok).toBe(true);
    expect(p.last_test_detail).toMatch(/asks for Administrator.*ceiling is Engineer.*sign in as Engineer/);

    const bad = await signInAs(sso, providerId, fake, { sub: newSub(), email }, { aud: 'x' }, { testBy: admin.id });
    expect(bad.result).toMatchObject({ kind: 'refused', testProviderId: providerId });
    expect((await db.selectFrom('sso_providers').select('last_test_ok').where('id', '=', providerId).executeTakeFirstOrThrow()).last_test_ok).toBe(false);
  });

  it('is not available without being asked for by an administrator: a disabled provider refuses an ordinary sign-in', async () => {
    const providerId = await addOidcProvider(handle, fake, { enabled: false });
    expect((await signInAs(sso, providerId, fake, { sub: newSub(), email: newEmail() })).begun).toEqual({ ok: false, error: 'provider_off' });
  });
});

describe('a federated account', () => {
  it('cannot be used to sign in locally', async () => {
    const fed = await seedFederatedUser(handle, 'SUPER_ADMIN');
    await expect(sso.auth.login(fed.email, PASSWORD, undefined, META)).rejects.toThrow(/Invalid credentials/);
  });
});
