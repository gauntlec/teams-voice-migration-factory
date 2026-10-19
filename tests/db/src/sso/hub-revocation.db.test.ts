// The hub's revocation channel (docs/SSO.md 4.7 and 5.3): the reply to the heartbeat names people whose access ended, the worker signs them out
// here (even an access token they already hold), records it in the audit log, and acknowledges the highest line. Older hubs and older
// installations keep working; break-glass and local sign-ins are never touched.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySsoRevocations, hubRevocationAck, platformDb, setHubRevocationAck } from '@tvmf/db';
import { parseHubRevocations } from '@tvmf/shared';
import { PlatformSettingsService } from '../../../../apps/api/src/platform-ops/platform-settings.service';
import { JwtAuthGuard } from '../../../../apps/api/src/auth/jwt-auth.guard';
import { resetHubRevocationSupport, sendHubHeartbeat } from '../../../../apps/worker/src/hub-heartbeat';
import { startFakeProvider, type FakeProvider } from './fake-provider';
import { META, PASSWORD, hubCredentials, makeSso, newEmail, newSub, seedLocalUser, signInAs } from './helpers';
import { seedUser, useDb, useGlobalSettingsLock, useGlobalSsoLock } from '../helpers';

const handle = useDb();
useGlobalSettingsLock(handle);
useGlobalSsoLock(handle);
const sso = makeSso(handle);
const db = platformDb(handle.db);
const settings = new PlatformSettingsService(handle.db, sso.cfg, {} as never);
const guard = new JwtAuthGuard({ getAllAndOverride: () => false } as never, sso.tokens, handle.db);
let hub: FakeProvider;
let hubId: string;
let admin: Awaited<ReturnType<typeof seedUser>>;

beforeAll(async () => {
  await db.deleteFrom('sso_providers').execute();
  await db.deleteFrom('app_settings').execute();
  admin = await seedUser(handle, 'SUPER_ADMIN');
  hub = await startFakeProvider(hubCredentials());
  await settings.connectHub(hub.issuer, hub.clientSecret, admin.id);
  hubId = (await db.selectFrom('sso_providers').select('id').where('kind', '=', 'hub').executeTakeFirstOrThrow()).id;
  await sso.providers.update(hubId, { enabled: true }, { id: admin.id });
});
afterAll(async () => {
  await hub.close();
  await db.deleteFrom('sso_providers').execute();
  await db.deleteFrom('app_settings').execute();
});
beforeEach(async () => {
  resetHubRevocationSupport();
  await setHubRevocationAck(handle.db, 0);
});

/** A hub person signs in (as the hub's ID token would say) and holds a working access token. */
async function signInHub(kind: 'staff' | 'customer' = 'staff', role = 'ENGINEER') {
  const sub = newSub();
  const email = newEmail('hub');
  const { result } = await signInAs(sso, hubId, hub, { sub, email, extra: { vx_role: role, vx_kind: kind, sid: 'hub-session-1' } });
  if (result.kind !== 'session') throw new Error(`no session: ${JSON.stringify(result)}`);
  const refreshed = await sso.auth.refresh(result.refreshCookieValue, META);
  const user = await db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirstOrThrow();
  return { sub, email, user, cookie: refreshed.refreshCookieValue, access: refreshed.accessToken };
}
const tokenWorks = async (access: string) => {
  const req = { headers: { authorization: `Bearer ${access}` } };
  try {
    return await guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }), getHandler: () => null, getClass: () => null } as never);
  } catch {
    return false;
  }
};
const refreshWorks = (cookie: string) => sso.auth.refresh(cookie, META).then(() => true, () => false);
const line = (id: number, sub: string, reason: string, before = new Date(Date.now() + 1000)) => ({ id, sub, reason, before: before.toISOString() });
const revokedAudit = async (userId: string) => (await db.selectFrom('platform_audit_log').selectAll().where('action', '=', 'sso.revoked').where('target_id', '=', userId).orderBy('at').execute()).map((r) => r.detail as Record<string, unknown>);

interface Call { url: string; body: Record<string, unknown> }
/** The hub, as the worker sees it: every report is recorded, the answers are what the test says. */
function stubHub(answer: (call: Call, n: number) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: { body: string }) => {
    const call = { url, body: JSON.parse(init.body) as Record<string, unknown> };
    calls.push(call);
    const a = answer(call, calls.length);
    const status = a.status ?? 200;
    return { ok: status < 300, status, json: async () => a.json ?? { ok: true } } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe('the heartbeat carries the acknowledgement and applies what the hub says', () => {
  it('signs the person out (even an access token they hold), writes the audit entry, and acknowledges the highest line', async () => {
    const jo = await signInHub();
    expect(await tokenWorks(jo.access)).toBe(true);
    const hubSays = stubHub(() => ({ json: { ok: true, ssoRevocations: [{ id: 41, sub: jo.sub, before: new Date(Date.now() + 500).toISOString(), reason: 'sessions_revoked' }] } }));
    expect(await sendHubHeartbeat(handle.db, { fetchFn: hubSays.fetchFn })).toBe('sent');
    expect(hubSays.calls[0]!.body.ssoRevocationsAck).toBe(0); // first report: "I understand revocations, I have applied none"

    expect(await tokenWorks(jo.access)).toBe(false); // at once, not at the next 15-minute refresh
    expect(await refreshWorks(jo.cookie)).toBe(false);
    const audit = await revokedAudit(jo.user.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ reason: 'hub-session-revoked', source: 'hub', subject: jo.sub, sessionsEnded: 1, accountDisabled: false, identityRemoved: false, hubLine: 41 });
    expect(JSON.stringify(audit[0])).not.toMatch(/eyJ|secret/);

    expect(await hubRevocationAck(handle.db)).toBe(41);
    const next = stubHub(() => ({}));
    await sendHubHeartbeat(handle.db, { fetchFn: next.fetchFn });
    expect(next.calls[0]!.body.ssoRevocationsAck).toBe(41); // the next report says what has been applied
  });

  it('keeps the person able to sign in again (the hub vouches for them when they have access): the cut-off only ends older sign-ins', async () => {
    const jo = await signInHub();
    await sendHubHeartbeat(handle.db, { fetchFn: stubHub(() => ({ json: { ssoRevocations: [line(50, jo.sub, 'user_disabled', new Date())] } })).fetchFn });
    expect(await tokenWorks(jo.access)).toBe(false);
    expect((await db.selectFrom('users').select('status').where('id', '=', jo.user.id).executeTakeFirstOrThrow()).status).toBe('active'); // the hub will not vouch for them while disabled; nothing more is needed here
    await new Promise((r) => setTimeout(r, 1100)); // tokens carry whole seconds
    const again = await signInAs(sso, hubId, hub, { sub: jo.sub, email: jo.email, extra: { vx_role: 'ENGINEER', vx_kind: 'staff' } });
    if (again.result.kind !== 'session') throw new Error('could not sign in again');
    const fresh = await sso.auth.refresh(again.result.refreshCookieValue, META);
    expect(await tokenWorks(fresh.accessToken)).toBe(true);
  });

  it('works whether or not remote access (the tunnel) is on', async () => {
    for (const remote of [false, true]) {
      await db.updateTable('app_settings').set({ hub_remote_access: remote }).execute();
      const jo = await signInHub();
      await sendHubHeartbeat(handle.db, { fetchFn: stubHub(() => ({ json: { ssoRevocations: [line(60, jo.sub, 'sessions_revoked')] } })).fetchFn });
      expect(await tokenWorks(jo.access)).toBe(false);
    }
    await db.updateTable('app_settings').set({ hub_remote_access: false }).execute();
  });

  it('a reply without ssoRevocations (an older hub) or an empty one changes nothing and leaves the acknowledgement alone', async () => {
    const jo = await signInHub();
    await setHubRevocationAck(handle.db, 7);
    for (const json of [{ ok: true }, { ok: true, ssoRevocations: [] }, { ok: true, ssoRevocations: 'nonsense' }]) {
      await sendHubHeartbeat(handle.db, { fetchFn: stubHub(() => ({ json })).fetchFn });
    }
    expect(await tokenWorks(jo.access)).toBe(true);
    expect(await hubRevocationAck(handle.db)).toBe(7);
  });
});

describe('what each reason does', () => {
  it('grant removed: an account that exists only through the hub is switched off, its sessions ended, and the person is told apart in the audit log', async () => {
    const jo = await signInHub('staff', 'SUPER_ADMIN');
    await applySsoRevocations(handle.db, [line(70, jo.sub, 'grant_removed', new Date())] as never);
    expect((await db.selectFrom('users').select('status').where('id', '=', jo.user.id).executeTakeFirstOrThrow()).status).toBe('disabled');
    expect(await tokenWorks(jo.access)).toBe(false);
    expect(await refreshWorks(jo.cookie)).toBe(false);
    expect((await revokedAudit(jo.user.id))[0]).toMatchObject({ reason: 'hub-grant-removed', accountDisabled: true, identityRemoved: false });
    // and the hub provider will refuse them if they come back before an administrator has switched the account on again
    const back = await signInAs(sso, hubId, hub, { sub: jo.sub, email: jo.email, extra: { vx_role: 'SUPER_ADMIN', vx_kind: 'staff' } });
    expect(back.result).toEqual({ kind: 'refused', error: 'disabled' });
  });

  it('grant removed: a local account that was linked to the hub (it has its own password) is unlinked and otherwise left alone', async () => {
    const local = await seedLocalUser(handle, 'ENGINEER');
    const sub = newSub();
    await db.insertInto('external_identities').values({ user_id: local.id, provider_id: hubId, subject: sub, email: local.email, account_kind: 'staff', created_at: new Date().toISOString() }).execute();
    await applySsoRevocations(handle.db, [line(71, sub, 'grant_removed', new Date())] as never);
    expect(await db.selectFrom('external_identities').select('id').where('subject', '=', sub).execute()).toHaveLength(0);
    expect((await db.selectFrom('users').select('status').where('id', '=', local.id).executeTakeFirstOrThrow()).status).toBe('active');
    const signedIn = await sso.auth.login(local.email, PASSWORD, local.code(), META);
    expect('accessToken' in signedIn && !!signedIn.accessToken).toBe(true);
    expect((await revokedAudit(local.id))[0]).toMatchObject({ reason: 'hub-grant-removed', accountDisabled: false, identityRemoved: true });
  });

  it('disabled at the hub, sessions revoked, role changed: sessions end and nothing else is touched', async () => {
    for (const reason of ['user_disabled', 'sessions_revoked', 'role_changed']) {
      const jo = await signInHub();
      await applySsoRevocations(handle.db, [line(80, jo.sub, reason, new Date())] as never);
      expect(await tokenWorks(jo.access)).toBe(false);
      expect(await refreshWorks(jo.cookie)).toBe(false);
      expect((await db.selectFrom('users').select('status').where('id', '=', jo.user.id).executeTakeFirstOrThrow()).status).toBe('active');
      expect(await db.selectFrom('external_identities').select('id').where('subject', '=', jo.sub).execute()).toHaveLength(1);
      expect((await revokedAudit(jo.user.id))[0]).toMatchObject({ reason: { user_disabled: 'hub-user-disabled', sessions_revoked: 'hub-session-revoked', role_changed: 'hub-role-changed' }[reason] });
    }
  });

  it('only sign-ins that began before the line end: a later one, and a sign-in through another provider, are untouched', async () => {
    const jo = await signInHub();
    await applySsoRevocations(handle.db, [line(90, jo.sub, 'sessions_revoked', new Date(Date.now() - 3_600_000))] as never); // an hour ago: Jo signed in after
    expect(await tokenWorks(jo.access)).toBe(true);
    expect(await refreshWorks(jo.cookie)).toBe(true);
  });

  it('a person who signed in again since a grant was removed (access was given back) keeps the account', async () => {
    const jo = await signInHub();
    await applySsoRevocations(handle.db, [line(95, jo.sub, 'grant_removed', new Date(Date.now() - 3_600_000))] as never); // replayed old line
    expect((await db.selectFrom('users').select('status').where('id', '=', jo.user.id).executeTakeFirstOrThrow()).status).toBe('active');
    expect(await tokenWorks(jo.access)).toBe(true);
  });
});

describe('safe to repeat, and safe against nonsense', () => {
  it('applying the same line twice does the same as once (one audit entry)', async () => {
    const jo = await signInHub();
    const l = line(100, jo.sub, 'grant_removed', new Date(Date.now() + 1000));
    await applySsoRevocations(handle.db, [l] as never);
    await applySsoRevocations(handle.db, [l] as never);
    expect(await revokedAudit(jo.user.id)).toHaveLength(1);
  });

  it('a person this installation has never seen changes nothing, and the line is still acknowledged', async () => {
    const jo = await signInHub();
    const hubSays = stubHub(() => ({ json: { ssoRevocations: [line(110, 'nobody-here', 'grant_removed')] } }));
    await sendHubHeartbeat(handle.db, { fetchFn: hubSays.fetchFn });
    expect(await tokenWorks(jo.access)).toBe(true);
    expect(await hubRevocationAck(handle.db)).toBe(110);
  });

  it('a break-glass administrator is never touched, even if a line names a subject that somehow points at one', async () => {
    const bg = await seedLocalUser(handle, 'SUPER_ADMIN', { breakGlass: true });
    const sub = newSub();
    await db.insertInto('external_identities').values({ user_id: bg.id, provider_id: hubId, subject: sub, email: bg.email, created_at: new Date().toISOString() }).execute();
    const signedIn = await sso.auth.login(bg.email, PASSWORD, bg.code(), META);
    const cookie = 'refreshCookieValue' in signedIn ? signedIn.refreshCookieValue : '';
    await applySsoRevocations(handle.db, [line(120, sub, 'grant_removed', new Date())] as never);
    expect((await db.selectFrom('users').select('status').where('id', '=', bg.id).executeTakeFirstOrThrow()).status).toBe('active');
    expect(await refreshWorks(cookie)).toBe(true); // their local session goes on
    expect(await revokedAudit(bg.id)).toHaveLength(0);
  });

  it('a local password sign-in by the same person is not a hub sign-in and is not ended', async () => {
    const local = await seedLocalUser(handle, 'ENGINEER');
    const sub = newSub();
    await db.insertInto('external_identities').values({ user_id: local.id, provider_id: hubId, subject: sub, email: local.email, account_kind: 'staff', created_at: new Date().toISOString() }).execute();
    const signedIn = await sso.auth.login(local.email, PASSWORD, local.code(), META);
    const cookie = 'refreshCookieValue' in signedIn ? signedIn.refreshCookieValue : '';
    await applySsoRevocations(handle.db, [line(125, sub, 'sessions_revoked', new Date())] as never);
    expect(await refreshWorks(cookie)).toBe(true);
  });

  it('a time far in the future is cut back, so it cannot lock a person out for years', async () => {
    const jo = await signInHub();
    await applySsoRevocations(handle.db, [line(130, jo.sub, 'sessions_revoked', new Date('2100-01-01T00:00:00Z'))] as never);
    const id = await db.selectFrom('external_identities').select('revoked_before').where('subject', '=', jo.sub).executeTakeFirstOrThrow();
    expect(new Date(id.revoked_before!).getTime()).toBeLessThan(Date.now() + 120_000);
  });

  it('lines that are not well formed are dropped; the good ones still apply and the acknowledgement covers them all', () => {
    const parsed = parseHubRevocations({
      ssoRevocations: [
        { id: 1, sub: 'a', before: '2026-10-19T10:00:00Z', reason: 'grant_removed' },
        { id: 2, sub: '', before: '2026-10-19T10:00:00Z', reason: 'grant_removed' },
        { id: 3, sub: 'b', before: 'not a date', reason: 'grant_removed' },
        { id: 'x', sub: 'c', before: '2026-10-19T10:00:00Z', reason: 'grant_removed' },
        { id: 5, sub: 'd', before: '2026-10-19T10:00:00Z', reason: 'something_new' },
      ],
    });
    expect(parsed.lines.map((l) => [l.id, l.sub, l.reason])).toEqual([[1, 'a', 'grant_removed'], [5, 'd', 'sessions_revoked']]); // an unknown reason is read the safe way
    expect(parsed.maxId).toBe(5);
    expect(parseHubRevocations(null)).toEqual({ lines: [], maxId: 0 });
    expect(parseHubRevocations({})).toEqual({ lines: [], maxId: 0 });
  });
});

describe('older hubs and a changed hub', () => {
  it('a hub that refuses the new field (400) gets the report again without it, then is left alone for an hour; the report still works', async () => {
    const hubSays = stubHub((call) => ('ssoRevocationsAck' in call.body ? { status: 400, json: { error: 'invalid' } } : { json: { ok: true } }));
    expect(await sendHubHeartbeat(handle.db, { fetchFn: hubSays.fetchFn })).toBe('sent');
    expect(hubSays.calls.map((c) => 'ssoRevocationsAck' in c.body)).toEqual([true, false]);
    expect(await sendHubHeartbeat(handle.db, { fetchFn: hubSays.fetchFn })).toBe('sent');
    expect(hubSays.calls.map((c) => 'ssoRevocationsAck' in c.body)).toEqual([true, false, false]); // not asked again straight away
    expect(Object.keys(hubSays.calls[2]!.body).sort()).toEqual(['health', 'remoteAccess', 'sso', 'uptimeSeconds', 'version']);
    // an hour later it tries again (the hub may have been updated)
    expect(await sendHubHeartbeat(handle.db, { fetchFn: hubSays.fetchFn, now: new Date(Date.now() + 61 * 60_000) })).toBe('sent');
    expect('ssoRevocationsAck' in hubSays.calls[3]!.body).toBe(true);
  });

  it('a report refused for another reason is not blamed on the new field', async () => {
    const hubSays = stubHub(() => ({ status: 400 }));
    expect(await sendHubHeartbeat(handle.db, { fetchFn: hubSays.fetchFn })).toBe('failed');
    const later = stubHub(() => ({}));
    await sendHubHeartbeat(handle.db, { fetchFn: later.fetchFn });
    expect('ssoRevocationsAck' in later.calls[0]!.body).toBe(true);
  });

  it('is not sent at all when there is no hub sign-in provider record here', async () => {
    const keep = await db.selectFrom('sso_providers').selectAll().where('id', '=', hubId).executeTakeFirstOrThrow();
    await db.deleteFrom('sso_providers').where('id', '=', hubId).execute();
    const hubSays = stubHub(() => ({}));
    await sendHubHeartbeat(handle.db, { fetchFn: hubSays.fetchFn });
    expect('ssoRevocationsAck' in hubSays.calls[0]!.body).toBe(false);
    await db.insertInto('sso_providers').values({ ...keep, role_map: JSON.stringify(keep.role_map) } as never).execute();
  });

  it('forgets the acknowledgement when the installation is pointed at a different hub (its lines are numbered from the start)', async () => {
    await setHubRevocationAck(handle.db, 55);
    await settings.connectHub(hub.issuer, `vxh_${hub.clientId}_${'ab'.repeat(24)}`, admin.id); // a new token for the same hub: kept
    expect(await hubRevocationAck(handle.db)).toBe(55);
    await settings.connectHub('http://127.0.0.1:1', `vxh_${hub.clientId}_${'cd'.repeat(24)}`, admin.id);
    expect(await hubRevocationAck(handle.db)).toBe(0);
    await settings.connectHub(hub.issuer, hub.clientSecret, admin.id);
    await sso.providers.update(hubId, { enabled: true }, { id: admin.id });
  });
});

describe('an identity that is removed ends access at once', () => {
  it('unlinking a person stops the access token they hold immediately, not at the next refresh', async () => {
    const jo = await signInHub();
    const identity = await db.selectFrom('external_identities').select('id').where('subject', '=', jo.sub).executeTakeFirstOrThrow();
    await sso.providers.unlink(identity.id, { id: admin.id });
    expect(await tokenWorks(jo.access)).toBe(false);
  });
});
