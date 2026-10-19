// The browser-facing endpoints (docs/SSO.md 4.2): the list for the login page, the redirect to the provider with a state cookie, and the
// callback that starts the same session cookie a password sign-in does. Failures go back to the app with a short code, never a reason.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { SsoAdminController } from '../../../../apps/api/src/sso/sso-admin.controller';
import { SsoAuthController } from '../../../../apps/api/src/sso/sso-auth.controller';
import { startFakeProvider, type FakeProvider } from './fake-provider';
import { addOidcProvider, makeSso, newEmail, newSub, seedLocalUser } from './helpers';
import { useDb, useGlobalSettingsLock, useGlobalSsoLock } from '../helpers';

const handle = useDb();
useGlobalSettingsLock(handle);
useGlobalSsoLock(handle);
const sso = makeSso(handle);
const db = platformDb(handle.db);
const controller = new SsoAuthController(sso.signIn, sso.providers, sso.cfg);
let fake: FakeProvider;
let providerId: string;

interface Cookie { name: string; value: string; opts: Record<string, unknown> }
function fakeRes() {
  const r = { cookies: [] as Cookie[], cleared: [] as { name: string; opts: Record<string, unknown> }[], redirects: [] as { status: number; url: string }[], headers: {} as Record<string, string> };
  const res = {
    cookie: (name: string, value: string, opts: Record<string, unknown>) => void r.cookies.push({ name, value, opts }),
    clearCookie: (name: string, opts: Record<string, unknown>) => void r.cleared.push({ name, opts }),
    redirect: (status: number, url: string) => void r.redirects.push({ status, url }),
    setHeader: (k: string, v: string) => void (r.headers[k] = v),
  };
  return { r, res: res as never };
}
const req = (cookies: Record<string, string> = {}, hostname = 'voxshift.test') => ({ cookies, hostname, ip: '203.0.113.7', headers: { 'user-agent': 'vitest' } }) as never;

beforeAll(async () => {
  await db.deleteFrom('sso_providers').execute();
  fake = await startFakeProvider();
  providerId = await addOidcProvider(handle, fake);
});
afterAll(async () => {
  await fake.close();
  await db.deleteFrom('sso_providers').execute();
});

describe('GET /api/auth/providers', () => {
  it('lists only what the login page needs, only providers that are on, and whether the password form shows', async () => {
    await addOidcProvider(handle, fake, { enabled: false, name: 'Switched off' });
    const { res, r } = fakeRes();
    const list = await controller.list(res);
    expect(list.localPasswords).toBe(true);
    expect(list.providers.every((p) => Object.keys(p).sort().join() === 'id,kind,name')).toBe(true);
    expect(list.providers.map((p) => p.id)).toContain(providerId);
    expect(list.providers.map((p) => p.name)).not.toContain('Switched off');
    expect(r.headers['Cache-Control']).toBe('no-store');
    expect(JSON.stringify(list)).not.toMatch(/secret|issuer|client/i);
  });

  it('says the password form is hidden when an enabled provider turns local passwords off, but not for a provider that is off', async () => {
    const off = await addOidcProvider(handle, fake, { enabled: false, allow_local_passwords: false, name: 'Off, no passwords' });
    expect((await sso.providers.publicList()).localPasswords).toBe(true);
    await db.updateTable('sso_providers').set({ enabled: true }).where('id', '=', off).execute();
    expect((await sso.providers.publicList()).localPasswords).toBe(false);
    await db.deleteFrom('sso_providers').where('id', '=', off).execute();
  });
});

describe('the sign-in round trip over HTTP', () => {
  it('sends the browser to the provider with a short-lived, HttpOnly state cookie scoped to the sign-in path', async () => {
    const { r, res } = fakeRes();
    await controller.login({ provider: providerId, returnTo: '/incidents' }, req(), res);
    const to = new URL(r.redirects[0]!.url);
    expect(r.redirects[0]!.status).toBe(302);
    expect(to.origin + to.pathname).toBe(`${fake.issuer}/authorize`);
    expect(to.searchParams.get('code_challenge_method')).toBe('S256');
    expect(to.searchParams.get('redirect_uri')).toBe('https://voxshift.test/api/auth/oidc/callback');
    const c = r.cookies[0]!;
    expect(c.name).toBe('tvmf_oidc');
    expect(c.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/api/auth/oidc', maxAge: 600_000 });
    expect(c.value).not.toContain(to.searchParams.get('nonce')!.slice(0, 8)); // nothing readable in the cookie value except through its signature check... (a JWT payload is base64)
  });

  it('completes: sets the refresh cookie like a password sign-in, clears the state cookie and lands on the page asked for', async () => {
    const start = fakeRes();
    await controller.login({ provider: providerId, returnTo: '/incidents/9' }, req(), start.res);
    const cb = fake.authorize(start.r.redirects[0]!.url, { sub: newSub(), email: newEmail('http') });
    const end = fakeRes();
    await controller.callback({ code: cb.code, state: cb.state }, req({ tvmf_oidc: start.r.cookies[0]!.value }), end.res);
    expect(end.r.redirects).toEqual([{ status: 302, url: '/incidents/9' }]);
    const refresh = end.r.cookies.find((c) => c.name === 'tvmf_rt')!;
    expect(refresh.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/api/auth' });
    expect(refresh.opts.expires).toBeInstanceOf(Date);
    expect(end.r.cleared.map((c) => c.name)).toContain('tvmf_oidc');
    // the cookie works for the app's own refresh call
    expect((await sso.auth.refresh(refresh.value, { ip: '203.0.113.7' })).accessToken).toBeTruthy();
  });

  it('never redirects off-site, whatever returnTo says', async () => {
    for (const bad of ['https://evil.example.com', '//evil.example.com', 'javascript:alert(1)']) {
      const start = fakeRes();
      await controller.login({ provider: providerId, returnTo: bad }, req(), start.res);
      const cb = fake.authorize(start.r.redirects[0]!.url, { sub: newSub(), email: newEmail('open') });
      const end = fakeRes();
      await controller.callback({ code: cb.code, state: cb.state }, req({ tvmf_oidc: start.r.cookies[0]!.value }), end.res);
      expect(end.r.redirects[0]!.url, bad).toBe('/');
    }
  });

  it('answers a refused sign-in with a short code only, and sets no session', async () => {
    const start = fakeRes();
    await controller.login({ provider: providerId }, req(), start.res);
    const cb = fake.authorize(start.r.redirects[0]!.url, { sub: newSub(), email: newEmail('mfa'), amr: ['pwd'] });
    const end = fakeRes();
    await controller.callback({ code: cb.code, state: cb.state }, req({ tvmf_oidc: start.r.cookies[0]!.value }), end.res);
    expect(end.r.redirects).toEqual([{ status: 302, url: '/?sso_error=mfa_required' }]);
    expect(end.r.cookies.find((c) => c.name === 'tvmf_rt')).toBeUndefined();
    expect(end.r.cleared.map((c) => c.name)).toContain('tvmf_oidc');

    const noCookie = fakeRes();
    await controller.callback({ code: 'x', state: 'y' }, req(), noCookie.res);
    expect(noCookie.r.redirects[0]!.url).toBe('/?sso_error=failed');
    const garbage = fakeRes();
    await controller.callback({ code: ['a', 'b'] as never, state: { x: 1 } as never }, req(), garbage.res);
    expect(garbage.r.redirects[0]!.url).toBe('/?sso_error=failed');
  });

  it('refuses an unknown provider, a malformed one, and a switched-off one', async () => {
    for (const provider of ['00000000-0000-0000-0000-000000000000', 'nonsense', '../../etc', 'hub']) {
      const { r, res } = fakeRes();
      await controller.login({ provider }, req(), res);
      expect(r.redirects[0]!.url, provider).toBe('/?sso_error=provider_off');
      expect(r.cookies).toHaveLength(0);
    }
    const off = await addOidcProvider(handle, fake, { enabled: false });
    const { r, res } = fakeRes();
    await controller.login({ provider: off }, req(), res);
    expect(r.redirects[0]!.url).toBe('/?sso_error=provider_off');
  });

  it('starts "Test sign-in" only with a ticket an administrator was given for that provider, and the ticket is in a cookie, never in the address', async () => {
    const admin = await seedLocalUser(handle, 'SUPER_ADMIN', { breakGlass: true });
    const off = await addOidcProvider(handle, fake, { enabled: false });
    const { url, ticket } = await sso.providers.testStart(off, admin.id);
    expect(url).not.toMatch(/ticket/i);
    expect(url).not.toContain(ticket);

    // The admin route sets the ticket as an HttpOnly cookie scoped to the sign-in path, and returns only the address.
    const adminCtl = new SsoAdminController(sso.providers, sso.cfg);
    const issued = fakeRes();
    const answer = await adminCtl.test(off, { id: admin.id, email: admin.email } as never, issued.res);
    expect(answer).toEqual({ url });
    const issuedCookie = issued.r.cookies.find((c) => c.name === 'tvmf_oidc_test')!;
    expect(issuedCookie.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/api/auth/oidc', maxAge: 120_000 });
    expect(JSON.stringify(answer)).not.toContain(issuedCookie.value);

    // A forged ticket, or one for a different provider, does not make a test: it is an ordinary sign-in, which a switched-off provider refuses.
    const forged = fakeRes();
    await controller.login({ provider: off }, req({ tvmf_oidc_test: ticket.slice(0, -3) + 'abc' }), forged.res);
    expect(forged.r.redirects[0]!.url).toBe('/?sso_error=provider_off');
    const otherProvider = fakeRes();
    await controller.login({ provider: providerId }, req({ tvmf_oidc_test: ticket }), otherProvider.res); // a ticket for a different provider
    expect(new URL(otherProvider.r.redirects[0]!.url).origin).toBe(fake.issuer);
    const otherCb = fake.authorize(otherProvider.r.redirects[0]!.url, { sub: newSub(), email: newEmail('o') });
    const otherEnd = fakeRes();
    await controller.callback({ code: otherCb.code, state: otherCb.state }, req({ tvmf_oidc: otherProvider.r.cookies[0]!.value }), otherEnd.res);
    expect(otherEnd.r.redirects[0]!.url).not.toMatch(/tested=/); // it was not treated as a test

    const start = fakeRes();
    await controller.login({ provider: off }, req({ tvmf_oidc_test: ticket }), start.res);
    expect(new URL(start.r.redirects[0]!.url).origin).toBe(fake.issuer);
    expect(start.r.cleared.map((c) => c.name)).toContain('tvmf_oidc_test'); // used once
    const cb = fake.authorize(start.r.redirects[0]!.url, { sub: newSub(), email: newEmail('t') });
    const end = fakeRes();
    await controller.callback({ code: cb.code, state: cb.state }, req({ tvmf_oidc: start.r.cookies[0]!.value }), end.res);
    expect(end.r.redirects).toEqual([{ status: 302, url: `/admin/settings/sso?tested=${off}` }]);
    expect(end.r.cookies.find((c) => c.name === 'tvmf_rt')).toBeUndefined(); // a test never signs anyone in
  });
});

describe('when something goes wrong in the browser-facing routes', () => {
  it('sends the person back to the login page with the plain message instead of raw JSON when the callback or the start throws', async () => {
    const broken = new SsoAuthController(
      { begin: async () => { throw new Error('boom'); }, complete: async () => { throw new Error('boom'); } } as never,
      { hubProviderId: async () => null } as never,
      sso.cfg,
    );
    const a = fakeRes();
    await expect(broken.callback({ code: 'x', state: 'y' }, req(), a.res)).resolves.toBeUndefined();
    expect(a.r.redirects).toEqual([{ status: 302, url: '/?sso_error=failed' }]);
    expect(a.r.cleared.map((c) => c.name)).toContain('tvmf_oidc');
    const b = fakeRes();
    await expect(broken.login({ provider: providerId }, req(), b.res)).resolves.toBeUndefined();
    expect(b.r.redirects).toEqual([{ status: 302, url: '/?sso_error=failed' }]);
  });
});

describe('the single sign-on throttle', () => {
  it('has its own bucket and, once it is spent, redirects to the login page with a plain message rather than a 429 body', async () => {
    const { SsoRateLimitGuard } = await import('../../../../apps/api/src/sso/sso-rate-limit.guard');
    const { RateLimiterMemory } = await import('rate-limiter-flexible');
    const guard = new SsoRateLimitGuard({} as never);
    (guard as unknown as { limiter: unknown }).limiter = new RateLimiterMemory({ points: 2, duration: 60 });
    const ctx = (r: ReturnType<typeof fakeRes>) => ({ switchToHttp: () => ({ getRequest: () => ({ ip: '198.51.100.9' }), getResponse: () => r.res }) }) as never;

    const ok1 = fakeRes();
    const ok2 = fakeRes();
    const blocked = fakeRes();
    expect(await guard.canActivate(ctx(ok1))).toBe(true);
    expect(await guard.canActivate(ctx(ok2))).toBe(true);
    expect(await guard.canActivate(ctx(blocked))).toBe(false);
    expect(blocked.r.redirects).toEqual([{ status: 302, url: '/?sso_error=rate_limited' }]);
    expect(blocked.r.headers['Cache-Control']).toBe('no-store');
    expect(ok1.r.redirects).toHaveLength(0);
  });

  it('is a different bucket from the password form throttle', async () => {
    const { SsoRateLimitGuard } = await import('../../../../apps/api/src/sso/sso-rate-limit.guard');
    const { LoginRateLimitGuard } = await import('../../../../apps/api/src/auth/login-rate-limit.guard');
    const prefixes: string[] = [];
    for (const G of [SsoRateLimitGuard, LoginRateLimitGuard]) {
      const g = new G({} as never) as unknown as { limiter: { keyPrefix: string } };
      prefixes.push(g.limiter.keyPrefix);
    }
    expect(new Set(prefixes).size).toBe(2);
    expect(prefixes[0]).toBe('sso-rl');
  });
});
