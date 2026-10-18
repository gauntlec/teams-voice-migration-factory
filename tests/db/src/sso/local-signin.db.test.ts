// Single sign-on and the local sign-in form (docs/SSO.md 4.2, 4.4, 4.6): a provider can switch local passwords off, break-glass
// administrators keep them, and an account that exists only through a provider has no password to try.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { localPasswordsAllowed, platformDb } from '@tvmf/db';
import { PASSWORD, makeAuth, seedFederatedUser, seedLocalUser } from './helpers';
import { useDb, useGlobalSettingsLock, useGlobalSsoLock } from '../helpers';

const handle = useDb();
useGlobalSettingsLock(handle);
useGlobalSsoLock(handle);
const { auth } = makeAuth(handle);
const db = platformDb(handle.db);
const meta = { ip: '203.0.113.5', userAgent: 'vitest' };

async function addProvider(opts: { enabled: boolean; allowLocalPasswords: boolean }) {
  const name = `Provider ${randomUUID().slice(0, 8)}`;
  return db
    .insertInto('sso_providers')
    .values({ kind: 'oidc', name, issuer: 'https://idp.test', client_id: 'x', enabled: opts.enabled, allow_local_passwords: opts.allowLocalPasswords })
    .returning('id')
    .executeTakeFirstOrThrow();
}

afterAll(async () => {
  await db.deleteFrom('sso_providers').execute();
});

describe('local passwords and single sign-on', () => {
  it('allows local passwords until an ENABLED provider switches them off', async () => {
    await db.deleteFrom('sso_providers').execute();
    expect(await localPasswordsAllowed(handle.db)).toBe(true);
    await addProvider({ enabled: false, allowLocalPasswords: false });
    expect(await localPasswordsAllowed(handle.db)).toBe(true); // a provider that is off cannot lock anyone out
    await addProvider({ enabled: true, allowLocalPasswords: true });
    expect(await localPasswordsAllowed(handle.db)).toBe(true);
    await addProvider({ enabled: true, allowLocalPasswords: false });
    expect(await localPasswordsAllowed(handle.db)).toBe(false);
  });

  it('refuses a password sign-in for an ordinary user once local passwords are off, but not for a break-glass administrator', async () => {
    await db.deleteFrom('sso_providers').execute();
    const engineer = await seedLocalUser(handle, 'ENGINEER');
    const breakGlass = await seedLocalUser(handle, 'SUPER_ADMIN', { breakGlass: true });
    const notBreakGlass = await seedLocalUser(handle, 'SUPER_ADMIN', { breakGlass: false });

    // Before: everyone can sign in with password and authenticator.
    const before = await auth.login(engineer.email, PASSWORD, engineer.code(), meta);
    expect('accessToken' in before && before.enrolRequired === false).toBe(true);

    await addProvider({ enabled: true, allowLocalPasswords: false });

    await expect(auth.login(engineer.email, PASSWORD, engineer.code(), meta)).rejects.toThrow(/switched off/);
    await expect(auth.login(notBreakGlass.email, PASSWORD, notBreakGlass.code(), meta)).rejects.toThrow(/switched off/);
    const ok = await auth.login(breakGlass.email, PASSWORD, breakGlass.code(), meta);
    expect('accessToken' in ok && ok.enrolRequired === false).toBe(true);

    // The refusal does not reveal anything about a wrong password: that still looks like any bad password.
    await expect(auth.login(engineer.email, 'not the password', undefined, meta)).rejects.toThrow(/Invalid credentials/);
    const log = await db.selectFrom('platform_audit_log').select('detail').where('actor_email', '=', engineer.email).where('action', '=', 'auth.login.failed').execute();
    expect(log.some((r) => (r.detail as { reason?: string }).reason === 'local-passwords-off')).toBe(true);
  });

  it('gives an account that exists only through a provider no password to try', async () => {
    await db.deleteFrom('sso_providers').execute();
    const fed = await seedFederatedUser(handle, 'ENGINEER');
    for (const guess of [PASSWORD, '!federated', '', 'x'.repeat(40)]) {
      await expect(auth.login(fed.email, guess, undefined, meta)).rejects.toThrow(/Invalid credentials/);
    }
    const log = await db.selectFrom('platform_audit_log').select('detail').where('actor_email', '=', fed.email).execute();
    expect(log.some((r) => (r.detail as { reason?: string }).reason === 'federated-account')).toBe(true);
  });
});
