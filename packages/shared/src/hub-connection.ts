/**
 * The connection to a Voxshift Hub: the registry (https://hub.voxshift.io) that lists this installation and where people with a hub account open it from.
 * This installation reports in once a minute with a version and a health word, and NOTHING else: the shape below is the whole of it,
 * and the hub refuses any other field. A Super Admin connects it on Administration > Platform settings.
 */
import { z } from 'zod';
import { normalizeBaseUrl } from './base-url';

export const DEFAULT_HUB_URL = 'https://hub.voxshift.io';
export const HUB_HEARTBEAT_SECONDS = 60;

/** An instance token as the hub shows it once: `vxh_<instance id>_<secret>`. */
export const HUB_TOKEN_RE = /^vxh_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[0-9a-f]{48}$/;

export const connectHubSchema = z
  .object({
    hubUrl: z.string().transform((v, ctx) => {
      const r = normalizeBaseUrl(v);
      if (!r.ok) {
        ctx.addIssue({ code: 'custom', message: r.error });
        return z.NEVER;
      }
      return r.url;
    }),
    token: z.string().trim().regex(HUB_TOKEN_RE, 'That is not an instance token from the hub. It starts with vxh_ and is shown once when the instance is registered.'),
  })
  .strict();
export type ConnectHubInput = z.infer<typeof connectHubSchema>;

/** What is sent to the hub, once a minute. Metadata only. */
export interface HubHeartbeat {
  version: string;
  health: 'ok' | 'degraded';
  uptimeSeconds: number;
  /** The customer's switch: have they allowed people with a hub account to open this installation through the hub? */
  remoteAccess: boolean;
  /**
   * True exactly when this installation's `hub` sign-in provider exists and is switched on (single sign-on, docs/SSO.md), so the hub only
   * offers one-click sign-in to installations that have it. Left out when the installation cannot tell (never `false` by guess).
   */
  sso?: boolean;
  /**
   * The highest revocation line from the hub applied so far (docs/SSO.md 5.3). Sending it tells the hub this installation understands
   * revocations, and the hub's reply then carries `ssoRevocations`. Left out when there is no hub sign-in provider here, and when the hub
   * is an older release that refuses fields it does not know.
   */
  ssoRevocationsAck?: number;
}

/** The heartbeat body. `sso` and `ssoRevocationsAck` are included only when known; every other field is always sent, and nothing else ever is. */
export function buildHubHeartbeat(f: { version: string; uptimeSeconds: number; remoteAccess: boolean; sso?: boolean | null; ssoRevocationsAck?: number | null }): HubHeartbeat {
  return {
    version: f.version,
    health: 'ok',
    uptimeSeconds: f.uptimeSeconds,
    remoteAccess: f.remoteAccess,
    ...(typeof f.sso === 'boolean' ? { sso: f.sso } : {}),
    ...(typeof f.ssoRevocationsAck === 'number' && Number.isSafeInteger(f.ssoRevocationsAck) && f.ssoRevocationsAck >= 0 ? { ssoRevocationsAck: f.ssoRevocationsAck } : {}),
  };
}

/** Why the hub says a person's access ended (docs/SSO.md 5.3). Anything else the hub may send later is treated as `sessions_revoked`: the safe reading. */
export const HUB_REVOCATION_REASONS = ['grant_removed', 'user_disabled', 'sessions_revoked', 'role_changed'] as const;
export type HubRevocationReason = (typeof HUB_REVOCATION_REASONS)[number];

/** One line of the hub's revocation channel: sessions this person started here before `before` are over. */
export interface HubRevocation {
  /** Increasing; the highest applied is sent back as the acknowledgement. */
  id: number;
  /** The hub's user id for the person: the `sub` of their ID tokens. */
  sub: string;
  /** ISO time on the hub's clock. */
  before: string;
  reason: HubRevocationReason;
}

/**
 * Reads `ssoRevocations` from the hub's heartbeat reply. A reply without it (an older hub, or no acknowledgement asked) is an empty list. A line
 * that is not well formed is dropped rather than failing the others, but never makes a later valid line unreachable: the caller acknowledges
 * `maxId`, the highest id seen on any line that had one.
 */
export function parseHubRevocations(reply: unknown): { lines: HubRevocation[]; maxId: number } {
  const raw = (reply as { ssoRevocations?: unknown } | null)?.ssoRevocations;
  if (!Array.isArray(raw)) return { lines: [], maxId: 0 };
  const lines: HubRevocation[] = [];
  let maxId = 0;
  for (const r of raw.slice(0, 1000)) {
    const e = r as Partial<Record<keyof HubRevocation, unknown>> | null;
    if (!e || typeof e.id !== 'number' || !Number.isSafeInteger(e.id) || e.id < 1) continue;
    maxId = Math.max(maxId, e.id);
    if (typeof e.sub !== 'string' || !e.sub || e.sub.length > 300) continue;
    if (typeof e.before !== 'string' || Number.isNaN(Date.parse(e.before))) continue;
    const reason = (HUB_REVOCATION_REASONS as readonly unknown[]).includes(e.reason) ? (e.reason as HubRevocationReason) : 'sessions_revoked';
    lines.push({ id: e.id, sub: e.sub, before: e.before, reason });
  }
  return { lines, maxId };
}

/** The customer's switch for remote access through the hub. */
export const setHubRemoteAccessSchema = z.object({ enabled: z.boolean() }).strict();
export type SetHubRemoteAccessInput = z.infer<typeof setHubRemoteAccessSchema>;

export type HubTunnelState = 'off' | 'connecting' | 'connected' | 'error';

/** What Platform settings shows. The token itself is never returned, only its last four characters. */
export interface HubConnectionView {
  connected: boolean;
  hubUrl: string | null;
  tokenHint: string | null;
  lastAttemptAt: string | null;
  lastOkAt: string | null;
  /** Why the last report failed, in words; null when it worked. */
  lastError: string | null;
  /** The customer's switch: people with a hub account may open this installation through the hub only while it is on. */
  remoteAccess: boolean;
  tunnelState: HubTunnelState;
  /** Why the connection to the hub for remote access is not up, in words. */
  tunnelError: string | null;
}

/** A report counts as current for this long after the last success (a few missed minutes are normal). */
export const HUB_OK_WITHIN_SECONDS = 180;

export type HubLinkState = 'not_connected' | 'ok' | 'waiting' | 'failing';

export function hubLinkState(v: HubConnectionView, now: Date = new Date()): HubLinkState {
  if (!v.connected) return 'not_connected';
  if (v.lastError) return 'failing';
  if (!v.lastOkAt) return 'waiting';
  return now.getTime() - Date.parse(v.lastOkAt) <= HUB_OK_WITHIN_SECONDS * 1000 ? 'ok' : 'failing';
}

/** A person-readable reason for a failed report. Never includes the token. */
export function hubErrorText(status: number | null, detail?: string): string {
  if (status === 401) return 'The hub does not accept this token. It may have been rotated or the instance removed in the hub: copy a fresh one.';
  if (status === 403) return 'This instance is switched off in the hub.';
  if (status === 429) return 'The hub says this instance is reporting too often.';
  if (status !== null) return `The hub answered with an error (${status}).`;
  return `Could not reach the hub${detail ? `: ${detail}` : ''}.`;
}

/** What the connector says when the hub closes its connection (the hub uses these codes: see the hub's tunnel). */
export function tunnelCloseText(code: number): string {
  if (code === 4401) return 'The hub does not accept this installation\'s token for remote access. Copy a fresh one from the hub and connect again.';
  if (code === 4403) return 'This installation is switched off in the hub.';
  if (code === 4000) return 'Replaced by a newer connection from this installation.';
  return 'The connection to the hub was lost. Retrying.';
}
