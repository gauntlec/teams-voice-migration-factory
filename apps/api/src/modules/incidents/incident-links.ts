import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed links in "Is it fixed?" emails: the recipient answers without signing
 * in. The token names the customer, the incident and the person it was sent to,
 * and expires; it is an HMAC over that, so it can't be forged or pointed at
 * another incident. It only ever allows "it's fixed" or "it's still broken" for
 * that person on that incident, through the normal rules (the reporter or a
 * follower, while the incident is resolved).
 */
export interface IncidentLinkPayload {
  /** tenant id */
  t: string;
  /** incident id */
  i: string;
  /** user the email was sent to */
  u: string;
  /** expiry, seconds since the epoch */
  exp: number;
}

export const INCIDENT_LINK_DAYS = 14;

const key = (secret: string) => `incident-link:${secret}`;
const b64 = (s: string) => Buffer.from(s).toString('base64url');

export function signIncidentLink(secret: string, p: Omit<IncidentLinkPayload, 'exp'>, now = Date.now()): string {
  const body = b64(JSON.stringify({ ...p, exp: Math.floor(now / 1000) + INCIDENT_LINK_DAYS * 86_400 } satisfies IncidentLinkPayload));
  const mac = createHmac('sha256', key(secret)).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** The payload if the token is genuine and unexpired; otherwise null. */
export function verifyIncidentLink(secret: string, token: string, now = Date.now()): IncidentLinkPayload | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', key(secret)).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as IncidentLinkPayload;
    if (typeof p.t !== 'string' || typeof p.i !== 'string' || typeof p.u !== 'string' || typeof p.exp !== 'number') return null;
    return p.exp * 1000 > now ? p : null;
  } catch {
    return null;
  }
}
