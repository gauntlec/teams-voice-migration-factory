// Email settings kept in the app: they win over the SMTP_* environment values, the password is encrypted and never returned, and the worker sends
// by whichever way is set up: its own mail server (always encrypted) or the Voxshift Hub's mail service.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SMTPServer, type SMTPServerOptions } from 'smtp-server';
import { effectiveMail, platformDb, readMailRow } from '@tvmf/db';
import { setMailSettingsSchema } from '@tvmf/shared';
import type { AppConfig } from '../../../../apps/api/src/common/config';
import { MailService } from '../../../../apps/api/src/mail/mail.service';
import { PlatformSettingsService } from '../../../../apps/api/src/platform-ops/platform-settings.service';
import { resolveMail, sendMail } from '../../../../apps/worker/src/mail/mailer';
import { seedUser, useDb, useGlobalSettingsLock } from '../helpers';

const handle = useDb();
useGlobalSettingsLock(handle);
const TOKEN = `vxh_b04e6c2c-d276-4c12-a477-0554a8b34d20_${'ef56'.repeat(12)}`;
const cfg = { WEB_ORIGIN: 'http://localhost:5173', REFRESH_COOKIE: 'tvmf_rt' } as AppConfig;
let svc: PlatformSettingsService;
let admin: Awaited<ReturnType<typeof seedUser>>;
const queued: unknown[] = [];

/** A tiny mail server that remembers what it was given. The built-in self-signed certificate is accepted by turning verification off for this process only. */
async function mailServer(opts: Partial<SMTPServerOptions> = {}) {
  const got: { from: string; to: string[]; raw: string; user?: string }[] = [];
  const server = new SMTPServer({
    authOptional: false,
    disabledCommands: [],
    onAuth(auth, _s, cb) {
      if (auth.username === 'mailer@example.test' && auth.password === 's3cret-pass') return cb(null, { user: auth.username });
      cb(new Error('Invalid login'));
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        got.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString(), user: (session.user as string) ?? undefined });
        cb();
      });
    },
    logger: false,
    ...opts,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { got, port: (server.server.address() as AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

beforeAll(async () => {
  admin = await seedUser(handle, 'SUPER_ADMIN');
  const queue = { add: async (...a: unknown[]) => void queued.push(a) } as never;
  svc = new PlatformSettingsService(handle.db, cfg, new MailService(handle.db, queue));
});
afterAll(async () => {
  await platformDb(handle.db).deleteFrom('app_settings').execute();
});

describe('the settings', () => {
  it('fall back to the environment until something is saved, and a save takes over', async () => {
    await platformDb(handle.db).deleteFrom('app_settings').execute();
    const env = { SMTP_HOST: 'smtp.office365.com', SMTP_PORT: '587', SMTP_USER: 'no-reply@voxshift.io', SMTP_PASS: 'from-the-env', MAIL_FROM: 'no-reply@voxshift.io' } as NodeJS.ProcessEnv;
    expect(effectiveMail(await readMailRow(handle.db), env)).toMatchObject({ mode: 'smtp', source: 'environment', host: 'smtp.office365.com', passEnv: 'from-the-env' });
    expect(effectiveMail(await readMailRow(handle.db), {} as NodeJS.ProcessEnv)).toMatchObject({ mode: 'none', source: 'environment' });

    const parsed = setMailSettingsSchema.parse({ mode: 'smtp', smtp: { host: 'mail.contoso.test', port: 465, secure: true, user: 'svc', from: 'voice@contoso.test', fromName: 'Contoso Voice' } });
    const v = (await svc.setMail(parsed, admin.id)).mail;
    expect(v).toMatchObject({ mode: 'smtp', source: 'setting', smtp: { host: 'mail.contoso.test', port: 465, secure: true, from: 'voice@contoso.test', fromName: 'Contoso Voice' } });
  });

  it('stores the password encrypted, never returns it, keeps it when left out and replaces or removes it on request', async () => {
    const base = { host: 'mail.contoso.test', port: 587, secure: false, user: 'svc', from: 'voice@contoso.test', fromName: 'Voxshift' };
    await svc.setMail(setMailSettingsSchema.parse({ mode: 'smtp', smtp: { ...base, password: 'hunter2-hunter2' } }), admin.id);
    const row = await readMailRow(handle.db);
    expect(row.smtp_pass_enc).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain('hunter2');
    let view = await svc.mailView();
    expect(view.smtp.passwordSet).toBe(true);
    expect(JSON.stringify(view)).not.toContain('hunter2');

    const kept = (await readMailRow(handle.db)).smtp_pass_enc;
    await svc.setMail(setMailSettingsSchema.parse({ mode: 'smtp', smtp: base }), admin.id); // password left out: kept
    expect((await readMailRow(handle.db)).smtp_pass_enc).toBe(kept);
    await svc.setMail(setMailSettingsSchema.parse({ mode: 'smtp', smtp: { ...base, password: 'another-one-here' } }), admin.id);
    expect((await readMailRow(handle.db)).smtp_pass_enc).not.toBe(kept);
    await svc.setMail(setMailSettingsSchema.parse({ mode: 'smtp', smtp: { ...base, password: '' } }), admin.id); // empty: removed
    view = await svc.mailView();
    expect(view.smtp.passwordSet).toBe(false);
  });

  it('refuses nonsense and lets the choice be switched without losing the server details', async () => {
    expect(setMailSettingsSchema.safeParse({ mode: 'smtp', smtp: { host: '', from: 'a@b.co' } }).success).toBe(false);
    expect(setMailSettingsSchema.safeParse({ mode: 'smtp', smtp: { host: 'x', from: 'not-an-address' } }).success).toBe(false);
    expect(setMailSettingsSchema.safeParse({ mode: 'smtp', smtp: { host: 'x', from: 'a@b.co', port: 70000 } }).success).toBe(false);
    expect(setMailSettingsSchema.safeParse({ mode: 'carrier-pigeon' }).success).toBe(false);
    await svc.setMail(setMailSettingsSchema.parse({ mode: 'none' }), admin.id);
    expect((await svc.mailView()).smtp.host).toBe('mail.contoso.test'); // still remembered for when it is switched back
    expect((await svc.mailView()).mode).toBe('none');
  });

  it('queues a test message the normal way, refuses when email is off or not set up', async () => {
    await expect(svc.testMail('craig@example.test')).rejects.toThrow(/not set up/);
    await svc.setMail(setMailSettingsSchema.parse({ mode: 'smtp', smtp: { host: 'mail.contoso.test', port: 587, secure: false, user: '', from: 'voice@contoso.test', fromName: 'Voxshift' } }), admin.id);
    const { id } = await svc.testMail('craig@example.test');
    expect(queued.length).toBeGreaterThan(0);
    expect((await svc.mailTestStatus(id)).status).toBe('queued');
    await svc.setEmailEnabled(false, admin.id);
    await expect(svc.testMail('craig@example.test')).rejects.toThrow(/switched off/);
    await svc.setEmailEnabled(true, admin.id);
    await platformDb(handle.db).deleteFrom('email_messages').where('template', '=', 'mail_test').execute();
  });
});

describe('sending through the installation\'s own mail server', () => {
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  beforeAll(() => void (process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'));
  afterAll(() => void (prev === undefined ? delete process.env.NODE_TLS_REJECT_UNAUTHORIZED : (process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev)));

  it('signs in with the saved password, sends from the saved address and name, over an encrypted connection', async () => {
    const srv = await mailServer();
    try {
      await svc.setMail(setMailSettingsSchema.parse({ mode: 'smtp', smtp: { host: '127.0.0.1', port: srv.port, secure: false, user: 'mailer@example.test', password: 's3cret-pass', from: 'voice@contoso.test', fromName: 'Contoso Voice' } }), admin.id);
      const cfgNow = await resolveMail(handle.db);
      expect(cfgNow.mode).toBe('smtp');
      if (cfgNow.mode === 'none') throw new Error('unreachable');
      await sendMail(cfgNow, { to: 'jo@example.test', toName: 'Jo Bloggs', subject: 'Hello there', html: '<p>Hi</p>', text: 'Hi' });
      expect(srv.got).toHaveLength(1);
      expect(srv.got[0]).toMatchObject({ from: 'voice@contoso.test', to: ['jo@example.test'], user: 'mailer@example.test' });
      expect(srv.got[0]!.raw).toContain('Subject: Hello there');
      expect(srv.got[0]!.raw).toContain('Contoso Voice');
    } finally {
      await srv.close();
    }
  });

  it('refuses a server that offers no encryption instead of falling back to plain text, and a wrong password fails', async () => {
    const plain = await mailServer({ disabledCommands: ['STARTTLS', 'AUTH'], authOptional: true });
    try {
      await svc.setMail(setMailSettingsSchema.parse({ mode: 'smtp', smtp: { host: '127.0.0.1', port: plain.port, secure: false, user: '', password: '', from: 'v@c.test', fromName: 'V' } }), admin.id);
      const c = await resolveMail(handle.db);
      if (c.mode === 'none') throw new Error('unreachable');
      await expect(sendMail(c, { to: 'jo@example.test', subject: 'x', html: 'x', text: 'x' })).rejects.toThrow();
      expect(plain.got).toHaveLength(0);
    } finally {
      await plain.close();
    }
    const srv = await mailServer();
    try {
      await svc.setMail(setMailSettingsSchema.parse({ mode: 'smtp', smtp: { host: '127.0.0.1', port: srv.port, secure: false, user: 'mailer@example.test', password: 'wrong-password', from: 'v@c.test', fromName: 'V' } }), admin.id);
      const c = await resolveMail(handle.db);
      if (c.mode === 'none') throw new Error('unreachable');
      await expect(sendMail(c, { to: 'jo@example.test', subject: 'x', html: 'x', text: 'x' })).rejects.toThrow(/Invalid login|auth/i);
    } finally {
      await srv.close();
    }
  });

  it('says plainly that nothing is set up when it is not', async () => {
    await svc.setMail(setMailSettingsSchema.parse({ mode: 'none' }), admin.id);
    expect(await resolveMail(handle.db)).toMatchObject({ mode: 'none', reason: expect.stringMatching(/Platform settings > Email/) });
  });
});

describe('sending through the Voxshift Hub', () => {
  async function fakeHub(handler: (req: { auth: string; body: Record<string, unknown> }) => { status: number; json: unknown }) {
    const seen: { auth: string; body: Record<string, unknown> }[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const call = { auth: String(req.headers.authorization), body: JSON.parse(Buffer.concat(chunks).toString() || '{}') };
        seen.push(call);
        const r = handler(call);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.json));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it('hands the message to the hub with the instance token and no server details of its own', async () => {
    const hub = await fakeHub(() => ({ status: 200, json: { ok: true, messageId: '<abc@hub>' } }));
    try {
      await svc.connectHub(hub.url, TOKEN, admin.id);
      await svc.setMail(setMailSettingsSchema.parse({ mode: 'hub', fromName: 'Contoso Voice' }), admin.id);
      expect((await svc.mailView()).hub).toMatchObject({ connected: true });
      const c = await resolveMail(handle.db);
      expect(c).toMatchObject({ mode: 'hub', fromName: 'Contoso Voice' });
      if (c.mode === 'none') throw new Error('unreachable');
      const id = await sendMail(c, { to: 'jo@example.test', toName: 'Jo', subject: 'Hello', html: '<p>Hi</p>', text: 'Hi', replyTo: 'reply@contoso.test' });
      expect(id).toBe('<abc@hub>');
      expect(hub.seen[0]!.auth).toBe(`Bearer ${TOKEN}`);
      expect(Object.keys(hub.seen[0]!.body).sort()).toEqual(['fromName', 'html', 'replyTo', 'subject', 'text', 'to', 'toName']);
      expect(hub.seen[0]!.body).not.toHaveProperty('from'); // the hub decides the From address
    } finally {
      await hub.close();
    }
  });

  it('turns every refusal into a sentence, and is "not set up" when no hub is connected', async () => {
    for (const [status, code, expected] of [[401, 'unauthorized', /does not accept/], [403, 'relay_disabled', /switched off for this installation/], [429, 'rate_limited', /limiting/], [503, 'mail_off', /not set up yet/], [400, 'invalid', /refused the message/], [502, 'smtp_failed', /could not send/]] as const) {
      const hub = await fakeHub(() => ({ status, json: { error: code, message: 'detail' } }));
      try {
        await svc.connectHub(hub.url, TOKEN, admin.id);
        await svc.setMail(setMailSettingsSchema.parse({ mode: 'hub', fromName: 'V' }), admin.id);
        const c = await resolveMail(handle.db);
        if (c.mode === 'none') throw new Error('unreachable');
        await expect(sendMail(c, { to: 'jo@example.test', subject: 'x', html: 'x', text: 'x' })).rejects.toThrow(expected);
      } finally {
        await hub.close();
      }
    }
    await svc.disconnectHub(admin.id);
    expect(await resolveMail(handle.db)).toMatchObject({ mode: 'none', reason: expect.stringMatching(/not connected to a hub/) });
  });
});
