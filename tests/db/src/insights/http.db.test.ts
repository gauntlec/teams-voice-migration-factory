// The Insights routes over real HTTP with the real module wiring and guards: the figures, history and a site's go-live date
// answer, and a bad period is refused. Only Redis is replaced.
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { Global, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { AuditModule } from '../../../../apps/api/src/common/audit.service';
import { ConfigModule } from '../../../../apps/api/src/common/config.module';
import { FeatureGuard } from '../../../../apps/api/src/common/feature.guard';
import { DbModule } from '../../../../apps/api/src/db/db.module';
import { JwtAuthGuard } from '../../../../apps/api/src/auth/jwt-auth.guard';
import { AuthModule } from '../../../../apps/api/src/auth/auth.module';
import { MailModule } from '../../../../apps/api/src/mail/mail.module';
import { InsightsModule } from '../../../../apps/api/src/modules/insights/insights.module';
import { DEPLOY_QUEUE, MAIL_QUEUE, REDIS_CONNECTION } from '../../../../apps/api/src/queue/queue.module';
import { PermissionsGuard } from '../../../../apps/api/src/rbac/permissions.guard';
import { RbacModule } from '../../../../apps/api/src/rbac/rbac.module';
import { TokenService } from '../../../../apps/api/src/auth/token.service';
import { seedLocalUser, TEST_CONFIG } from '../sso/helpers';
import { seedCustomer, seedSite, useDb, type TestCustomer } from '../helpers';

const handle = useDb();

@Global()
@Module({
  providers: [
    { provide: MAIL_QUEUE, useValue: { add: async () => undefined } },
    { provide: DEPLOY_QUEUE, useValue: { add: async () => undefined } },
    { provide: REDIS_CONNECTION, useValue: {} },
  ],
  exports: [MAIL_QUEUE, DEPLOY_QUEUE, REDIS_CONNECTION],
})
class FakeQueueModule {}

@Module({
  imports: [ConfigModule, DbModule, AuditModule, RbacModule, FakeQueueModule, AuthModule, MailModule, InsightsModule],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: FeatureGuard },
  ],
})
class TestRoot {}

let app: NestExpressApplication;
let base: string;
let c: TestCustomer;
let siteId: string;
let adminToken: string;
let customerToken: string;

const call = (token: string, path: string, init: RequestInit = {}) =>
  fetch(`${base}/api/t/${c.t.id}/insights${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', REDIS_URL: 'redis://unused:6379', JWT_ACCESS_SECRET: TEST_CONFIG.JWT_ACCESS_SECRET, JWT_REFRESH_SECRET: TEST_CONFIG.JWT_REFRESH_SECRET,
    DATA_ENCRYPTION_KEY: 'test-data-key', WEB_ORIGIN: 'https://voxshift.test', COOKIE_SECURE: 'false',
  });
  c = await seedCustomer(handle, { managedServices: true });
  siteId = (await seedSite(c.s, { sitecode: 'LON01' })).id;
  app = await NestFactory.create<NestExpressApplication>(TestRoot, { logger: false });
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  const tokens = new TokenService(TEST_CONFIG, handle.db);
  const admin = await seedLocalUser(handle, 'SUPER_ADMIN', { breakGlass: true });
  const customer = await seedLocalUser(handle, 'CUSTOMER');
  await platformDb(handle.db).insertInto('tenant_memberships').values({ tenant_id: c.t.id, user_id: customer.id } as never).execute();
  adminToken = tokens.signAccess({ sub: admin.id, role: 'SUPER_ADMIN', email: admin.email, typ: 'access' }).token;
  customerToken = tokens.signAccess({ sub: customer.id, role: 'CUSTOMER', email: customer.email, typ: 'access' }).token;
});

afterAll(async () => {
  await app?.close();
});

describe('Insights over HTTP', () => {
  it('answers the figures and history, and refuses a backwards period', async () => {
    const m = await call(adminToken, '/metrics?from=2026-10-01&to=2026-10-31');
    expect(m.status).toBe(200);
    const body = (await m.json()) as { period: { from: string; to: string }; migration: { sites: number } };
    expect(body.period).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' });
    expect(body.migration.sites).toBe(1);

    expect((await call(adminToken, '/metrics?from=2026-11-02&to=2026-11-01')).status).toBe(400);
    const h = await call(customerToken, '/history');
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual([]);
  });

  it('gives a customer the site’s go-live date, read from its overview', async () => {
    await c.s.updateTable('discovery_sites').set({ overview: JSON.stringify({ targetGoLive: '2026-12-03' }) as never }).where('id', '=', siteId).execute();
    const read = await call(customerToken, `/sites/${siteId}/go-live`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ targetGoLive: '2026-12-03' });
    expect((await call(customerToken, `/sites/${siteId}/go-live`, { method: 'PUT', body: '{}' })).status).toBe(404);
  });
});
