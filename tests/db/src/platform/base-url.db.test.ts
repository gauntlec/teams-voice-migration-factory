// The base URL (Administration > Web address): a saved setting wins over WEB_ORIGIN, null goes back to it, the API's live
// config follows a save, and the worker's resolver sees the same value.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetBaseUrl, platformDb, webOrigin } from '@tvmf/db';
import { BaseUrlService } from '../../../../apps/api/src/platform-ops/base-url.service';
import type { AppConfig } from '../../../../apps/api/src/common/config';
import { seedUser, useDb } from '../helpers';

const handle = useDb();
let admin: Awaited<ReturnType<typeof seedUser>>;
const cfg = { WEB_ORIGIN: 'http://localhost:5173/', REFRESH_COOKIE: 'tvmf_rt' } as AppConfig;

beforeAll(async () => {
  admin = await seedUser(handle, 'SUPER_ADMIN');
});
afterAll(async () => {
  await platformDb(handle.db).deleteFrom('app_settings').execute();
  forgetBaseUrl();
});

describe('base URL setting', () => {
  it('uses WEB_ORIGIN until a Super Admin saves an address, then the saved address everywhere', async () => {
    await platformDb(handle.db).deleteFrom('app_settings').execute();
    forgetBaseUrl();
    const svc = new BaseUrlService(handle.db, cfg);
    await svc.onModuleInit();
    let v = await svc.view();
    expect(v).toMatchObject({ baseUrl: 'http://localhost:5173', source: 'environment' });
    expect(cfg.WEB_ORIGIN).toBe('http://localhost:5173');

    v = await svc.set('https://voice.contoso.local', admin.id);
    expect(v).toMatchObject({ baseUrl: 'https://voice.contoso.local', source: 'setting', environmentValue: 'http://localhost:5173' });
    expect(v.connect.agentApi).toBe('https://voice.contoso.local/api/agent/v1');
    expect(cfg.WEB_ORIGIN).toBe('https://voice.contoso.local'); // the API's link builders read this
    expect(await webOrigin(handle.db, 'http://ignored')).toBe('https://voice.contoso.local'); // and so does the worker

    // A new API process starts from the saved value.
    const restarted = new BaseUrlService(handle.db, { ...cfg, WEB_ORIGIN: 'http://localhost:5173' });
    forgetBaseUrl();
    await restarted.onModuleInit();
    expect((await restarted.view()).baseUrl).toBe('https://voice.contoso.local');

    v = await svc.set(null, admin.id);
    expect(v).toMatchObject({ baseUrl: 'http://localhost:5173', source: 'environment' });
    expect(cfg.WEB_ORIGIN).toBe('http://localhost:5173');
    expect(await webOrigin(handle.db, 'http://localhost:5173/')).toBe('http://localhost:5173');
  });

  it('keeps one settings row however often it is saved', async () => {
    const svc = new BaseUrlService(handle.db, cfg);
    await svc.set('https://a.example.com', admin.id);
    await svc.set('https://b.example.com', admin.id);
    const rows = await platformDb(handle.db).selectFrom('app_settings').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.base_url).toBe('https://b.example.com');
  });
});
