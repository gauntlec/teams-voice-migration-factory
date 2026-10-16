// Optional areas (bug reports, feature requests, MSP features) can be switched off per installation: the setting persists, and the API answers
// "not found" for those controllers while they are off and only those. (The web app's menus follow `disabledFeatures`.)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { disabledFeatures, forgetAppSettings, platformDb } from '@tvmf/db';
import type { AppConfig } from '../../../../apps/api/src/common/config';
import { FeatureGuard } from '../../../../apps/api/src/common/feature.guard';
import { BugReportsController } from '../../../../apps/api/src/bug-reports/bug-reports.controller';
import { FeatureRequestsController } from '../../../../apps/api/src/feature-requests/feature-requests.controller';
import { MailService } from '../../../../apps/api/src/mail/mail.service';
import { MspsController } from '../../../../apps/api/src/msps/msps.controller';
import { MspIncidentsController } from '../../../../apps/api/src/modules/incidents/msp-incidents.controller';
import { MspServiceRequestsController } from '../../../../apps/api/src/modules/service-requests/msp-service-requests.controller';
import { TenantsController } from '../../../../apps/api/src/tenants/tenants.controller';
import { PlatformSettingsService } from '../../../../apps/api/src/platform-ops/platform-settings.service';
import { seedUser, useDb, useGlobalSettingsLock } from '../helpers';

const handle = useDb();
useGlobalSettingsLock(handle);
const cfg = { WEB_ORIGIN: 'http://localhost:5173', REFRESH_COOKIE: 'tvmf_rt' } as AppConfig;
let svc: PlatformSettingsService;
let admin: Awaited<ReturnType<typeof seedUser>>;
let guard: FeatureGuard;

/** Runs the real guard against a route of a controller, the way Nest would. */
async function through(controller: { prototype: object } & (new (...a: never[]) => unknown), handler: string): Promise<'ok' | 'not_found'> {
  const fn = (controller.prototype as Record<string, () => unknown>)[handler]!;
  const ctx = { getHandler: () => fn, getClass: () => controller } as unknown as ExecutionContext;
  try {
    await guard.canActivate(ctx);
    return 'ok';
  } catch (e) {
    if (e instanceof NotFoundException) return 'not_found';
    throw e;
  }
}
const first = (c: { prototype: object }) => Object.getOwnPropertyNames(c.prototype).find((n) => n !== 'constructor')!;

beforeAll(async () => {
  admin = await seedUser(handle, 'SUPER_ADMIN');
  svc = new PlatformSettingsService(handle.db, cfg, new MailService(handle.db, {} as never));
  guard = new FeatureGuard(new Reflector(), handle.db);
});
afterAll(async () => {
  await platformDb(handle.db).deleteFrom('app_settings').execute();
  forgetAppSettings();
});

describe('menus and features', () => {
  it('are all on until something is switched off', async () => {
    await platformDb(handle.db).deleteFrom('app_settings').execute();
    forgetAppSettings();
    expect(await disabledFeatures(handle.db, { fresh: true })).toEqual([]);
    expect((await svc.view()).disabledFeatures).toEqual([]);
    for (const c of [BugReportsController, FeatureRequestsController, MspsController, MspIncidentsController, MspServiceRequestsController]) expect(await through(c, first(c))).toBe('ok');
  });

  it('switch an area off and back on, keeping the other settings', async () => {
    await svc.set('https://voice.contoso.test', admin.id);
    const off = await svc.setDisabledFeatures(['bug_reports', 'feature_requests', 'bug_reports'], admin.id); // a repeat is stored once
    expect(off.disabledFeatures.sort()).toEqual(['bug_reports', 'feature_requests']);
    expect(off.baseUrl).toBe('https://voice.contoso.test'); // nothing else changed
    expect(await disabledFeatures(handle.db)).toEqual(expect.arrayContaining(['bug_reports', 'feature_requests']));
    const back = await svc.setDisabledFeatures([], admin.id);
    expect(back.disabledFeatures).toEqual([]);
  });

  it('make the API of a switched-off area answer "not found", and only that area', async () => {
    await svc.setDisabledFeatures(['bug_reports'], admin.id);
    expect(await through(BugReportsController, first(BugReportsController))).toBe('not_found');
    expect(await through(FeatureRequestsController, first(FeatureRequestsController))).toBe('ok');
    expect(await through(MspsController, first(MspsController))).toBe('ok');

    await svc.setDisabledFeatures(['msp'], admin.id);
    for (const c of [MspsController, MspIncidentsController, MspServiceRequestsController]) expect(await through(c, first(c)), c.name).toBe('not_found');
    expect(await through(BugReportsController, first(BugReportsController))).toBe('ok');
    // an area that was never optional is never blocked, whatever is switched off
    await svc.setDisabledFeatures(['msp', 'bug_reports', 'feature_requests'], admin.id);
    expect(await through(TenantsController, first(TenantsController))).toBe('ok');

    await svc.setDisabledFeatures([], admin.id);
    for (const c of [BugReportsController, MspsController, MspIncidentsController]) expect(await through(c, first(c))).toBe('ok');
  });
});
