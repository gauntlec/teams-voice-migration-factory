import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { platformDb } from '@tvmf/db';
import type { Me } from '@tvmf/shared';
import { AuditService } from '../common/audit.service';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { InjectDb, type Db } from '../db/db.module';
import { TokenService } from './token.service';
import { TotpService } from './totp.service';

const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
const MAX_FAILED = 10;
const LOCK_MINUTES = 15;

interface Meta {
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly tokens: TokenService,
    private readonly totp: TotpService,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string, totpCode: string | undefined, meta: Meta) {
    const user = await platformDb(this.db)
      .selectFrom('users')
      .selectAll()
      .where('email', '=', email)
      .executeTakeFirst();

    // Uniform failure to avoid user enumeration.
    const fail = async (reason: string) => {
      await this.audit.platform('auth.login.failed', {
        actor: { email, ip: meta.ip },
        detail: { reason },
      });
      throw new UnauthorizedException('Invalid credentials');
    };

    if (!user) {
      await argon2.hash(password, ARGON).catch(() => undefined); // timing padding
      return fail('unknown-user');
    }
    if (user.status !== 'active') return fail('disabled');
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      return fail('locked');
    }

    const ok = await argon2.verify(user.password_hash, password).catch(() => false);
    if (!ok) {
      const failed = user.failed_logins + 1;
      await platformDb(this.db)
        .updateTable('users')
        .set({
          failed_logins: failed,
          locked_until:
            failed >= MAX_FAILED
              ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString()
              : null,
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', user.id)
        .execute();
      return fail('bad-password');
    }

    if (user.failed_logins > 0) {
      await platformDb(this.db)
        .updateTable('users')
        .set({ failed_logins: 0, locked_until: null, updated_at: new Date().toISOString() })
        .where('id', '=', user.id)
        .execute();
    }

    if (!user.totp_enrolled) {
      const { token } = this.tokens.signAccess({
        sub: user.id,
        role: user.role,
        email: user.email,
        typ: 'enrol',
      });
      await this.audit.platform('auth.login.enrol_required', {
        actor: { id: user.id, email: user.email, ip: meta.ip },
      });
      return { enrolRequired: true as const, accessToken: token };
    }

    if (!totpCode) throw new UnauthorizedException('MFA code required');
    const secretRow = await platformDb(this.db)
      .selectFrom('totp_secrets')
      .select('secret_enc')
      .where('user_id', '=', user.id)
      .executeTakeFirst();
    if (!secretRow || !this.totp.verify(totpCode, decryptSecret(secretRow.secret_enc))) {
      return fail('bad-totp');
    }

    return this.issueLogin(user.id, user.role, user.email, meta);
  }

  async beginTotpEnrol(userId: string, email: string) {
    const secret = this.totp.generateSecret();
    await platformDb(this.db)
      .insertInto('totp_secrets')
      .values({ user_id: userId, secret_enc: encryptSecret(secret), confirmed_at: null })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({ secret_enc: encryptSecret(secret), confirmed_at: null }),
      )
      .execute();
    return { secret, otpauthUrl: this.totp.otpauthUrl(email, secret) };
  }

  async confirmTotpEnrol(userId: string, role: string, email: string, code: string, meta: Meta) {
    const row = await platformDb(this.db)
      .selectFrom('totp_secrets')
      .select('secret_enc')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!row || !this.totp.verify(code, decryptSecret(row.secret_enc))) {
      throw new UnauthorizedException('Incorrect code');
    }
    await platformDb(this.db)
      .updateTable('totp_secrets')
      .set({ confirmed_at: new Date().toISOString() })
      .where('user_id', '=', userId)
      .execute();
    await platformDb(this.db)
      .updateTable('users')
      .set({ totp_enrolled: true, updated_at: new Date().toISOString() })
      .where('id', '=', userId)
      .execute();
    await this.audit.platform('auth.totp.enrolled', { actor: { id: userId, email, ip: meta.ip } });
    return this.issueLogin(userId, role, email, meta);
  }

  async refresh(cookieValue: string, meta: Meta) {
    const rotated = await this.tokens.rotate(cookieValue, meta);
    const user = await platformDb(this.db)
      .selectFrom('users')
      .select(['id', 'role', 'email', 'status'])
      .where('id', '=', rotated.userId)
      .executeTakeFirst();
    if (!user || user.status !== 'active') throw new ForbiddenException('Account unavailable');
    const access = this.tokens.signAccess({
      sub: user.id,
      role: user.role,
      email: user.email,
      typ: 'access',
    });
    return {
      accessToken: access.token,
      accessExpiresIn: access.expiresIn,
      refreshCookieValue: rotated.cookieValue,
      refreshExpiresAt: rotated.expiresAt,
    };
  }

  async logout(cookieValue: string | undefined) {
    if (cookieValue) await this.tokens.revoke(cookieValue);
  }

  async me(userId: string): Promise<Me> {
    const user = await platformDb(this.db)
      .selectFrom('users')
      .select(['id', 'email', 'display_name', 'role', 'totp_enrolled'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

    let tenants: Me['tenants'];
    if (user.role === 'SUPER_ADMIN') {
      tenants = await platformDb(this.db)
        .selectFrom('tenants')
        .select(['id', 'slug', 'name'])
        .where('status', '=', 'active')
        .orderBy('name')
        .execute();
    } else {
      tenants = await platformDb(this.db)
        .selectFrom('tenant_memberships as m')
        .innerJoin('tenants as t', 't.id', 'm.tenant_id')
        .select(['t.id as id', 't.slug as slug', 't.name as name'])
        .where('m.user_id', '=', userId)
        .where('t.status', '=', 'active')
        .orderBy('t.name')
        .execute();
    }

    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      totpEnrolled: user.totp_enrolled,
      tenants,
    };
  }

  private async issueLogin(userId: string, role: string, email: string, meta: Meta) {
    const access = this.tokens.signAccess({ sub: userId, role, email, typ: 'access' });
    const session = await this.tokens.issueSession(userId, meta);
    await this.audit.platform('auth.login.ok', { actor: { id: userId, email, ip: meta.ip } });
    return {
      enrolRequired: false as const,
      accessToken: access.token,
      accessExpiresIn: access.expiresIn,
      refreshCookieValue: session.cookieValue,
      refreshExpiresAt: session.expiresAt,
    };
  }
}
