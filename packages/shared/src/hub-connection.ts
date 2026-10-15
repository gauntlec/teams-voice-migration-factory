/**
 * The connection to a Voxshift Hub: the registry (https://hub.voxshift.io) that lists this installation and where staff open it from.
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
  /** The customer's switch: have they allowed staff to open this installation through the hub? */
  remoteAccess: boolean;
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
  /** The customer's switch: staff may open this installation through the hub only while it is on. */
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
