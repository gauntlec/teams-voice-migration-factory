/**
 * Single sign-on (OpenID Connect), the installation's side. The agreed contract with the Voxshift Hub is docs/SSO.md; this file holds the
 * parts the API and the web app share: roles and the ceiling, the safe return path, the shapes the settings screen uses, and the plain
 * language the login page shows when a sign-in is refused.
 */
import { z } from 'zod';
import { ROLES, type Role } from './rbac';

export const HUB_PROVIDER_NAME = 'Voxshift Hub';
export const SSO_SESSION_DEFAULT_HOURS = 12;

/** Where an OIDC provider sends the browser back to (the one path both sides register). */
export const OIDC_CALLBACK_PATH = '/api/auth/oidc/callback';

/** The roles from most to least powerful: the order they are listed in. A ceiling is "up to and including this one". */
export function roleRank(role: Role): number {
  return ROLES.length - 1 - ROLES.indexOf(role);
}

/** Effective role = the lower of what the provider asked for and the ceiling (docs/SSO.md 4.3). */
export function capRole(requested: Role, ceiling: Role): Role {
  return roleRank(requested) <= roleRank(ceiling) ? requested : ceiling;
}

/** The ceiling that applies to one person from a provider: the hub has one for staff and one for the customer's own people; other providers have one. */
export function ceilingForIdentity(
  provider: { kind: SsoProviderKind; role_ceiling: Role; role_ceiling_staff: Role; role_ceiling_customer: Role },
  accountKind: string | null | undefined,
): Role {
  if (provider.kind !== 'hub') return provider.role_ceiling;
  if (accountKind === 'staff') return provider.role_ceiling_staff;
  if (accountKind === 'customer') return provider.role_ceiling_customer;
  // A hub token that did not say which kind of account this is gets the lower of the two.
  return capRole(provider.role_ceiling_staff, provider.role_ceiling_customer);
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

/** What the screens call each role. */
export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: 'Administrator',
  PROJECT_MANAGER: 'Project manager',
  ENGINEER: 'Engineer',
  CUSTOMER: 'Customer',
};

/**
 * The role map as people type it, one per line: `Voxshift Admins = Administrator`. The left side is the value the provider sends in the
 * role claim (a group name, an app role), the right side a role as the screens name it.
 */
export function parseRoleMapText(text: string): { ok: true; map: Record<string, Role> } | { ok: false; error: string } {
  const map: Record<string, Role> = {};
  const byLabel = new Map<string, Role>([
    ...(Object.entries(ROLE_LABELS).map(([role, label]) => [label.toLowerCase(), role as Role]) as [string, Role][]),
    ...(ROLES.map((r) => [r.toLowerCase(), r]) as [string, Role][]),
  ]);
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.lastIndexOf('=');
    const value = at > 0 ? line.slice(0, at).trim() : '';
    const role = at > 0 ? byLabel.get(line.slice(at + 1).trim().toLowerCase().replace(/\s+/g, ' ')) : undefined;
    if (!value || !role) return { ok: false, error: `Line ${i + 1}: write it like  Voxshift Admins = Administrator  (roles: ${Object.values(ROLE_LABELS).join(', ')}).` };
    map[value] = role;
  }
  return { ok: true, map };
}

export function formatRoleMapText(map: Record<string, Role>): string {
  return Object.entries(map).map(([value, role]) => `${value} = ${ROLE_LABELS[role]}`).join('\n');
}

/** Roles in the order a picker shows them: most powerful first. */
export const ROLES_BY_POWER: readonly Role[] = ROLES;

/**
 * A path inside this application, or '/'. Anything else (another site, a scheme, `//host`, a backslash, control characters, something
 * very long) is replaced, so the sign-in flow can never be used as an open redirect.
 */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string') return '/';
  const v = raw.trim();
  if (!v || v.length > 512) return '/';
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return '/';
  // Never come back to the sign-in endpoints themselves (a loop) or to an API path (the person would see JSON).
  if (v.startsWith('/api/')) return '/';
  return v;
}

/**
 * The address the hub's gate serves this installation on, `https://<slug>.<hub domain>`: when a request arrived on a host like that, the
 * redirect URI is that host (the hub registers it as well as the installation's own base URL). Returns the host, or null.
 */
export function hubGateHost(requestHost: string | undefined, hubUrl: string | null): string | null {
  if (!requestHost || !hubUrl) return null;
  let hubHost: string;
  try {
    hubHost = new URL(hubUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const host = requestHost.toLowerCase().replace(/:\d+$/, '');
  if (!host.endsWith(`.${hubHost}`)) return null;
  const label = host.slice(0, -(hubHost.length + 1));
  // exactly one DNS label as the slug
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? host : null;
}

/** The instance id inside a hub instance token (`vxh_<uuid>_<secret>`); it is the client id at the hub. */
export function instanceIdFromHubToken(token: string): string | null {
  const m = /^vxh_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_/.exec(token);
  return m ? m[1]! : null;
}

/* ------------------------------ what the screens use ----------------------------- */

export type SsoProviderKind = 'hub' | 'oidc';

/** `GET /api/auth/providers` (public): only what the login page needs. */
export interface PublicSsoProvider {
  id: string;
  name: string;
  kind: SsoProviderKind;
}
export interface PublicSsoProviders {
  providers: PublicSsoProvider[];
  /** false = the local sign-in form is hidden (break-glass administrators use the "Administrator sign-in" link). */
  localPasswords: boolean;
}

/** A provider as the settings screen shows it. The client secret is never returned, only whether one is set. */
export interface SsoProviderView {
  id: string;
  kind: SsoProviderKind;
  name: string;
  issuer: string;
  clientId: string;
  secretSet: boolean;
  scopes: string;
  enabled: boolean;
  jitCreate: boolean;
  requireMfaClaim: boolean;
  /** 'oidc' providers. */
  roleCeiling: Role;
  /** The hub: Voxshift staff and MSP engineers. */
  roleCeilingStaff: Role;
  /** The hub: the customer's own people with hub accounts. */
  roleCeilingCustomer: Role;
  defaultRole: Role;
  roleClaim: string | null;
  roleMap: Record<string, Role>;
  emailDomains: string[];
  allowLocalPasswords: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestDetail: string | null;
  /** The exact address to register at the provider (its "redirect URI" / "reply URL"). */
  redirectUri: string;
  /** How many people have signed in or been linked through it. */
  identityCount: number;
  /** Hub only: is this installation connected to a hub at all? Without that the hub provider cannot be switched on. */
  hubConnected?: boolean;
}

export interface SsoSettingsView {
  providers: SsoProviderView[];
  sessionMaxHours: number;
  notifyAdminSignin: boolean;
  /** The installation's address as providers must know it. */
  baseUrl: string;
  /** Local passwords are allowed unless an enabled provider switched them off. */
  localPasswords: boolean;
  emailEnabled: boolean;
}

/** A sign-in that was refused because a local account with that email exists. Offered to an administrator to link. */
export interface SsoLinkRequestView {
  id: string;
  providerId: string;
  providerName: string;
  email: string;
  displayName: string | null;
  accountKind: string | null;
  lastSeenAt: string;
  /** Does it match the email of the user being linked? */
  matchesUser?: boolean;
}

export interface SsoIdentityView {
  id: string;
  providerId: string;
  providerName: string;
  subject: string;
  email: string | null;
  lastLoginAt: string | null;
}

/* --------------------------------- inputs ---------------------------------------- */

const roleSchema = z.enum(ROLES);
const urlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
    } catch {
      return false;
    }
  }, 'Enter the provider\'s address starting with https://');
const scopesSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\w:.\-/ ]+$/, 'Scopes are words separated by spaces')
  .refine((v) => v.split(/\s+/).includes('openid'), 'The scopes must include "openid"');
const domainsSchema = z
  .array(z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'Enter a domain such as contoso.com'))
  .max(50)
  .transform((a) => [...new Set(a)]);
const roleMapSchema = z.record(z.string().trim().min(1).max(200), roleSchema).refine((m) => Object.keys(m).length <= 100, 'Too many entries');

const providerFields = {
  name: z.string().trim().min(1).max(60),
  scopes: scopesSchema,
  enabled: z.boolean(),
  jitCreate: z.boolean(),
  requireMfaClaim: z.boolean(),
  roleCeiling: roleSchema,
  roleCeilingStaff: roleSchema,
  roleCeilingCustomer: roleSchema,
  defaultRole: roleSchema,
  roleClaim: z.string().trim().max(100).nullable(),
  roleMap: roleMapSchema,
  emailDomains: domainsSchema,
  allowLocalPasswords: z.boolean(),
};

/** Adding a customer's own provider. The secret is required here and never shown again. */
export const createSsoProviderSchema = z
  .object({
    name: providerFields.name,
    issuer: urlSchema,
    clientId: z.string().trim().min(1).max(300),
    clientSecret: z.string().min(1).max(2000),
    scopes: providerFields.scopes.optional(),
    jitCreate: providerFields.jitCreate.optional(),
    requireMfaClaim: providerFields.requireMfaClaim.optional(),
    roleCeiling: providerFields.roleCeiling.optional(),
    defaultRole: providerFields.defaultRole.optional(),
    roleClaim: providerFields.roleClaim.optional(),
    roleMap: providerFields.roleMap.optional(),
    emailDomains: providerFields.emailDomains.optional(),
    allowLocalPasswords: providerFields.allowLocalPasswords.optional(),
  })
  .strict();
export type CreateSsoProviderInput = z.infer<typeof createSsoProviderSchema>;

/** Changing a provider. Every field is optional; a new `clientSecret` replaces the stored one, leaving it out keeps it. The hub's address, id and secret come from the hub connection and cannot be changed here. */
export const updateSsoProviderSchema = z
  .object({
    issuer: urlSchema,
    clientId: z.string().trim().min(1).max(300),
    clientSecret: z.string().min(1).max(2000),
    ...providerFields,
  })
  .partial()
  .strict();
export type UpdateSsoProviderInput = z.infer<typeof updateSsoProviderSchema>;

export const ssoGeneralSettingsSchema = z
  .object({
    sessionMaxHours: z.number().int().min(1).max(720),
    notifyAdminSignin: z.boolean(),
  })
  .partial()
  .strict();
export type SsoGeneralSettingsInput = z.infer<typeof ssoGeneralSettingsSchema>;

/** Link a local user to a person at a provider: pick a waiting sign-in, or give the provider's subject id. */
export const linkIdentitySchema = z.union([
  z.object({ requestId: z.string().uuid() }).strict(),
  z.object({ providerId: z.string().uuid(), subject: z.string().trim().min(1).max(300) }).strict(),
]);
export type LinkIdentityInput = z.infer<typeof linkIdentitySchema>;

/* ----------------------------- refusals, in plain words ---------------------------- */

/**
 * Why a sign-in was refused, as a short code the login page can show. The detailed reason (never a token) goes to the audit log; these
 * are the only things put in the address of the page the person lands on.
 */
export const SSO_PUBLIC_ERRORS = {
  failed: 'Single sign-on did not complete. Try again, or sign in another way.',
  provider_off: 'Single sign-on with this provider is switched off for this installation.',
  mfa_required: 'Your provider did not confirm two-step verification (MFA) for this sign-in, which this installation requires. Turn on MFA for your account at the provider and try again.',
  no_email: 'Your provider did not give a verified email address, so you cannot be signed in. Ask your administrator.',
  domain: 'Your email address is not from a domain this installation accepts for this provider.',
  no_account: 'You do not have an account on this installation yet, and automatic account creation is off. Ask an administrator to set one up.',
  email_exists: 'An account with your email address already exists here but is not linked to this sign-in. Ask an administrator to link it (Users > Link to provider identity).',
  disabled: 'This account is switched off. Ask an administrator.',
  local_only: 'This account signs in with a password and authenticator on this installation, not through a provider.',
} as const;
export type SsoPublicError = keyof typeof SSO_PUBLIC_ERRORS;

export function isSsoPublicError(v: unknown): v is SsoPublicError {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(SSO_PUBLIC_ERRORS, v);
}
