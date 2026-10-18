import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../common/config';
import { sha256 } from '../common/crypto';
import { InjectDb, type Db } from '../db/db.module';
import { platformDb } from '@tvmf/db';

export interface AccessPayload {
  sub: string;
  role: string;
  email: string;
  /**
   * access  -> full session token
   * enrol   -> limited: may only complete TOTP enrolment
   * pwreset -> limited: may only set a new password (forced first sign-in)
   */
  typ: 'access' | 'enrol' | 'pwreset';
  /** Set when the session came from a single sign-on provider (the provider's id): the provider did the multi-factor step, so local TOTP is not asked. */
  idp?: string;
  /** The authentication methods the provider reported. */
  amr?: string[];
}

/** What a federated session carries from its first sign-in through every refresh. */
export interface FederatedSession {
  idp: string;
  amr: string[];
  /** The session ends here whatever refreshing does. */
  absoluteExpiresAt: Date;
}

export interface IssuedTokens {
  accessToken: string;
  accessExpiresIn: number;
  refreshCookieValue: string;
  refreshExpiresAt: Date;
}

@Injectable()
export class TokenService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectDb() private readonly db: Db,
  ) {}

  signAccess(payload: AccessPayload): { token: string; expiresIn: number } {
    const expiresIn = payload.typ === 'access' ? this.cfg.ACCESS_TOKEN_TTL : 600;
    const token = jwt.sign(payload, this.cfg.JWT_ACCESS_SECRET, {
      expiresIn,
      issuer: 'tvmf',
    });
    return { token, expiresIn };
  }

  verifyAccess(token: string): AccessPayload {
    try {
      return jwt.verify(token, this.cfg.JWT_ACCESS_SECRET, { issuer: 'tvmf' }) as AccessPayload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  /** Creates a new session row and returns the cookie value `${sessionId}.${secret}`. */
  async issueSession(
    userId: string,
    meta: { userAgent?: string; ip?: string; familyId?: string; federated?: FederatedSession },
  ): Promise<{ cookieValue: string; expiresAt: Date }> {
    const secret = randomBytes(32).toString('base64url');
    const familyId = meta.familyId ?? randomUUID();
    let expiresAt = new Date(Date.now() + this.cfg.REFRESH_TOKEN_TTL * 1000);
    // A federated session never outlives its absolute end: the person signs in at the provider again.
    if (meta.federated && meta.federated.absoluteExpiresAt < expiresAt) expiresAt = meta.federated.absoluteExpiresAt;
    const row = await platformDb(this.db)
      .insertInto('auth_sessions')
      .values({
        user_id: userId,
        refresh_hash: sha256(secret),
        family_id: familyId,
        user_agent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
        expires_at: expiresAt.toISOString(),
        amr: meta.federated?.amr ?? [],
        idp: meta.federated?.idp ?? null,
        absolute_expires_at: meta.federated?.absoluteExpiresAt.toISOString() ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { cookieValue: `${row.id}.${secret}`, expiresAt };
  }

  /**
   * Validates a refresh cookie, rotates it, and returns the user id.
   * Detects token reuse and revokes the whole family.
   */
  async rotate(
    cookieValue: string,
    meta: { userAgent?: string; ip?: string },
  ): Promise<{ userId: string; cookieValue: string; expiresAt: Date; familyId: string; federated: FederatedSession | null }> {
    const [sessionId, secret] = cookieValue.split('.');
    if (!sessionId || !secret) throw new UnauthorizedException('No session');

    const session = await platformDb(this.db)
      .selectFrom('auth_sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .executeTakeFirst();
    if (!session) throw new UnauthorizedException('Unknown session');

    const presentedHash = sha256(secret);
    if (session.revoked_at || presentedHash !== session.refresh_hash) {
      // reuse / tampering -> nuke the family
      await platformDb(this.db)
        .updateTable('auth_sessions')
        .set({ revoked_at: new Date().toISOString() })
        .where('family_id', '=', session.family_id)
        .where('revoked_at', 'is', null)
        .execute();
      throw new UnauthorizedException('Session invalidated');
    }
    if (new Date(session.expires_at).getTime() < Date.now()) {
      throw new UnauthorizedException('Session expired');
    }
    const federated: FederatedSession | null =
      session.idp && session.absolute_expires_at
        ? { idp: session.idp, amr: session.amr, absoluteExpiresAt: new Date(session.absolute_expires_at) }
        : null;
    if (federated && federated.absoluteExpiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Session expired');
    }

    const next = await this.issueSession(session.user_id, { ...meta, familyId: session.family_id, federated: federated ?? undefined });
    const [nextId] = next.cookieValue.split('.');
    await platformDb(this.db)
      .updateTable('auth_sessions')
      .set({ revoked_at: new Date().toISOString(), replaced_by: nextId! })
      .where('id', '=', sessionId)
      .execute();

    return { userId: session.user_id, cookieValue: next.cookieValue, expiresAt: next.expiresAt, familyId: session.family_id, federated };
  }

  /** Ends every session of a family (a sign-in and everything it was refreshed into). */
  async revokeFamily(familyId: string): Promise<void> {
    await platformDb(this.db)
      .updateTable('auth_sessions')
      .set({ revoked_at: new Date().toISOString() })
      .where('family_id', '=', familyId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  async revoke(cookieValue: string): Promise<void> {
    const [sessionId] = cookieValue.split('.');
    if (!sessionId) return;
    await platformDb(this.db)
      .updateTable('auth_sessions')
      .set({ revoked_at: new Date().toISOString() })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();
  }
}
