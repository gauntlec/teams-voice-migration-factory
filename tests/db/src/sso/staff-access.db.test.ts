// Customer-approved, time-limited access for Voxshift hub staff accounts (docs/SSO.md 4.3a): "Allowed" changes nothing, "Off" refuses staff,
// "Needs approval" holds the sign-in until an administrator of this installation says yes for a time they choose; the session and the
// access end exactly then. The customer's own people, local accounts and break-glass administrators are never affected.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { platformDb, sweepStaffAccess } from '@tvmf/db';
import { approveStaffAccessSchema } from '@tvmf/shared';
import { PlatformSettingsService } from '../../../../apps/api/src/platform-ops/platform-settings.service';
import { JwtAuthGuard } from '../../../../apps/api/src/auth/jwt-auth.guard';
import { SsoAdminController } from '../../../../apps/api/src/sso/sso-admin.controller';
import { SsoAuthController } from '../../../../apps/api/src/sso/sso-auth.controller';
import { renderEmail } from '../../../../apps/worker/src/mail/templates';
import { startFakeProvider, type FakeProvider } from './fake-provider';
import { META, PASSWORD, addOidcProvider, hubCredentials, makeSso, newEmail, newSub, seedLocalUser, signInAs } from './helpers';
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
let owner: Awaited<ReturnType<typeof seedLocalUser>>; // the customer's own administrator, signed in with a password
let other: Awaited<ReturnType<typeof seedUser>>;

const setMode = (mode: 'allowed' | 'needs_approval' | 'off', actor: { id: string; idp?: string } = { id: owner.id }) => sso.providers.update(hubId, { staffAccess: mode }, actor);

beforeAll(async () => {
  await db.deleteFrom('sso_providers').execute();
  await db.deleteFrom('app_settings').execute();
  other = await seedUser(handle, 'SUPER_ADMIN');
  owner = await seedLocalUser(handle, 'SUPER_ADMIN', { breakGlass: true });
  hub = await startFakeProvider(hubCredentials());
  await settings.connectHub(hub.issuer, hub.clientSecret, other.id);
  hubId = (await db.selectFrom('sso_providers').select('id').where('kind', '=', 'hub').executeTakeFirstOrThrow()).id;
  await sso.providers.update(hubId, { enabled: true }, { id: other.id });
});
afterAll(async () => {
  await hub.close();
  await db.deleteFrom('sso_providers').execute();
  await db.deleteFrom('app_settings').execute();
});
beforeEach(async () => {
  await setMode('allowed');
  await db.deleteFrom('sso_access_requests').execute();
  sso.mailed.length = 0;
});

const staff = (extra: Record<string, unknown> = {}) => ({ sub: newSub(), email: newEmail('staff'), name: 'Sam Staff', extra: { vx_role: 'SUPER_ADMIN', vx_kind: 'staff', sid: 'hub-session-7', ...extra } });
const customer = () => ({ sub: newSub(), email: newEmail('cust'), name: 'Cora Customer', extra: { vx_role: 'ENGINEER', vx_kind: 'customer', sid: 'hub-session-8' } });
const hubSignIn = async (person: ReturnType<typeof staff>) => (await signInAs(sso, hubId, hub, person)).result;
const guardOk = async (access: string) => {
  const req = { headers: { authorization: `Bearer ${access}` } };
  try {
    return await guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }), getHandler: () => null, getClass: () => null } as never);
  } catch {
    return false;
  }
};
const sessionOf = async (cookie: string) => {
  const [id] = cookie.split('.');
  return db.selectFrom('auth_sessions').selectAll().where('id', '=', id!).executeTakeFirstOrThrow();
};
const audit = async (action: string, email?: string) => {
  const rows = await db.selectFrom('platform_audit_log').selectAll().where('action', '=', action).orderBy('at').execute();
  return rows.filter((r) => !email || JSON.stringify(r.detail).includes(email) || r.actor_email === email).map((r) => r.detail as Record<string, unknown>);
};
const requestOf = (email: string) => db.selectFrom('sso_access_requests').selectAll().where('email', '=', email).orderBy('requested_at', 'desc').executeTakeFirstOrThrow();
const soon = (ms: number) => new Date(Date.now() + ms).toISOString();

/** A staff person signs in under "needs approval", an administrator approves for `hours`, and the waiting browser collects the session. */
async function approvedSession(person = staff(), hours = 4) {
  await setMode('needs_approval');
  const r = await hubSignIn(person);
  if (r.kind !== 'waiting') throw new Error(`expected waiting, got ${r.kind}`);
  const req = await requestOf(person.email);
  await sso.staffAccess.approve(req.id, hours, { id: owner.id });
  const claimed = await sso.signIn.claimApproved({ waitToken: r.waitToken, meta: META });
  if (claimed.kind !== 'session') throw new Error('no session after approval');
  const refreshed = await sso.auth.refresh(claimed.refreshCookieValue, META);
  return { person, req, waitToken: r.waitToken, cookie: refreshed.refreshCookieValue, access: refreshed.accessToken };
}

describe('allowed (the default): nothing changes', () => {
  it('a staff sign-in gets its session at once, as before, and no request is made', async () => {
    expect((await db.selectFrom('sso_providers').select('staff_access').where('id', '=', hubId).executeTakeFirstOrThrow()).staff_access).toBe('allowed');
    const r = await hubSignIn(staff());
    expect(r.kind).toBe('session');
    expect(await db.selectFrom('sso_access_requests').select('id').execute()).toHaveLength(0);
    if (r.kind !== 'session') return;
    const hours = (new Date((await sessionOf(r.refreshCookieValue)).absolute_expires_at!).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9); // the ordinary 12-hour cap
  });
});

describe('off: staff are refused', () => {
  it('refuses a staff sign-in, creates no account, and says so in the audit log; the customer\'s own people and a missing kind rule', async () => {
    await setMode('off');
    const p = staff();
    expect(await hubSignIn(p)).toEqual({ kind: 'refused', error: 'staff_off' });
    expect(await db.selectFrom('users').select('id').where('email', '=', p.email).execute()).toHaveLength(0);
    expect((await audit('sso.login.refused', p.email)).map((d) => d.reason)).toContain('staff_access_off');
    // the hub says nothing about the kind: treated as staff (the stricter reading)
    const unknownKind = { sub: newSub(), email: newEmail('nokind'), extra: { vx_role: 'ENGINEER' } };
    expect(await hubSignIn(unknownKind as never)).toEqual({ kind: 'refused', error: 'staff_off' });
    // the customer's own person signs in as before
    expect((await hubSignIn(customer() as never)).kind).toBe('session');
  });
});

describe('needs approval: the request', () => {
  it('holds the sign-in: no session, a pending request, the local administrators emailed (and nobody who signs in through the hub)', async () => {
    await setMode('needs_approval');
    const hubAdminSub = newSub();
    const hubAdmin = await hubSignInAllowed(hubAdminSub);
    const p = staff();
    const r = await hubSignIn(p);
    expect(r.kind).toBe('waiting');
    if (r.kind !== 'waiting') return;
    expect(r.waitToken.length).toBeGreaterThan(30);

    const user = await db.selectFrom('users').selectAll().where('email', '=', p.email).executeTakeFirstOrThrow();
    expect(await db.selectFrom('auth_sessions').select('id').where('user_id', '=', user.id).execute()).toHaveLength(0); // no session
    const req = await requestOf(p.email);
    expect(req).toMatchObject({ status: 'pending', requested_role: 'SUPER_ADMIN', effective_role: 'SUPER_ADMIN', provider_session: 'hub-session-7', ip: META.ip, user_id: user.id });
    expect(req.wait_token_hash).not.toContain(r.waitToken); // only a hash
    expect(new Date(req.request_expires_at).getTime() - Date.now()).toBeGreaterThan(59 * 60_000);

    expect((await audit('sso.access.requested', p.email))[0]).toMatchObject({ requestId: req.id, requestedRole: 'SUPER_ADMIN', role: 'SUPER_ADMIN', providerSessionId: 'hub-session-7' });
    const recipients = sso.mailed.filter((m) => m.template === 'sso_staff_access_request').map((m) => m.to.email);
    expect(recipients).toContain(owner.email);
    expect(recipients).not.toContain(hubAdmin.email); // a hub person cannot decide, so is not asked
    expect(sso.mailed.find((m) => m.to.email === owner.email && m.template === 'sso_staff_access_request')!.context).toMatchObject({ email: p.email, role: 'Administrator', reviewUrl: 'https://voxshift.test/admin/settings/sso' });

    // the waiting page: pending for the browser that asked, nothing for anyone else
    expect(await sso.staffAccess.waitStatus(r.waitToken)).toMatchObject({ state: 'pending' });
    expect(await sso.staffAccess.waitStatus('someone-elses-token')).toMatchObject({ state: 'unknown' });
    expect(await sso.staffAccess.waitStatus(undefined)).toMatchObject({ state: 'unknown' });
    // and no session can be collected yet
    expect((await sso.signIn.claimApproved({ waitToken: r.waitToken, meta: META })).kind).toBe('refused');
  });

  it('asking again while waiting keeps the same request and sends no second email', async () => {
    await setMode('needs_approval');
    const p = staff();
    await hubSignIn(p);
    const again = await hubSignIn({ ...p, sub: p.sub });
    expect(again.kind).toBe('waiting');
    expect(await db.selectFrom('sso_access_requests').select('id').where('email', '=', p.email).execute()).toHaveLength(1);
    expect(sso.mailed.filter((m) => m.template === 'sso_staff_access_request' && m.to.email === owner.email)).toHaveLength(1);
  });

  it('is shown the role the ceiling allows, next to the role the hub asked for', async () => {
    await setMode('needs_approval');
    await sso.providers.update(hubId, { roleCeilingStaff: 'ENGINEER' }, { id: owner.id });
    const p = staff();
    await hubSignIn(p);
    expect(await requestOf(p.email)).toMatchObject({ requested_role: 'SUPER_ADMIN', effective_role: 'ENGINEER' });
    await sso.providers.update(hubId, { roleCeilingStaff: 'SUPER_ADMIN' }, { id: owner.id });
  });

  it('does not touch the customer\'s own people, other providers, or local accounts', async () => {
    await setMode('needs_approval');
    expect((await hubSignIn(customer() as never)).kind).toBe('session');
    const fake = await startFakeProvider();
    const oidc = await addOidcProvider(handle, fake, { default_role: 'ENGINEER' });
    expect((await signInAs(sso, oidc, fake, { sub: newSub(), email: newEmail('own') })).result.kind).toBe('session');
    await db.deleteFrom('sso_providers').where('id', '=', oidc).execute();
    await fake.close();
    const login = await sso.auth.login(owner.email, PASSWORD, owner.code(), META);
    expect('accessToken' in login).toBe(true);
    expect(await db.selectFrom('sso_access_requests').select('id').execute()).toHaveLength(0);
  });
});

/** A hub staff person with a session, signed in while the rule was still "allowed". */
async function hubSignInAllowed(sub: string) {
  await setMode('allowed');
  const email = newEmail('hubadmin');
  const r = await signInAs(sso, hubId, hub, { sub, email, extra: { vx_role: 'SUPER_ADMIN', vx_kind: 'staff' } });
  expect(r.result.kind).toBe('session');
  await setMode('needs_approval');
  return { email };
}

describe('the email the administrators get', () => {
  it('says who, which role, from where, how long it can be allowed for, and where to answer; and that a hub sign-in cannot answer', () => {
    const mail = renderEmail('sso_staff_access_request', { displayName: 'Sam Staff', email: 'sam@msp.test', role: 'Administrator', at: '2026-10-19 13:00:00 UTC', ip: '203.0.113.9', installation: 'https://voxshift.test', reviewUrl: 'https://voxshift.test/admin/settings/sso' });
    expect(mail.subject).toBe('Approval needed: Sam Staff is asking to sign in');
    for (const part of ['Sam Staff', 'sam@msp.test', 'Administrator', '203.0.113.9', '4 hours', '24', 'https://voxshift.test/admin/settings/sso', 'not through the Voxshift Hub']) expect(mail.text).toContain(part);
    expect(mail.html).toContain('https://voxshift.test/admin/settings/sso');
  });
});

describe('needs approval: approving', () => {
  it('lets the waiting browser collect a session once; it ends with the window, and so does the access', async () => {
    const a = await approvedSession(staff(), 4);
    expect((await audit('sso.access.approved', a.person.email))[0]).toMatchObject({ requestId: a.req.id, windowHours: 4, role: 'SUPER_ADMIN' });
    const row = await requestOf(a.person.email);
    expect(row).toMatchObject({ status: 'approved', window_hours: 4, decided_by: owner.id });
    expect(row.claimed_at).not.toBeNull();
    const end = new Date(row.window_ends_at!).getTime();
    expect(end - Date.now()).toBeGreaterThan(3.9 * 3_600_000);
    expect(end - Date.now()).toBeLessThanOrEqual(4 * 3_600_000);

    const session = await sessionOf(a.cookie);
    expect(new Date(session.absolute_expires_at!).getTime()).toBe(end); // the session ends with the window, not at the 12-hour cap
    expect(new Date(session.expires_at).getTime()).toBeLessThanOrEqual(end);
    const identity = await db.selectFrom('external_identities').select('access_until').where('subject', '=', a.person.sub).executeTakeFirstOrThrow();
    expect(new Date(identity.access_until!).getTime()).toBe(end);
    expect(await guardOk(a.access)).toBe(true);
    expect((await audit('sso.login.success', a.person.email)).at(-1)).toMatchObject({ accessRequestId: a.req.id, role: 'SUPER_ADMIN' });

    // the waiting page has nothing left to do, and the same approval cannot be used twice
    expect((await sso.staffAccess.waitStatus(a.waitToken)).state).toBe('unknown');
    expect((await sso.signIn.claimApproved({ waitToken: a.waitToken, meta: META })).kind).toBe('refused');
  });

  it('the time limit applies to the federated session cap too: a 1-hour cap beats a 4-hour window', async () => {
    await sso.providers.setGeneral({ sessionMaxHours: 1 }, { id: owner.id });
    try {
      const a = await approvedSession(staff(), 4);
      const session = await sessionOf(a.cookie);
      const hours = (new Date(session.absolute_expires_at!).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(0.9);
      expect(hours).toBeLessThanOrEqual(1);
    } finally {
      await sso.providers.setGeneral({ sessionMaxHours: 12 }, { id: owner.id });
    }
  });

  it('the default is 4 hours and the most is 24', () => {
    expect(approveStaffAccessSchema.parse({}).hours).toBe(4);
    expect(approveStaffAccessSchema.safeParse({ hours: 24 }).success).toBe(true);
    for (const bad of [0, 25, 1.5, -1, '4']) expect(approveStaffAccessSchema.safeParse({ hours: bad }).success).toBe(false);
  });

  it('a second sign-in inside a running window needs no new request, and ends with the same window', async () => {
    const a = await approvedSession(staff(), 2);
    const again = await signInAs(sso, hubId, hub, a.person);
    expect(again.result.kind).toBe('session');
    if (again.result.kind !== 'session') return;
    const row = await requestOf(a.person.email);
    expect(new Date((await sessionOf(again.result.refreshCookieValue)).absolute_expires_at!).getTime()).toBe(new Date(row.window_ends_at!).getTime());
    expect(await db.selectFrom('sso_access_requests').select('id').where('email', '=', a.person.email).execute()).toHaveLength(1);
  });

  it('only a pending request can be approved, and only once', async () => {
    const a = await approvedSession();
    await expect(sso.staffAccess.approve(a.req.id, 4, { id: owner.id })).rejects.toThrow(/already been approved/);
  });

  it('collects nothing if things changed meanwhile: the person switched off, or the rule changed', async () => {
    await setMode('needs_approval');
    const p = staff();
    const r = await hubSignIn(p);
    if (r.kind !== 'waiting') throw new Error('expected waiting');
    const req = await requestOf(p.email);
    await sso.staffAccess.approve(req.id, 4, { id: owner.id });
    await db.updateTable('users').set({ status: 'disabled' }).where('id', '=', req.user_id).execute();
    expect((await sso.signIn.claimApproved({ waitToken: r.waitToken, meta: META })).kind).toBe('refused');
    await db.updateTable('users').set({ status: 'active' }).where('id', '=', req.user_id).execute();
  });
});

describe('needs approval: the window ends', () => {
  it('exactly when it says: the access token stops at that moment (before any sweep), then the sweep closes it and says so', async () => {
    const a = await approvedSession();
    expect(await guardOk(a.access)).toBe(true);
    // time passes: the window's end is now in the past
    await db.updateTable('sso_access_requests').set({ window_ends_at: soon(-1000) }).where('id', '=', a.req.id).execute();
    await db.updateTable('external_identities').set({ access_until: soon(-1000) }).where('subject', '=', a.person.sub).execute();
    expect(await guardOk(a.access)).toBe(false); // already out: the guard needs no sweep

    const swept = await sweepStaffAccess(handle.db);
    expect(swept.windowsExpired).toBe(1);
    expect((await requestOf(a.person.email)).status).toBe('expired');
    expect((await audit('sso.access.expired', a.person.email))[0]).toMatchObject({ stage: 'window', requestId: a.req.id, signedIn: true });
    await expect(sso.auth.refresh(a.cookie, META)).rejects.toThrow();
    expect((await sweepStaffAccess(handle.db)).windowsExpired).toBe(0); // once

    // a new request is needed
    const next = await hubSignIn(a.person);
    expect(next.kind).toBe('waiting');
    expect(await db.selectFrom('sso_access_requests').select('id').where('email', '=', a.person.email).execute()).toHaveLength(2);
  });

  it('a refresh after the end says so (audit reason access-window-ended) even before the sweep has run', async () => {
    const a = await approvedSession();
    await db.updateTable('sso_access_requests').set({ window_ends_at: soon(-1000) }).where('id', '=', a.req.id).execute();
    await db.updateTable('external_identities').set({ access_until: soon(-1000) }).where('subject', '=', a.person.sub).execute();
    await db.updateTable('auth_sessions').set({ absolute_expires_at: soon(3_600_000) }).where('user_id', '=', a.req.user_id).execute(); // as if the cap alone would allow it
    await expect(sso.auth.refresh(a.cookie, META)).rejects.toThrow(/signed out/);
    expect((await audit('sso.revoked')).some((d) => d.reason === 'access-window-ended')).toBe(true);
  });

  it('an administrator can end it early: the person is out at once and has to ask again', async () => {
    const a = await approvedSession();
    await sso.staffAccess.end(a.req.id, { id: owner.id });
    expect(await guardOk(a.access)).toBe(false);
    await expect(sso.auth.refresh(a.cookie, META)).rejects.toThrow();
    expect(await requestOf(a.person.email)).toMatchObject({ status: 'ended', ended_by: owner.id });
    expect((await audit('sso.access.ended', a.person.email))[0]).toMatchObject({ requestId: a.req.id, reason: 'ended early by an administrator', sessionsEnded: 1 });
    expect((await hubSignIn(a.person)).kind).toBe('waiting');
    await expect(sso.staffAccess.end(a.req.id, { id: owner.id })).rejects.toThrow(/not running/);
  });

  it('a request nobody answers lapses after the hour, and is audited', async () => {
    await setMode('needs_approval');
    const p = staff();
    const r = await hubSignIn(p);
    if (r.kind !== 'waiting') throw new Error('expected waiting');
    await db.updateTable('sso_access_requests').set({ request_expires_at: soon(-1000) }).where('email', '=', p.email).execute();
    expect((await sso.staffAccess.waitStatus(r.waitToken)).state).toBe('expired');
    expect((await audit('sso.access.expired', p.email))[0]).toMatchObject({ stage: 'request' });
    await expect(sso.staffAccess.approve((await requestOf(p.email)).id, 4, { id: owner.id })).rejects.toThrow(/no longer be approved/);
  });
});

describe('needs approval: denying', () => {
  it('shows the denial to the waiting browser, audits it, and does not let the person turn it into a stream of emails', async () => {
    await setMode('needs_approval');
    const p = staff();
    const r = await hubSignIn(p);
    if (r.kind !== 'waiting') throw new Error('expected waiting');
    const req = await requestOf(p.email);
    await sso.staffAccess.deny(req.id, 'not expected today', { id: owner.id });
    expect((await audit('sso.access.denied', p.email))[0]).toMatchObject({ requestId: req.id, note: 'not expected today' });
    expect((await sso.staffAccess.waitStatus(r.waitToken)).state).toBe('denied');
    expect((await sso.signIn.claimApproved({ waitToken: r.waitToken, meta: META })).kind).toBe('refused');
    const mails = sso.mailed.length;

    const again = await hubSignIn(p); // immediately again
    expect(again.kind).toBe('waiting');
    if (again.kind !== 'waiting') return;
    expect((await sso.staffAccess.waitStatus(again.waitToken)).state).toBe('denied'); // shown the denial again
    expect(await db.selectFrom('sso_access_requests').select('id').where('email', '=', p.email).execute()).toHaveLength(1);
    expect(sso.mailed.length).toBe(mails);

    // after the cool-down a new request is made
    await db.updateTable('sso_access_requests').set({ decided_at: soon(-11 * 60_000) }).where('id', '=', req.id).execute();
    const later = await hubSignIn(p);
    expect(later.kind).toBe('waiting');
    expect(await db.selectFrom('sso_access_requests').select('id').where('email', '=', p.email).execute()).toHaveLength(2);
    expect((await requestOf(p.email)).status).toBe('pending');
  });
});

describe('who may decide, and who may loosen the rule', () => {
  it('a person who came in through the Voxshift Hub cannot approve, deny or end anything', async () => {
    await setMode('needs_approval');
    const p = staff();
    await hubSignIn(p);
    const req = await requestOf(p.email);
    const asHub = { id: other.id, idp: hubId };
    await expect(sso.staffAccess.approve(req.id, 4, asHub)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(sso.staffAccess.deny(req.id, undefined, asHub)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await requestOf(p.email)).status).toBe('pending');
    // someone signed in through the customer's own provider, or locally, can
    await sso.staffAccess.approve(req.id, 1, { id: owner.id, idp: 'some-other-provider' });
    await expect(sso.staffAccess.end(req.id, asHub)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('through the hub an administrator may tighten the rule but not loosen it', async () => {
    const asHub = { id: other.id, idp: hubId };
    await setMode('needs_approval', asHub); // allowed -> needs approval: fine
    await setMode('off', asHub); // tighter still: fine
    await expect(setMode('needs_approval', asHub)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(setMode('allowed', asHub)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await sso.providers.settings()).providers.find((x) => x.kind === 'hub')!.staffAccess).toBe('off');
    await setMode('allowed'); // the customer's own administrator can
  });

  it('is a setting of the hub provider only', async () => {
    const fake = await startFakeProvider();
    const oidc = await addOidcProvider(handle, fake);
    await expect(sso.providers.update(oidc, { staffAccess: 'off' }, { id: owner.id })).rejects.toThrow(/Voxshift Hub only/);
    await db.deleteFrom('sso_providers').where('id', '=', oidc).execute();
    await fake.close();
  });
});

describe('changing the rule takes hold at once', () => {
  it('to needs approval or off: staff who were in are signed out (the customer\'s own people are not); changes are audited', async () => {
    const sam = await signInAs(sso, hubId, hub, staff());
    const cora = await signInAs(sso, hubId, hub, customer() as never);
    if (sam.result.kind !== 'session' || cora.result.kind !== 'session') throw new Error('expected sessions');
    const samTokens = await sso.auth.refresh(sam.result.refreshCookieValue, META);
    const coraTokens = await sso.auth.refresh(cora.result.refreshCookieValue, META);
    await setMode('needs_approval');
    expect(await guardOk(samTokens.accessToken)).toBe(false);
    await expect(sso.auth.refresh(samTokens.refreshCookieValue, META)).rejects.toThrow();
    expect(await guardOk(coraTokens.accessToken)).toBe(true);
    expect((await audit('sso.revoked')).some((d) => d.reason === 'staff-access-restricted')).toBe(true);
    expect((await audit('sso.provider.changed')).some((d) => JSON.stringify(d).includes('staffAccess'))).toBe(true);
  });

  it('to off: waiting requests and running windows are closed, and the people on them signed out', async () => {
    const a = await approvedSession();
    const waiting = staff();
    await hubSignIn(waiting);
    await setMode('off');
    expect(await guardOk(a.access)).toBe(false);
    expect((await requestOf(a.person.email)).status).toBe('cancelled');
    expect((await requestOf(waiting.email)).status).toBe('cancelled');
    expect((await sso.staffAccess.overview())).toMatchObject({ mode: 'off', pending: [], windows: [] });
    expect((await audit('sso.access.ended', a.person.email))[0]).toMatchObject({ newMode: 'off' });
  });

  it('back to allowed: nothing waits, no window limits anyone, and staff sign in as before', async () => {
    const a = await approvedSession();
    await setMode('allowed');
    const identity = await db.selectFrom('external_identities').select('access_until').where('subject', '=', a.person.sub).executeTakeFirstOrThrow();
    expect(identity.access_until).toBeNull();
    expect((await requestOf(a.person.email)).status).toBe('cancelled');
    const r = await signInAs(sso, hubId, hub, a.person);
    expect(r.result.kind).toBe('session');
    if (r.result.kind !== 'session') return;
    const fresh = await sso.auth.refresh(r.result.refreshCookieValue, META);
    expect(await guardOk(fresh.accessToken)).toBe(true);
  });
});

describe('break-glass and local sign-in are never affected', () => {
  it('a break-glass administrator signs in with password and authenticator whatever the rule', async () => {
    for (const mode of ['needs_approval', 'off', 'allowed'] as const) {
      await setMode(mode);
      const login = await sso.auth.login(owner.email, PASSWORD, owner.code(), META);
      expect('accessToken' in login && !!login.accessToken, mode).toBe(true);
    }
  });

  it('an identity that points at a break-glass account is still refused, and no request is made for it', async () => {
    const bg = await seedLocalUser(handle, 'SUPER_ADMIN', { breakGlass: true });
    const sub = newSub();
    await db.insertInto('external_identities').values({ user_id: bg.id, provider_id: hubId, subject: sub, email: bg.email, account_kind: 'staff' }).execute();
    await setMode('needs_approval');
    const r = await signInAs(sso, hubId, hub, { sub, email: bg.email, extra: { vx_role: 'SUPER_ADMIN', vx_kind: 'staff' } });
    expect(r.result).toEqual({ kind: 'refused', error: 'local_only' });
    expect(await db.selectFrom('sso_access_requests').select('id').execute()).toHaveLength(0);
    await db.deleteFrom('external_identities').where('subject', '=', sub).execute();
  });

  it('the staff rule is never applied to a local account, even one linked to the hub (it has its own password)', async () => {
    const local = await seedLocalUser(handle, 'ENGINEER');
    await setMode('needs_approval');
    const login = await sso.auth.login(local.email, PASSWORD, local.code(), META);
    expect('accessToken' in login).toBe(true);
  });
});

describe('over HTTP', () => {
  const controller = new SsoAuthController(sso.signIn, sso.providers, sso.staffAccess, sso.cfg);
  const req = (cookies: Record<string, string> = {}) => ({ cookies, hostname: 'voxshift.test', ip: '203.0.113.7', headers: { 'user-agent': 'vitest' } }) as never;
  const fakeRes = () => {
    const r = { cookies: [] as { name: string; value: string; opts: Record<string, any> }[], cleared: [] as string[], redirects: [] as { status: number; url: string }[], headers: {} as Record<string, string> };
    const res = { cookie: (name: string, value: string, opts: Record<string, any>) => void r.cookies.push({ name, value, opts }), clearCookie: (name: string) => void r.cleared.push(name), redirect: (status: number, url: string) => void r.redirects.push({ status, url }), setHeader: (k: string, v: string) => void (r.headers[k] = v) };
    return { r, res: res as never };
  };

  it('the callback sends a staff sign-in to the waiting page with a wait cookie (HttpOnly, its own path) and no session cookie; the page then collects the session once', async () => {
    await setMode('needs_approval');
    const start = fakeRes();
    await controller.login({ provider: hubId, returnTo: '/incidents' }, req(), start.res);
    const p = staff();
    const cb = hub.authorize(start.r.redirects[0]!.url, p);
    const end = fakeRes();
    await controller.callback({ code: cb.code, state: cb.state }, req({ tvmf_oidc: start.r.cookies[0]!.value }), end.res);
    expect(end.r.redirects).toEqual([{ status: 302, url: '/sso/waiting' }]);
    expect(end.r.cookies.find((c) => c.name === 'tvmf_rt')).toBeUndefined();
    const wait = end.r.cookies.find((c) => c.name === 'tvmf_staff_wait')!;
    expect(wait.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/api/auth/staff-access', maxAge: 3_600_000 });

    const s1 = fakeRes();
    expect(await controller.waitStatus(req({ tvmf_staff_wait: wait.value }), s1.res)).toMatchObject({ state: 'pending' });
    expect(s1.r.headers['Cache-Control']).toBe('no-store');
    const early = fakeRes();
    expect(await controller.waitContinue(req({ tvmf_staff_wait: wait.value }), early.res)).toEqual({ ok: false });
    expect(early.r.cookies).toHaveLength(0);

    await sso.staffAccess.approve((await requestOf(p.email)).id, 4, { id: owner.id });
    expect(await controller.waitStatus(req({ tvmf_staff_wait: wait.value }), fakeRes().res)).toMatchObject({ state: 'approved' });
    const go = fakeRes();
    expect(await controller.waitContinue(req({ tvmf_staff_wait: wait.value }), go.res)).toEqual({ ok: true, redirectTo: '/incidents' });
    const refresh = go.r.cookies.find((c) => c.name === 'tvmf_rt')!;
    expect(refresh.opts).toMatchObject({ httpOnly: true, path: '/api/auth' });
    expect(go.r.cleared).toContain('tvmf_staff_wait');
    expect((await sso.auth.refresh(refresh.value, META)).accessToken).toBeTruthy();
    // used once
    expect(await controller.waitContinue(req({ tvmf_staff_wait: wait.value }), fakeRes().res)).toEqual({ ok: false });
  });

  it('the administrators\' list shows who, from where and which role; and the admin routes are for sso:manage only', async () => {
    await setMode('needs_approval');
    const p = staff();
    await hubSignIn(p);
    const adminCtl = new SsoAdminController(sso.providers, sso.staffAccess, sso.cfg);
    const o = await adminCtl.access();
    expect(o.mode).toBe('needs_approval');
    expect(o.pending).toHaveLength(1);
    expect(o.pending[0]).toMatchObject({ email: p.email, displayName: 'Sam Staff', requestedRole: 'SUPER_ADMIN', effectiveRole: 'SUPER_ADMIN', ip: META.ip, providerSessionId: 'hub-session-7', status: 'pending' });
    const approved = await adminCtl.approve(o.pending[0]!.id, { hours: 8 }, { id: owner.id, email: owner.email } as never);
    expect(approved).toMatchObject({ status: 'approved', windowHours: 8, decidedByName: expect.any(String) });
    expect((await adminCtl.access()).windows.map((w) => w.email)).toEqual([p.email]);
    expect(Reflect.getMetadata('rbac:permissions', SsoAdminController)).toEqual(['sso:manage']); // every route of the controller, the new ones included
  });
});
