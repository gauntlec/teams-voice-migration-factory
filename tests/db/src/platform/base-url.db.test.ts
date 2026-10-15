// The base URL (Administration > Platform settings): a saved setting wins over WEB_ORIGIN, null goes back to it, the API's live
// config follows a save, and the worker's resolver sees the same value.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetAppSettings, platformDb, webOrigin } from '@tvmf/db';
import { PlatformSettingsService } from '../../../../apps/api/src/platform-ops/platform-settings.service';
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
  forgetAppSettings();
});

describe('base URL setting', () => {
  it('uses WEB_ORIGIN until a Super Admin saves an address, then the saved address everywhere', async () => {
    await platformDb(handle.db).deleteFrom('app_settings').execute();
    forgetAppSettings();
    const svc = new PlatformSettingsService(handle.db, cfg);
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
    const restarted = new PlatformSettingsService(handle.db, { ...cfg, WEB_ORIGIN: 'http://localhost:5173' });
    forgetAppSettings();
    await restarted.onModuleInit();
    expect((await restarted.view()).baseUrl).toBe('https://voice.contoso.local');

    v = await svc.set(null, admin.id);
    expect(v).toMatchObject({ baseUrl: 'http://localhost:5173', source: 'environment' });
    expect(cfg.WEB_ORIGIN).toBe('http://localhost:5173');
    expect(await webOrigin(handle.db, 'http://localhost:5173/')).toBe('http://localhost:5173');
  });

  it('keeps one settings row however often it is saved', async () => {
    const svc = new PlatformSettingsService(handle.db, cfg);
    await svc.set('https://a.example.com', admin.id);
    await svc.set('https://b.example.com', admin.id);
    const rows = await platformDb(handle.db).selectFrom('app_settings').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.base_url).toBe('https://b.example.com');
  });
});

describe('email switch', () => {
  it('stops all email being generated, skips what is already queued, and starts again when switched on', async () => {
    const { MailService } = await import('../../../../apps/api/src/mail/mail.service');
    const { makeMailEnqueuer } = await import('../../../../apps/worker/src/mail/enqueue');
    const added: unknown[] = [];
    const queue = { add: async (...a: unknown[]) => void added.push(a) } as never;
    const mail = new MailService(handle.db, queue);
    const svc = new PlatformSettingsService(handle.db, cfg);
    const count = async () => Number((await platformDb(handle.db).selectFrom('email_messages').select((eb) => eb.fn.countAll<number>().as('n')).where('to_email', '=', 'switch@example.test').executeTakeFirstOrThrow()).n);
    const input = { template: 'user_invitation', to: { email: 'switch@example.test' }, context: {} } as never;

    expect((await svc.view()).emailEnabled).toBe(true);
    await mail.enqueue(input);
    expect(await count()).toBe(1);

    const off = await svc.setEmailEnabled(false, admin.id);
    expect(off.emailEnabled).toBe(false);
    expect(await mail.enqueue(input)).toEqual({ id: null });
    expect(added).toHaveLength(1); // only the first
    expect(await count()).toBe(1); // nothing new written
    // the worker's producer honours it too (it never reaches Redis when off, so a stub connection is enough)
    await makeMailEnqueuer(handle.db, {} as never)({ template: 'user_invitation', to: { email: 'switch@example.test' }, context: {} });
    expect(await count()).toBe(1);
    await expect(mail.resend((await platformDb(handle.db).selectFrom('email_messages').select('id').where('to_email', '=', 'switch@example.test').executeTakeFirstOrThrow()).id)).rejects.toThrow(/switched off/);

    expect((await svc.setEmailEnabled(true, admin.id)).emailEnabled).toBe(true);
    await mail.enqueue(input);
    expect(await count()).toBe(2);
    await platformDb(handle.db).deleteFrom('email_messages').where('to_email', '=', 'switch@example.test').execute();
  });

  it('keeps the saved base URL when only the email switch changes', async () => {
    const svc = new PlatformSettingsService(handle.db, cfg);
    await svc.set('https://keep.example.com', admin.id);
    await svc.setEmailEnabled(false, admin.id);
    expect((await svc.view()).baseUrl).toBe('https://keep.example.com');
    await svc.setEmailEnabled(true, admin.id);
    expect((await svc.view()).baseUrl).toBe('https://keep.example.com');
  });
});
