import nodemailer, { type Transporter } from 'nodemailer';
import type { Kysely } from 'kysely';
import { effectiveMail, readMailRow, type DB } from '@tvmf/db';
import { hubMailErrorText, type HubMailRequest } from '@tvmf/shared';
import { decryptSecret } from '../crypto';

/**
 * How mail leaves this installation, decided per message from the settings saved in the app (Administration > Platform settings > Email),
 * falling back to the SMTP_* environment values when nothing is saved there (see `effectiveMail` in @tvmf/db):
 *   smtp = a mail server of its own (always STARTTLS or implicit TLS, never plain text);
 *   hub  = the mail service of the Voxshift Hub this installation is connected to, which holds the mail server details and sends it.
 */
export type ResolvedMail =
  | { mode: 'none'; reason: string }
  | { mode: 'smtp'; host: string; port: number; secure: boolean; user: string; pass: string; from: string; fromName: string }
  | { mode: 'hub'; hubUrl: string; token: string; fromName: string };

export const NOT_SET_UP = 'Email is not set up: choose how it is sent in Administration > Platform settings > Email.';

export async function resolveMail(db: Kysely<DB>): Promise<ResolvedMail> {
  const row = await readMailRow(db);
  const m = effectiveMail(row);
  if (m.mode === 'smtp') {
    if (!m.host) return { mode: 'none', reason: NOT_SET_UP };
    const pass = m.passEnc ? decryptSecret(m.passEnc) : (m.passEnv ?? '');
    return { mode: 'smtp', host: m.host, port: m.port, secure: m.secure, user: m.user, pass, from: m.from, fromName: m.fromName };
  }
  if (m.mode === 'hub') {
    if (!row.hub_url || !row.hub_token_enc) return { mode: 'none', reason: 'Email is set to go through the Voxshift Hub, but this installation is not connected to a hub.' };
    return { mode: 'hub', hubUrl: row.hub_url, token: decryptSecret(row.hub_token_enc), fromName: m.fromName };
  }
  return { mode: 'none', reason: NOT_SET_UP };
}

let transporter: { key: string; t: Transporter } | null = null;

/** One transport per distinct set of server details, so a saved change takes effect on the next message. */
function transportFor(c: Extract<ResolvedMail, { mode: 'smtp' }>): Transporter {
  const key = JSON.stringify([c.host, c.port, c.secure, c.user, c.pass]);
  if (!transporter || transporter.key !== key) {
    transporter?.t.close();
    transporter = {
      key,
      t: nodemailer.createTransport({
        host: c.host,
        port: c.port,
        secure: c.secure,
        // Office 365 / most relays on 587 use STARTTLS - insist on the upgrade rather than ever falling back to a plaintext session.
        requireTLS: !c.secure,
        auth: c.user ? { user: c.user, pass: c.pass } : undefined,
      }),
    };
  }
  return transporter.t;
}

export interface OutgoingMail {
  to: string;
  toName?: string | null;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
}

/** Send one email by whichever way is set up. Throws on any failure so the caller can retry. */
export async function sendMail(cfg: Exclude<ResolvedMail, { mode: 'none' }>, m: OutgoingMail, opts: { fetchFn?: typeof fetch } = {}): Promise<string> {
  if (cfg.mode === 'smtp') {
    const info = await transportFor(cfg).sendMail({
      from: `"${cfg.fromName}" <${cfg.from}>`,
      to: m.toName ? `"${m.toName}" <${m.to}>` : m.to,
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      subject: m.subject,
      text: m.text,
      html: m.html,
    });
    return info.messageId;
  }
  const body: HubMailRequest = { to: m.to, toName: m.toName ?? null, subject: m.subject, html: m.html, text: m.text, replyTo: m.replyTo ?? null, fromName: cfg.fromName };
  let res: Response;
  try {
    res = await (opts.fetchFn ?? fetch)(`${cfg.hubUrl}/api/v1/mail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(hubMailErrorText(null, (e as Error).message.slice(0, 120)));
  }
  const reply = (await res.json().catch(() => null)) as { messageId?: string; error?: string; message?: string } | null;
  if (!res.ok) throw new Error(hubMailErrorText(res.status, reply?.error, reply?.message));
  return reply?.messageId ?? 'hub';
}
