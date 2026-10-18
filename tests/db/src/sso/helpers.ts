import { randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import * as argon2 from 'argon2';
import { platformDb, FEDERATED_PASSWORD_HASH, type DbHandle } from '@tvmf/db';
import type { Role } from '@tvmf/shared';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { encryptSecret } from '../../../../apps/api/src/common/crypto';
import type { AppConfig } from '../../../../apps/api/src/common/config';
import { AuthService } from '../../../../apps/api/src/auth/auth.service';
import { TokenService } from '../../../../apps/api/src/auth/token.service';
import { TotpService } from '../../../../apps/api/src/auth/totp.service';

export const TEST_CONFIG = {
  NODE_ENV: 'test',
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef',
  JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef',
  ACCESS_TOKEN_TTL: 900,
  REFRESH_TOKEN_TTL: 60 * 60 * 24 * 30,
  WEB_ORIGIN: 'https://voxshift.test',
  COOKIE_SECURE: false,
  COOKIE_DOMAIN: '',
  TOTP_ISSUER: 'Voxshift',
  REFRESH_COOKIE: 'tvmf_rt',
} as unknown as AppConfig;

/** The real sign-in services, built on a test database. */
export function makeAuth(handle: DbHandle, cfg: AppConfig = TEST_CONFIG) {
  const audit = new AuditService(handle.db);
  const tokens = new TokenService(cfg, handle.db);
  const totp = new TotpService(cfg);
  const auth = new AuthService(handle.db, tokens, totp, audit);
  return { audit, tokens, totp, auth, cfg };
}

export const PASSWORD = 'correct horse battery staple 42';

/** A user who can sign in locally with a password and an authenticator. Returns what is needed to do it. */
export async function seedLocalUser(handle: DbHandle, role: Role, opts: { breakGlass?: boolean; email?: string } = {}) {
  const id = randomUUID();
  const email = opts.email ?? `${role.toLowerCase()}-${id.slice(0, 8)}@local.test`;
  const secret = authenticator.generateSecret();
  const db = platformDb(handle.db);
  await db
    .insertInto('users')
    .values({
      id,
      email,
      password_hash: await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 1024, timeCost: 2, parallelism: 1 }),
      display_name: email,
      role,
      totp_enrolled: true,
      break_glass: opts.breakGlass ?? false,
    })
    .execute();
  await db.insertInto('totp_secrets').values({ user_id: id, secret_enc: encryptSecret(secret), pending_secret_enc: null, confirmed_at: new Date().toISOString() }).execute();
  return { id, email, code: () => authenticator.generate(secret) };
}

/** A user that exists only through a provider. */
export async function seedFederatedUser(handle: DbHandle, role: Role, email = `fed-${randomUUID().slice(0, 8)}@fed.test`) {
  const id = randomUUID();
  await platformDb(handle.db).insertInto('users').values({ id, email, password_hash: FEDERATED_PASSWORD_HASH, display_name: email, role, totp_enrolled: false }).execute();
  return { id, email };
}

/* ----------------------------- the single sign-on services ----------------------------- */

import { randomBytes } from 'node:crypto';
import type { MailService } from '../../../../apps/api/src/mail/mail.service';
import { JwksCache } from '../../../../apps/api/src/sso/oidc/jwks-cache';
import { OidcClient } from '../../../../apps/api/src/sso/oidc/oidc-client';
import { SsoProvidersService } from '../../../../apps/api/src/sso/sso-providers.service';
import { SsoSignInService } from '../../../../apps/api/src/sso/sso-signin.service';
import type { FakePerson, FakeProvider, TokenTweaks } from './fake-provider';

export interface MailedMessage { template: string; to: { email: string }; context: Record<string, unknown> }

/** The real sign-in and provider services on a test database; mail is captured instead of queued. */
export function makeSso(handle: DbHandle, cfgOver: Partial<AppConfig> = {}) {
  const cfg = { ...TEST_CONFIG, ...cfgOver } as AppConfig;
  const base = makeAuth(handle, cfg);
  const mailed: MailedMessage[] = [];
  const mail = { enqueue: async (m: MailedMessage) => (mailed.push(m), { id: 'queued' }) } as unknown as MailService;
  // no cooldown: the tests rotate keys on purpose
  const oidc = new OidcClient({ jwks: new JwksCache({ refreshCooldownMs: 0 }) });
  const signIn = new SsoSignInService(handle.db, cfg, oidc, base.auth, base.audit, mail);
  const providers = new SsoProvidersService(handle.db, cfg, oidc, base.audit);
  return { ...base, cfg, mailed, oidc, signIn, providers };
}
export type Sso = ReturnType<typeof makeSso>;

export const META = { ip: '203.0.113.9', userAgent: 'vitest' };

/** A customer's own OpenID Connect provider (kind oidc) pointing at the fake one, switched on. */
export async function addOidcProvider(
  handle: DbHandle,
  fake: FakeProvider,
  over: Partial<{ name: string; enabled: boolean; jit_create: boolean; require_mfa_claim: boolean; role_ceiling: Role; default_role: Role; role_claim: string | null; role_map: Record<string, Role>; email_domains: string[]; allow_local_passwords: boolean }> = {},
) {
  const row = await platformDb(handle.db)
    .insertInto('sso_providers')
    .values({
      kind: 'oidc',
      name: over.name ?? `Fake ${randomUUID().slice(0, 8)}`,
      issuer: fake.issuer,
      client_id: fake.clientId,
      client_secret_enc: encryptSecret(fake.clientSecret),
      enabled: over.enabled ?? true,
      jit_create: over.jit_create ?? true,
      require_mfa_claim: over.require_mfa_claim ?? true,
      role_ceiling: over.role_ceiling ?? 'PROJECT_MANAGER',
      default_role: over.default_role ?? 'ENGINEER',
      role_claim: over.role_claim ?? null,
      role_map: JSON.stringify(over.role_map ?? {}),
      email_domains: over.email_domains ?? [],
      allow_local_passwords: over.allow_local_passwords ?? true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** A person signs in end to end: the browser is sent to the provider, the person signs in there, the browser comes back. */
export async function signInAs(sso: Sso, providerId: string, fake: FakeProvider, person: FakePerson, tweaks: TokenTweaks = {}, opts: { requestHost?: string; testBy?: string; tamper?: (cb: { code: string; state: string }) => { code: string; state: string } } = {}) {
  const begun = await sso.signIn.begin({ providerId, requestHost: opts.requestHost, testBy: opts.testBy, meta: META });
  if (!begun.ok) return { begun, result: undefined as never };
  const cb = fake.authorize(begun.redirectUrl, person, tweaks);
  const sent = opts.tamper ? opts.tamper(cb) : cb;
  const result = await sso.signIn.complete({ code: sent.code, state: sent.state, stateCookie: begun.stateCookie, meta: META });
  return { begun, cb, result };
}

export const newSub = () => `sub-${randomBytes(6).toString('hex')}`;
export const newEmail = (tag = 'p') => `${tag}-${randomBytes(4).toString('hex')}@idp.test`;

/** A hub instance token for a fake hub: the client id is the instance id. */
export function hubCredentials() {
  const id = randomUUID();
  return { clientId: id, clientSecret: `vxh_${id}_${randomBytes(24).toString('hex')}` };
}
