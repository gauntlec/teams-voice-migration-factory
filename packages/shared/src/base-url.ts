/**
 * The base URL: the one address people (and assistants) use to reach this installation, e.g.
 * https://www.voxshift.io for the hosted service, or https://voice.contoso.local for a customer-premises install.
 * Every link in an email, the CORS allow-list and the "connect a bot" details are built from it.
 * A Super Admin sets it on Administration > Platform settings; until then the WEB_ORIGIN environment value is used.
 */
import { z } from 'zod';
import type { HubConnectionView } from './hub-connection';

/** The hosted service's address, used in docs and as the example everywhere. */
export const HOSTED_BASE_URL = 'https://www.voxshift.io';

export type BaseUrlResult = { ok: true; url: string } | { ok: false; error: string };

/** Validates an address typed by a person and returns it in the one form we store: origin only, no trailing slash. */
export function normalizeBaseUrl(input: string): BaseUrlResult {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'Enter the address, for example https://voice.example.com' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'That is not a web address. Start it with https:// (or http:// for a test install).' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'Use an http:// or https:// address.' };
  if (u.username || u.password) return { ok: false, error: 'Leave the user name and password out of the address.' };
  if (u.search || u.hash) return { ok: false, error: 'Leave out everything after the host name (no ? or #).' };
  if (u.pathname !== '/' && u.pathname !== '') return { ok: false, error: 'Voxshift runs at the root of its address; leave out the path (for example /app).' };
  return { ok: true, url: u.origin };
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]$)|\.(local|lan|internal|localhost|test)$/i;

/** True for a host on a private network or a local name, where plain http is a normal choice for a test install. */
export function isPrivateHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return PRIVATE_HOST.test(h) || !h.includes('.');
  } catch {
    return false;
  }
}

/** Things worth telling the administrator about an address that is valid but unusual. */
export function baseUrlWarnings(url: string): string[] {
  const out: string[] = [];
  if (url.startsWith('http://') && !isPrivateHost(url)) {
    out.push('This address uses plain http on a public name. Sign-in cookies and tokens would cross the network unencrypted. Use https.');
  } else if (url.startsWith('http://')) {
    out.push('This address uses plain http. That is fine for a test install on a private network; use https for anything else.');
  }
  return out;
}

/** The address a person typed, or null to go back to the installation default (the WEB_ORIGIN environment value). */
export const setBaseUrlSchema = z
  .object({
    baseUrl: z
      .string()
      .nullable()
      .transform((v, ctx) => {
        if (v === null || v.trim() === '') return null;
        const r = normalizeBaseUrl(v);
        if (!r.ok) {
          ctx.addIssue({ code: 'custom', message: r.error });
          return z.NEVER;
        }
        return r.url;
      }),
  })
  .strict();
export type SetBaseUrlInput = z.infer<typeof setBaseUrlSchema>;

/** What Administration > Platform settings shows. */
export interface BaseUrlView {
  /** The address in use now. */
  baseUrl: string;
  /** Where it comes from: the saved setting, or the WEB_ORIGIN environment value. */
  source: 'setting' | 'environment';
  /** The WEB_ORIGIN environment value, which applies when no setting is saved. */
  environmentValue: string;
  warnings: string[];
  /** False when a Super Admin has switched all email off. */
  emailEnabled: boolean;
  /** The connection to a Voxshift Hub (reporting this installation to the registry). */
  hub: HubConnectionView;
  /** Connection details for assistants, built from `baseUrl`. */
  connect: { voxshiftUrl: string; agentApi: string; intakeAlerts: string; inboundEmail: string };
}

export function connectDetails(baseUrl: string): BaseUrlView['connect'] {
  return {
    voxshiftUrl: baseUrl,
    agentApi: `${baseUrl}/api/agent/v1`,
    intakeAlerts: `${baseUrl}/api/intake/v1/alerts`,
    inboundEmail: `${baseUrl}/api/public/inbound-email`,
  };
}

/** The master email switch. */
export const setEmailEnabledSchema = z.object({ enabled: z.boolean() }).strict();
export type SetEmailEnabledInput = z.infer<typeof setEmailEnabledSchema>;
