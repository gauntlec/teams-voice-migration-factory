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
