/**
 * Incidents by email (docs/INTAKE.md): replies to Voxshift's emails become comments, and mail to the incidents address can raise
 * an incident. This is the pure part: addresses and reply tokens, telling a human from an auto-reply, and cutting a reply down to what
 * the person actually wrote. The API does the storing.
 */
import { z } from 'zod';

/** A reply token: lower-case base32 (some mail systems lower-case the local part, so it must survive that), 26 characters. */
export const REPLY_TOKEN_RE = /^[a-z2-7]{26}$/;
export const REPLY_TOKEN_DAYS = 90;

/** The address replies go to: `incidents@x.example` + a token = `incidents+<token>@x.example`. */
export function inboundReplyAddress(base: string, token: string): string {
  const [local, domain] = base.split('@');
  return `${local}+${token}@${domain}`;
}

/** The bare email address in "Name <a@b.c>" or "a@b.c". */
export function emailOf(s: string): string {
  // The text of the first <...> with something inside it. Walked by hand: the regex /<([^>]+)>/ is quadratic on a long run of "<".
  let inner: string | null = null;
  for (let i = s.indexOf('<'); i >= 0; i = s.indexOf('<', i + 1)) {
    const j = s.indexOf('>', i + 1);
    if (j < 0) break;
    if (j > i + 1) { inner = s.slice(i + 1, j); break; }
  }
  return (inner ?? s).trim().toLowerCase();
}

export type InboundTarget = { kind: 'reply'; token: string } | { kind: 'raise'; hint: string | null } | null;

/**
 * What a message addressed to us is for: the first reply token among its addresses, else the incidents address itself (raise one; a
 * plus-tag that is not a token is a hint at which customer, e.g. `incidents+contoso@`), else nothing of ours.
 */
export function inboundTarget(addresses: string[], base: string): InboundTarget {
  const [bLocal, bDomain] = base.toLowerCase().split('@');
  let raise: InboundTarget = null;
  for (const a of addresses.map(emailOf)) {
    const [local, domain] = a.split('@');
    if (!local || domain !== bDomain) continue;
    if (local === bLocal) raise ??= { kind: 'raise', hint: null };
    else if (local.startsWith(`${bLocal}+`)) {
      const tag = local.slice(bLocal!.length + 1);
      if (REPLY_TOKEN_RE.test(tag)) return { kind: 'reply', token: tag };
      raise ??= { kind: 'raise', hint: tag || null };
    }
  }
  return raise;
}

/** Out-of-office replies, delivery failures, list mail and the like: never a person writing to us. */
export function isAutoReply(args: { headers?: Record<string, string>; subject: string; from: string }): boolean {
  const h = Object.fromEntries(Object.entries(args.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]));
  if (h['auto-submitted'] && h['auto-submitted'] !== 'no') return true;
  if (/(oof|autoreply|auto-reply|all)/.test(h['x-auto-response-suppress'] ?? '') && 'x-auto-response-suppress' in h) return true;
  if (/^(bulk|junk|list|auto_reply)$/.test(h['precedence'] ?? '')) return true;
  if ('x-autoreply' in h || 'x-autorespond' in h || 'list-id' in h || 'list-unsubscribe' in h) return true;
  if (/^\s*(automatic reply|auto(matic)?[- ]?reply|out of office|undeliverable|delivery (status|failure)|mail delivery failed)/i.test(args.subject)) return true;
  const local = emailOf(args.from).split('@')[0] ?? '';
  return /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce)/.test(local);
}

const REPLY_PREFIX = /^\s*((re|fw|fwd|aw|sv|antw|wg)\s*:\s*)+/i;

/** A subject as an incident title: no Re:/Fwd:, no [INC-0042] tags. */
export function emailSubjectToTitle(subject: string, fallbackFrom?: string): string {
  const t = subject.replace(REPLY_PREFIX, '').replace(/\[(INC|SR)-\d+\]/gi, '').replace(/\s+/g, ' ').trim();
  const out = t.length >= 3 ? t : `Email${fallbackFrom ? ` from ${fallbackFrom}` : ''}`;
  return out.slice(0, 160);
}

const WROTE = /^on .{5,300}wrote:\s*$/i;
const OUTLOOK_HEADER = /^(from|sent|to|cc|subject|date):\s/i;

/**
 * Cuts an email down to what the sender wrote now: no quoted earlier messages ("On ... wrote:", "> ...", Outlook's "From: Sent: To:
 * Subject:" block, "-----Original Message-----"), no signature delimiter, no "Sent from my iPhone". Capped at 4000 characters.
 */
export function cleanEmailReply(text: string, max = 4000): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (/^-{2,}\s*(original|forwarded) message\s*-{2,}/i.test(trimmed) || /^_{8,}$/.test(trimmed)) break;
    if (WROTE.test(trimmed) || (/^on .{5,200}$/i.test(trimmed) && WROTE.test(`${trimmed} ${(lines[i + 1] ?? '').trim()}`))) break;
    if (OUTLOOK_HEADER.test(trimmed) && lines.slice(i, i + 5).filter((l) => OUTLOOK_HEADER.test(l.trim())).length >= 3) break;
    if (/^-- ?$/.test(line) || /^sent from my (iphone|ipad|android|mobile|phone|galaxy|blackberry)/i.test(trimmed) || /^get outlook for /i.test(trimmed)) break;
    if (trimmed.startsWith('>')) continue;
    out.push(line.replace(/\s+$/, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

/** What an inbound-mail forwarder posts (Power Automate, a mail-parsing service ...). */
export const inboundEmailSchema = z
  .object({
    messageId: z.string().trim().min(1).max(300),
    from: z.object({ email: z.string().trim().min(3).max(320), name: z.string().trim().max(200).optional() }).strict(),
    to: z.array(z.string().trim().min(3).max(400)).min(1).max(30),
    cc: z.array(z.string().trim().min(3).max(400)).max(30).optional(),
    subject: z.string().max(1000).default(''),
    text: z.string().max(60_000).default(''),
    headers: z.record(z.string(), z.string().max(1000)).optional(),
    /** The forwarder's verdict that the sender is who they say (SPF/DKIM/DMARC passed). Without it, nothing is acted on. */
    authenticated: z.boolean().default(false),
    attachments: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type InboundEmail = z.infer<typeof inboundEmailSchema>;

export const INBOUND_OUTCOMES = [
  'duplicate',
  'auto_reply',
  'unauthenticated',
  'not_ours',
  'bad_token',
  'sender_mismatch',
  'user_inactive',
  'not_member',
  'incident_gone',
  'incident_closed',
  'empty',
  'replied',
  'noted',
  'raised',
  'disabled',
  'ambiguous_customer',
  'unknown_sender',
  'site_ambiguous',
  'error',
] as const;
export type InboundOutcome = (typeof INBOUND_OUTCOMES)[number];
