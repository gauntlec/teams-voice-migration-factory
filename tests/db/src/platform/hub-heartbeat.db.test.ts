// The connection to a Voxshift Hub: connecting stores the token encrypted, the worker reports a version and a health word and nothing
// else, a failure is shown in words, and disconnecting stops it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { HUB_TOKEN_RE } from '@tvmf/shared';
import { PlatformSettingsService } from '../../../../apps/api/src/platform-ops/platform-settings.service';
import type { AppConfig } from '../../../../apps/api/src/common/config';
import { hubVersion, sendHubHeartbeat } from '../../../../apps/worker/src/hub-heartbeat';
import { seedUser, useDb } from '../helpers';

const handle = useDb();
const cfg = { WEB_ORIGIN: 'http://localhost:5173', REFRESH_COOKIE: 'tvmf_rt' } as AppConfig;
const TOKEN = `vxh_b04e6c2c-d276-4c12-a477-0554a8b34d20_${'ab12'.repeat(12)}`;
let admin: Awaited<ReturnType<typeof seedUser>>;
let svc: PlatformSettingsService;

interface Call { url: string; headers: Record<string, string>; body: Record<string, unknown> }
const stub = (status = 200, throws?: Error) => {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (throws) throw throws;
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
};

beforeAll(async () => {
  admin = await seedUser(handle, 'SUPER_ADMIN');
  svc = new PlatformSettingsService(handle.db, cfg);
});
afterAll(async () => {
  await platformDb(handle.db).deleteFrom('app_settings').execute();
});

describe('hub connection', () => {
  it('does nothing until a hub is connected', async () => {
    await platformDb(handle.db).deleteFrom('app_settings').execute();
    const { calls, fetchFn } = stub();
    expect(await sendHubHeartbeat(handle.db, { fetchFn })).toBe('skipped');
    expect(calls).toHaveLength(0);
    expect((await svc.view()).hub).toMatchObject({ connected: false, hubUrl: null, tokenHint: null });
  });

  it('stores the token encrypted, never returns it, and reports a version and a health word only', async () => {
    expect(HUB_TOKEN_RE.test(TOKEN)).toBe(true);
    const v = await svc.connectHub('https://hub.voxshift.io', TOKEN, admin.id);
    expect(v.hub).toMatchObject({ connected: true, hubUrl: 'https://hub.voxshift.io', tokenHint: '…ab12', lastOkAt: null, lastError: null });
    expect(JSON.stringify(v)).not.toContain(TOKEN);
    const row = await platformDb(handle.db).selectFrom('app_settings').selectAll().executeTakeFirstOrThrow();
    expect(row.hub_token_enc).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(TOKEN.slice(-24)); // not in the row anywhere in the clear

    const { calls, fetchFn } = stub();
    expect(await sendHubHeartbeat(handle.db, { fetchFn, now: new Date('2026-10-15T12:00:00Z') })).toBe('sent');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://hub.voxshift.io/api/v1/heartbeat');
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // the whole of what leaves this installation:
    expect(Object.keys(calls[0]!.body).sort()).toEqual(['health', 'uptimeSeconds', 'version']);
    expect(calls[0]!.body.version).toBe(hubVersion());
    expect(calls[0]!.body.health).toBe('ok');
    expect((await svc.view()).hub).toMatchObject({ lastOkAt: '2026-10-15T12:00:00.000Z', lastError: null });
  });

  it('shows why a report failed, in words, without ever including the token', async () => {
    const wrong = stub(401);
    expect(await sendHubHeartbeat(handle.db, { fetchFn: wrong.fetchFn })).toBe('failed');
    let hub = (await svc.view()).hub;
    expect(hub.lastError).toMatch(/does not accept this token/);
    expect(hub.lastOkAt).toBe('2026-10-15T12:00:00.000Z'); // the earlier success is kept

    const off = stub(403);
    await sendHubHeartbeat(handle.db, { fetchFn: off.fetchFn });
    expect((await svc.view()).hub.lastError).toMatch(/switched off in the hub/);

    const down = stub(200, new Error('getaddrinfo ENOTFOUND hub.voxshift.io'));
    await sendHubHeartbeat(handle.db, { fetchFn: down.fetchFn });
    hub = (await svc.view()).hub;
    expect(hub.lastError).toMatch(/Could not reach the hub/);
    expect(JSON.stringify(hub)).not.toContain(TOKEN);

    // and it recovers by itself
    expect(await sendHubHeartbeat(handle.db, { fetchFn: stub().fetchFn })).toBe('sent');
    expect((await svc.view()).hub.lastError).toBeNull();
  });

  it('stops reporting when disconnected, and keeps the base URL and email switch untouched', async () => {
    await svc.set('https://voice.contoso.local', admin.id);
    await svc.setEmailEnabled(false, admin.id);
    const v = await svc.disconnectHub(admin.id);
    expect(v.hub).toMatchObject({ connected: false, hubUrl: null, tokenHint: null, lastOkAt: null });
    expect(v.baseUrl).toBe('https://voice.contoso.local');
    expect(v.emailEnabled).toBe(false);
    const { calls, fetchFn } = stub();
    expect(await sendHubHeartbeat(handle.db, { fetchFn })).toBe('skipped');
    expect(calls).toHaveLength(0);
    await svc.setEmailEnabled(true, admin.id);
  });

  it('keeps the hub connection when only the base URL changes', async () => {
    await svc.connectHub('https://hub.voxshift.io', TOKEN, admin.id);
    await svc.set('https://other.contoso.local', admin.id);
    expect((await svc.view()).hub.connected).toBe(true);
    await svc.disconnectHub(admin.id);
  });
});
