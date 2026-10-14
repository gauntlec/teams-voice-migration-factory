import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { platformDb } from '@tvmf/db';
import { REPLY_TOKEN_DAYS, inboundReplyAddress } from '@tvmf/shared';
import { APP_CONFIG, type AppConfig } from '../../common/config';
import { InjectDb, type Db } from '../../db/db.module';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** 26 lower-case base32 characters (130 bits): survives a mail system lower-casing the address, and cannot be guessed. */
function newToken(): string {
  const bytes = randomBytes(26);
  let out = '';
  for (const b of bytes) out += B32[b % 32];
  return out;
}

/**
 * Reply addresses (docs/INTAKE.md): an email about an incident carries `Reply-To: incidents+<token>@…`, one token per incident per
 * recipient. A reply to it is that person commenting on that incident: the token is the credential, and it is tied to one person, so
 * forwarding the email to someone else does not let them comment as the recipient. Off unless INBOUND_EMAIL_ADDRESS is set.
 */
@Injectable()
export class InboundReplyService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  enabled(): boolean {
    return !!this.cfg.INBOUND_EMAIL_ADDRESS;
  }

  /** The address to reply to for this person on this incident (a token is made once and kept), or nothing when inbound email is off. */
  async replyTo(tenantId: string, incidentId: string, userId: string): Promise<string | undefined> {
    if (!this.enabled()) return undefined;
    const p = platformDb(this.db);
    const now = new Date();
    const existing = await p.selectFrom('inbound_reply_tokens').select(['token', 'expires_at']).where('incident_id', '=', incidentId).where('user_id', '=', userId).executeTakeFirst();
    const expires = new Date(now.getTime() + REPLY_TOKEN_DAYS * 86_400_000).toISOString();
    if (existing) {
      // Every email pushes the expiry out: a conversation that is still going keeps working.
      await p.updateTable('inbound_reply_tokens').set({ expires_at: expires }).where('token', '=', existing.token).execute();
      return inboundReplyAddress(this.cfg.INBOUND_EMAIL_ADDRESS, existing.token);
    }
    const token = newToken();
    await p
      .insertInto('inbound_reply_tokens')
      .values({ token, tenant_id: tenantId, incident_id: incidentId, user_id: userId, expires_at: expires })
      .onConflict((oc) => oc.columns(['incident_id', 'user_id']).doNothing())
      .execute();
    const row = await p.selectFrom('inbound_reply_tokens').select('token').where('incident_id', '=', incidentId).where('user_id', '=', userId).executeTakeFirstOrThrow();
    return inboundReplyAddress(this.cfg.INBOUND_EMAIL_ADDRESS, row.token);
  }

  async lookup(token: string) {
    return platformDb(this.db).selectFrom('inbound_reply_tokens').selectAll().where('token', '=', token).where('expires_at', '>', new Date().toISOString()).executeTakeFirst();
  }
}
