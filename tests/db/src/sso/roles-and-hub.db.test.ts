// The Voxshift Hub as a provider, and role ceilings (docs/SSO.md 4.1, 4.3): the hub record follows the hub connection and starts off,
// staff may reach Administrator by default, the customer's own hub people and other providers are capped lower, and the ceiling
// applies at every sign-in.
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { platformDb } from '@tvmf/db';
import type { Role } from '@tvmf/shared';
import { PlatformSettingsService } from '../../../../apps/api/src/platform-ops/platform-settings.service';
import { startFakeProvider, type FakeProvider } from './fake-provider';
import { META, addOidcProvider, hubCredentials, makeSso, newEmail, newSub, signInAs } from './helpers';
import { seedUser, useDb, useGlobalSettingsLock, useGlobalSsoLock } from '../helpers';

const handle = useDb();
useGlobalSettingsLock(handle);
useGlobalSsoLock(handle);
const sso = makeSso(handle);
const db = platformDb(handle.db);
const settings = new PlatformSettingsService(handle.db, sso.cfg, {} as never);
let hub: FakeProvider;
let hubId: string;
let admin: Awaited<ReturnType<typeof seedUser>>;

const reset = async () => {
  await db.deleteFrom('sso_providers').execute();
  await db.deleteFrom('app_settings').execute();
};

beforeAll(async () => {
  await reset();
  admin = await seedUser(handle, 'SUPER_ADMIN');
  hub = await startFakeProvider(hubCredentials());
  await settings.connectHub(hub.issuer, hub.clientSecret, admin.id);
  hubId = (await db.selectFrom('sso_providers').select('id').where('kind', '=', 'hub').executeTakeFirstOrThrow()).id;
});
afterAll(async () => {
  await hub.close();
  await reset();
});

const hubPerson = (role: Role | undefined, kind: string | undefined, extra: Record<string, unknown> = {}) => ({
  sub: newSub(),
  email: newEmail('hub'),
  extra: { ...(role ? { vx_role: role } : {}), ...(kind ? { vx_kind: kind } : {}), sid: 'hub-session-1', ...extra },
});
const roleOf = async (email: string) => (await db.selectFrom('users').select('role').where('email', '=', email).executeTakeFirstOrThrow()).role;

describe('the hub provider record', () => {
  it('is created by the hub connection, with the hub address, the instance id and the token as secret, and starts OFF', async () => {
    const p = await db.selectFrom('sso_providers').selectAll().where('kind', '=', 'hub').executeTakeFirstOrThrow();
    expect(p).toMatchObject({ name: 'Voxshift Hub', issuer: hub.issuer, client_id: hub.clientId, enabled: false, jit_create: true, require_mfa_claim: true, role_ceiling_staff: 'SUPER_ADMIN', role_ceiling_customer: 'ENGINEER' });
    expect(p.client_secret_enc).toBeTruthy();
    expect(p.client_secret_enc).not.toContain(hub.clientSecret);
    const view = (await sso.providers.settings()).providers.find((x) => x.kind === 'hub')!;
    expect(view).toMatchObject({ enabled: false, secretSet: true, hubConnected: true });
    expect(JSON.stringify(view)).not.toContain(hub.clientSecret);
    expect(await sso.providers.publicList()).toMatchObject({ providers: [] }); // off: not on the login page
  });

  it('cannot be used to sign in until an administrator of this installation switches it on', async () => {
    const off = await signInAs(sso, hubId, hub, hubPerson('SUPER_ADMIN', 'staff'));
    expect(off.begun).toEqual({ ok: false, error: 'provider_off' });
    await sso.providers.update(hubId, { enabled: true }, { id: admin.id });
    expect((await sso.providers.publicList()).providers).toEqual([{ id: hubId, name: 'Voxshift Hub', kind: 'hub' }]);
  });

  it('keeps its switch and ceilings when the token is replaced, but switches off and forgets people when the hub address changes', async () => {
    await sso.providers.update(hubId, { enabled: true, roleCeilingStaff: 'ENGINEER' }, { id: admin.id });
    const { result } = await signInAs(sso, hubId, hub, hubPerson('ENGINEER', 'staff'));
    if (result.kind !== 'session') throw new Error('no session');

    // a new token for the same hub (a rotated one): nothing the administrator chose is lost
    const rotated = `vxh_${hub.clientId}_${'ab'.repeat(24)}`;
    await settings.connectHub(hub.issuer, rotated, admin.id);
    const same = await db.selectFrom('sso_providers').selectAll().where('id', '=', hubId).executeTakeFirstOrThrow();
    expect(same).toMatchObject({ enabled: true, role_ceiling_staff: 'ENGINEER', client_id: hub.clientId });
    await settings.connectHub(hub.issuer, hub.clientSecret, admin.id); // back to the one the fake accepts

    // a different hub address is a different provider: off, people forgotten, sessions ended
    await settings.connectHub('http://127.0.0.1:1', `vxh_${hub.clientId}_${'cd'.repeat(24)}`, admin.id);
    const moved = await db.selectFrom('sso_providers').selectAll().where('id', '=', hubId).executeTakeFirstOrThrow();
    expect(moved).toMatchObject({ enabled: false, issuer: 'http://127.0.0.1:1' });
    expect(await db.selectFrom('external_identities').select('id').where('provider_id', '=', hubId).execute()).toHaveLength(0);
    await expect(sso.auth.refresh(result.refreshCookieValue, META)).rejects.toThrow();

    // restore for the other tests
    await settings.connectHub(hub.issuer, hub.clientSecret, admin.id);
    await sso.providers.update(hubId, { enabled: true, roleCeilingStaff: 'SUPER_ADMIN' }, { id: admin.id });
  });

  it('is switched off when the hub is disconnected, and cannot be switched on while there is no hub connection', async () => {
    await settings.disconnectHub(admin.id);
    expect((await db.selectFrom('sso_providers').select('enabled').where('id', '=', hubId).executeTakeFirstOrThrow()).enabled).toBe(false);
    await expect(sso.providers.update(hubId, { enabled: true }, { id: admin.id })).rejects.toThrow(/Connect this installation/);
    await settings.connectHub(hub.issuer, hub.clientSecret, admin.id);
    await sso.providers.update(hubId, { enabled: true }, { id: admin.id });
    // the hub's own fields come from the connection, not from this screen
    await expect(sso.providers.update(hubId, { issuer: 'https://evil.example.com' }, { id: admin.id })).rejects.toThrow(/hub connection/);
    await expect(sso.providers.update(hubId, { clientSecret: 'x' }, { id: admin.id })).rejects.toThrow(/hub connection/);
    await expect(sso.providers.remove(hubId, { id: admin.id })).rejects.toThrow(/follows the hub connection/);
  });
});

describe('the role ceilings', () => {
  it('lets Voxshift staff be administrators by default, and emails the installation\'s administrators when one signs in', async () => {
    await sso.providers.update(hubId, { roleCeilingStaff: 'SUPER_ADMIN', roleCeilingCustomer: 'ENGINEER' }, { id: admin.id });
    sso.mailed.length = 0;
    const p = hubPerson('SUPER_ADMIN', 'staff');
    const { result } = await signInAs(sso, hubId, hub, p);
    expect(result.kind).toBe('session');
    expect(await roleOf(p.email)).toBe('SUPER_ADMIN');
    const mails = sso.mailed.filter((m) => m.template === 'sso_admin_signin');
    expect(mails.length).toBeGreaterThan(0);
    expect(mails.map((m) => m.to.email)).toContain(admin.email);
    expect(mails[0]!.context).toMatchObject({ email: p.email, providerName: 'Voxshift Hub', providerSessionId: 'hub-session-1', ip: META.ip });
    const success = (await db.selectFrom('platform_audit_log').select('detail').where('actor_email', '=', p.email).where('action', '=', 'sso.login.success').executeTakeFirstOrThrow()).detail as Record<string, unknown>;
    expect(success).toMatchObject({ role: 'SUPER_ADMIN', accountKind: 'staff', providerSessionId: 'hub-session-1' });
  });

  it('caps the customer\'s own hub people at Engineer by default, whatever the hub asks for', async () => {
    await sso.providers.update(hubId, { roleCeilingStaff: 'SUPER_ADMIN', roleCeilingCustomer: 'ENGINEER' }, { id: admin.id });
    sso.mailed.length = 0;
    const expected: [Role, Role][] = [['SUPER_ADMIN', 'ENGINEER'], ['PROJECT_MANAGER', 'ENGINEER'], ['ENGINEER', 'ENGINEER'], ['CUSTOMER', 'CUSTOMER']];
    for (const [asked, got] of expected) {
      const p = hubPerson(asked, 'customer');
      expect((await signInAs(sso, hubId, hub, p)).result.kind).toBe('session');
      expect(await roleOf(p.email), `${asked} as customer`).toBe(got);
    }
    expect(sso.mailed.filter((m) => m.template === 'sso_admin_signin')).toHaveLength(0); // nobody signed in as administrator
  });

  it('lets the installation lower the staff ceiling, and a customer administrator raise the customer ceiling', async () => {
    await sso.providers.update(hubId, { roleCeilingStaff: 'ENGINEER', roleCeilingCustomer: 'PROJECT_MANAGER' }, { id: admin.id });
    sso.mailed.length = 0;
    const staff = hubPerson('SUPER_ADMIN', 'staff');
    await signInAs(sso, hubId, hub, staff);
    expect(await roleOf(staff.email)).toBe('ENGINEER');
    expect(sso.mailed.filter((m) => m.template === 'sso_admin_signin')).toHaveLength(0);
    const cust = hubPerson('PROJECT_MANAGER', 'customer');
    await signInAs(sso, hubId, hub, cust);
    expect(await roleOf(cust.email)).toBe('PROJECT_MANAGER');
    await sso.providers.update(hubId, { roleCeilingStaff: 'SUPER_ADMIN', roleCeilingCustomer: 'ENGINEER' }, { id: admin.id });
  });

  it('gives the hub\'s default role (Customer) when it says nothing, and the lower ceiling when it does not say which kind of account', async () => {
    const none = hubPerson(undefined, 'staff');
    await signInAs(sso, hubId, hub, none);
    expect(await roleOf(none.email)).toBe('CUSTOMER');
    const noKind = hubPerson('SUPER_ADMIN', undefined);
    await signInAs(sso, hubId, hub, noKind);
    expect(await roleOf(noKind.email)).toBe('ENGINEER'); // lower of staff (Administrator) and customer (Engineer)
  });

  it('applies a lowered ceiling at the very next sign-in', async () => {
    const p = hubPerson('SUPER_ADMIN', 'staff');
    await signInAs(sso, hubId, hub, { ...p, sub: p.sub });
    expect(await roleOf(p.email)).toBe('SUPER_ADMIN');
    await sso.providers.update(hubId, { roleCeilingStaff: 'PROJECT_MANAGER' }, { id: admin.id });
    await signInAs(sso, hubId, hub, p);
    expect(await roleOf(p.email)).toBe('PROJECT_MANAGER');
    await sso.providers.update(hubId, { roleCeilingStaff: 'SUPER_ADMIN' }, { id: admin.id });
    await signInAs(sso, hubId, hub, p);
    expect(await roleOf(p.email)).toBe('SUPER_ADMIN'); // and back up when the hub still asks for it and the ceiling allows
  });

  it('caps a generic provider at Project manager by default, and reads its own role claim', async () => {
    const idp = await startFakeProvider();
    try {
      const providerId = await addOidcProvider(handle, idp, { role_claim: 'roles', role_map: { Admins: 'SUPER_ADMIN', Engineers: 'ENGINEER' }, role_ceiling: 'PROJECT_MANAGER', default_role: 'CUSTOMER' });
      const roles: [string[] | undefined, Role][] = [[['Admins'], 'PROJECT_MANAGER'], [['Engineers'], 'ENGINEER'], [['Other'], 'CUSTOMER'], [undefined, 'CUSTOMER']];
      for (const [claim, got] of roles) {
        const email = newEmail('oidc');
        await signInAs(sso, providerId, idp, { sub: newSub(), email, extra: claim ? { roles: claim } : {} });
        expect(await roleOf(email), JSON.stringify(claim)).toBe(got);
      }
      // the default ceiling for a generic provider really is Project manager
      expect((await db.selectFrom('sso_providers').select('role_ceiling').where('id', '=', providerId).executeTakeFirstOrThrow()).role_ceiling).toBe('PROJECT_MANAGER');
    } finally {
      await idp.close();
    }
  });

  it('does not email anyone when the notice is switched off, and never lets a mail problem stop a sign-in', async () => {
    const quiet = hubPerson('SUPER_ADMIN', 'staff');
    await sso.providers.setGeneral({ notifyAdminSignin: false }, { id: admin.id });
    sso.mailed.length = 0;
    expect((await signInAs(sso, hubId, hub, quiet)).result.kind).toBe('session');
    expect(sso.mailed).toHaveLength(0);
    await sso.providers.setGeneral({ notifyAdminSignin: true }, { id: admin.id });

    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const failing = makeSso(handle);
    (failing.signIn as unknown as { mail: { enqueue: () => Promise<never> } }).mail = { enqueue: async () => { throw new Error('queue down'); } };
    const loud = hubPerson('SUPER_ADMIN', 'staff');
    expect((await signInAs(failing, hubId, hub, loud)).result.kind).toBe('session');
  });
});

describe('the address the provider sends the browser back to', () => {
  it('is the base URL, or the hub gate address when the request came in on it', async () => {
    const provider = { kind: 'hub' as const };
    expect(await sso.signIn.redirectUriFor(provider, undefined)).toBe('https://voxshift.test/api/auth/oidc/callback');
    // (a real hub address; the provider record keeps pointing at the stand-in)
    await db.updateTable('app_settings').set({ hub_url: 'https://hub.voxshift.io' }).execute();
    try {
      expect(await sso.signIn.redirectUriFor(provider, 'contoso.hub.voxshift.io')).toBe('https://contoso.hub.voxshift.io/api/auth/oidc/callback');
      expect(await sso.signIn.redirectUriFor(provider, 'www.voxshift.io')).toBe('https://voxshift.test/api/auth/oidc/callback');
      expect(await sso.signIn.redirectUriFor(provider, 'evil.example.com')).toBe('https://voxshift.test/api/auth/oidc/callback');
      // only the hub provider ever uses the gate address
      expect(await sso.signIn.redirectUriFor({ kind: 'oidc' }, 'contoso.hub.voxshift.io')).toBe('https://voxshift.test/api/auth/oidc/callback');
    } finally {
      await db.updateTable('app_settings').set({ hub_url: hub.issuer }).execute();
    }
  });

  it('gives a customer-kind hub identity the customer ceiling through the gate address, exactly as through the direct address', async () => {
    await sso.providers.update(hubId, { roleCeilingStaff: 'SUPER_ADMIN', roleCeilingCustomer: 'ENGINEER' }, { id: admin.id });
    // (the stand-in hub is on 127.0.0.1, so its "gate address" is <slug>.127.0.0.1: one label under the host of the hub address)
    const gate = 'contoso.127.0.0.1';
    const gateUri = `https://${gate}/api/auth/oidc/callback`;
    const viaGate = async (p: ReturnType<typeof hubPerson>) => {
      const { begun, result } = await signInAs(sso, hubId, hub, p, {}, { requestHost: gate });
      if (!begun.ok) throw new Error('begin failed');
      expect(new URL(begun.redirectUrl).searchParams.get('redirect_uri')).toBe(gateUri);
      expect(hub.tokenRequests().at(-1)!.body.get('redirect_uri')).toBe(gateUri);
      expect(result.kind).toBe('session');
    };

    const customer = hubPerson('SUPER_ADMIN', 'customer');
    await viaGate(customer);
    expect(await roleOf(customer.email)).toBe('ENGINEER'); // capped by the customer ceiling, not the staff one

    const direct = hubPerson('SUPER_ADMIN', 'customer');
    await signInAs(sso, hubId, hub, direct);
    expect(await roleOf(direct.email)).toBe(await roleOf(customer.email)); // the same as through the direct address

    const staff = hubPerson('SUPER_ADMIN', 'staff');
    await viaGate(staff);
    expect(await roleOf(staff.email)).toBe('SUPER_ADMIN');

    // and the customer ceiling is the one that is re-checked when that session refreshes
    const again = await signInAs(sso, hubId, hub, customer, {}, { requestHost: gate });
    if (again.result.kind !== 'session') throw new Error('no session');
    await sso.providers.update(hubId, { roleCeilingCustomer: 'CUSTOMER' }, { id: admin.id });
    await expect(sso.auth.refresh(again.result.refreshCookieValue, META)).rejects.toThrow(/signed out/i);
    await sso.providers.update(hubId, { roleCeilingCustomer: 'ENGINEER' }, { id: admin.id });
  });

  it('is the one the provider is told in both the authorization request and the code exchange', async () => {
    const begun = await sso.signIn.begin({ providerId: hubId, meta: META });
    if (!begun.ok) throw new Error('begin failed');
    expect(new URL(begun.redirectUrl).searchParams.get('redirect_uri')).toBe('https://voxshift.test/api/auth/oidc/callback');
    const cb = hub.authorize(begun.redirectUrl, hubPerson('ENGINEER', 'staff'));
    await sso.signIn.complete({ ...cb, stateCookie: begun.stateCookie, meta: META });
    expect(hub.tokenRequests().at(-1)!.body.get('redirect_uri')).toBe('https://voxshift.test/api/auth/oidc/callback');
  });
});

