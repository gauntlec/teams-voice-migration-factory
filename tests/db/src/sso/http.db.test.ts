// The real API wiring over real HTTP (Nest app, real guards, real cookie parsing): the public endpoints need no sign-in, the administrator
// API needs sso:manage, and a sign-in round trip sets exactly the cookies and redirects it should. Only Redis is replaced (no rate limit).
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { Global, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { platformDb } from '@tvmf/db';

vi.mock('../../../../apps/api/src/auth/login-rate-limit.guard', async () => {
  const { Injectable } = await import('@nestjs/common');
  class LoginRateLimitGuard {
    canActivate() {
      return true;
    }
  }
  Injectable()(LoginRateLimitGuard);
  return { LoginRateLimitGuard };
});

import { AuditModule } from '../../../../apps/api/src/common/audit.service';
import { ConfigModule } from '../../../../apps/api/src/common/config.module';
import { FeatureGuard } from '../../../../apps/api/src/common/feature.guard';
import { DbModule } from '../../../../apps/api/src/db/db.module';
import { JwtAuthGuard } from '../../../../apps/api/src/auth/jwt-auth.guard';
import { AuthModule } from '../../../../apps/api/src/auth/auth.module';
import { MailModule } from '../../../../apps/api/src/mail/mail.module';
import { MAIL_QUEUE, REDIS_CONNECTION } from '../../../../apps/api/src/queue/queue.module';
import { PermissionsGuard } from '../../../../apps/api/src/rbac/permissions.guard';
import { RbacModule } from '../../../../apps/api/src/rbac/rbac.module';
import { SsoModule } from '../../../../apps/api/src/sso/sso.module';
import { TokenService } from '../../../../apps/api/src/auth/token.service';
import { startFakeProvider, type FakeProvider } from './fake-provider';
import { addOidcProvider, newEmail, newSub, seedLocalUser, TEST_CONFIG } from './helpers';
import { useDb, useGlobalSettingsLock, useGlobalSsoLock } from '../helpers';

const handle = useDb();
useGlobalSettingsLock(handle);
useGlobalSsoLock(handle);
const db = platformDb(handle.db);

// What the queue module would provide, without Redis.
@Global()
@Module({ providers: [{ provide: MAIL_QUEUE, useValue: { add: async () => undefined } }, { provide: REDIS_CONNECTION, useValue: {} }], exports: [MAIL_QUEUE, REDIS_CONNECTION] })
class FakeQueueModule {}

@Module({
  imports: [ConfigModule, DbModule, AuditModule, RbacModule, FakeQueueModule, AuthModule, MailModule, SsoModule],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: FeatureGuard },
  ],
})
class TestRoot {}

let app: NestExpressApplication;
let base: string;
let fake: FakeProvider;
let providerId: string;
let adminToken: string;
let engineerToken: string;

const get = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init });
const cookiesOf = (res: Response) => res.headers.getSetCookie();
const cookieValue = (res: Response, name: string) => cookiesOf(res).find((c) => c.startsWith(`${name}=`))?.split(';')[0]!.slice(name.length + 1);

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', REDIS_URL: 'redis://unused:6379', JWT_ACCESS_SECRET: TEST_CONFIG.JWT_ACCESS_SECRET, JWT_REFRESH_SECRET: TEST_CONFIG.JWT_REFRESH_SECRET,
    DATA_ENCRYPTION_KEY: 'test-data-key', WEB_ORIGIN: 'https://voxshift.test', COOKIE_SECURE: 'false',
  });
  await db.deleteFrom('sso_providers').execute();
  fake = await startFakeProvider();
  providerId = await addOidcProvider(handle, fake, { default_role: 'ENGINEER' });
  app = await NestFactory.create<NestExpressApplication>(TestRoot, { logger: false });
  app.set('trust proxy', 2);
  app.use(cookieParser());
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  const tokens = new TokenService(TEST_CONFIG, handle.db);
  const admin = await seedLocalUser(handle, 'SUPER_ADMIN', { breakGlass: true });
  const engineer = await seedLocalUser(handle, 'ENGINEER');
  adminToken = tokens.signAccess({ sub: admin.id, role: 'SUPER_ADMIN', email: admin.email, typ: 'access' }).token;
  engineerToken = tokens.signAccess({ sub: engineer.id, role: 'ENGINEER', email: engineer.email, typ: 'access' }).token;
});
afterAll(async () => {
  await app?.close();
  await fake?.close();
  await db.deleteFrom('sso_providers').execute();
});

describe('who can call what', () => {
  it('lists providers for the login page without a sign-in', async () => {
    const res = await get('/api/auth/providers');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { providers: { id: string }[]; localPasswords: boolean };
    expect(body.providers.map((p) => p.id)).toContain(providerId);
    expect(body.localPasswords).toBe(true);
  });

  it('keeps the administrator API for Super Admins only', async () => {
    expect((await get('/api/sso/settings')).status).toBe(401);
    expect((await get('/api/sso/settings', { headers: { authorization: `Bearer ${engineerToken}` } })).status).toBe(403);
    const ok = await get('/api/sso/settings', { headers: { authorization: `Bearer ${adminToken}` } });
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text).not.toContain(fake.clientSecret);
    expect(JSON.parse(text).providers.some((p: { id: string; secretSet: boolean }) => p.id === providerId && p.secretSet)).toBe(true);
    for (const [method, path] of [['POST', '/api/sso/providers'], ['PUT', '/api/sso/general'], ['GET', '/api/sso/link-requests']] as const) {
      expect((await get(path, { method, headers: { authorization: `Bearer ${engineerToken}`, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' })).status, path).toBe(403);
    }
  });

  it('validates what an administrator sends', async () => {
    const send = (body: unknown) => get('/api/sso/providers', { method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await send({ name: 'x', issuer: 'http://insecure.example.com', clientId: 'a', clientSecret: 'b' })).status).toBe(400);
    expect((await send({ name: 'x', issuer: fake.issuer, clientId: 'a', clientSecret: 'b', roleCeiling: 'GOD' })).status).toBe(400);
    expect((await get('/api/sso/providers/not-a-uuid', { method: 'PATCH', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(400);
  });
});

describe('a sign-in round trip over HTTP', () => {
  it('redirects to the provider with a state cookie, and back with a refresh cookie that the app can use', async () => {
    const login = await get(`/api/auth/oidc/login?provider=${providerId}&returnTo=${encodeURIComponent('/incidents/7')}`);
    expect(login.status).toBe(302);
    const to = login.headers.get('location')!;
    expect(to.startsWith(`${fake.issuer}/authorize?`)).toBe(true);
    expect(login.headers.get('cache-control')).toBe('no-store');
    const stateCookie = cookiesOf(login).find((c) => c.startsWith('tvmf_oidc='))!;
    expect(stateCookie).toMatch(/HttpOnly/i);
    expect(stateCookie).toMatch(/SameSite=Lax/i);
    expect(stateCookie).toMatch(/Path=\/api\/auth\/oidc/);
    expect(stateCookie).toMatch(/Max-Age=600/);

    const email = newEmail('http');
    const cb = fake.authorize(to, { sub: newSub(), email });
    const back = await get(`/api/auth/oidc/callback?code=${encodeURIComponent(cb.code)}&state=${encodeURIComponent(cb.state)}`, { headers: { cookie: `tvmf_oidc=${cookieValue(login, 'tvmf_oidc')}` } });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/incidents/7');
    const refreshCookie = cookiesOf(back).find((c) => c.startsWith('tvmf_rt='))!;
    expect(refreshCookie).toMatch(/HttpOnly/i);
    expect(refreshCookie).toMatch(/Path=\/api\/auth(;|$)/);
    expect(cookiesOf(back).find((c) => c.startsWith('tvmf_oidc='))).toMatch(/Expires=Thu, 01 Jan 1970/); // cleared

    // the app's own next step: ask for an access token with the refresh cookie, then who am I
    const refreshed = await get('/api/auth/refresh', { method: 'POST', headers: { cookie: `tvmf_rt=${cookieValue(back, 'tvmf_rt')}` } });
    expect(refreshed.status).toBe(201);
    const { accessToken } = (await refreshed.json()) as { accessToken: string };
    const me = await get('/api/auth/me', { headers: { authorization: `Bearer ${accessToken}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email, role: 'ENGINEER', signInMethod: 'sso', totpEnrolled: false });
    // a federated session may use the app without a local authenticator
    expect((await get('/api/users', { headers: { authorization: `Bearer ${accessToken}` } })).status).not.toBe(403); // (not "MFA enrolment required")
  });

  it('sends a refused sign-in back to the app with a short code and no session', async () => {
    const login = await get(`/api/auth/oidc/login?provider=${providerId}`);
    const cb = fake.authorize(login.headers.get('location')!, { sub: newSub(), email: newEmail('mfa'), amr: ['pwd'] });
    const back = await get(`/api/auth/oidc/callback?code=${encodeURIComponent(cb.code)}&state=${encodeURIComponent(cb.state)}`, { headers: { cookie: `tvmf_oidc=${cookieValue(login, 'tvmf_oidc')}` } });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/?sso_error=mfa_required');
    expect(cookiesOf(back).some((c) => c.startsWith('tvmf_rt='))).toBe(false);
  });

  it('refuses a callback without the browser\'s cookie, and an unknown provider', async () => {
    const login = await get(`/api/auth/oidc/login?provider=${providerId}`);
    const cb = fake.authorize(login.headers.get('location')!, { sub: newSub(), email: newEmail('nocookie') });
    const back = await get(`/api/auth/oidc/callback?code=${encodeURIComponent(cb.code)}&state=${encodeURIComponent(cb.state)}`);
    expect(back.headers.get('location')).toBe('/?sso_error=failed');
    const none = await get('/api/auth/oidc/login?provider=00000000-0000-0000-0000-000000000000');
    expect(none.headers.get('location')).toBe('/?sso_error=provider_off');
    expect((await get('/api/auth/oidc/login')).headers.get('location')).toBe('/?sso_error=failed');
  });
});
