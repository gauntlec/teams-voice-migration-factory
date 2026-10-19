import { sql, type Kysely } from 'kysely';
import { platformDb, type DB } from '@tvmf/db';
import { decryptSecret } from '../crypto';

/**
 * The one-time password in a `user_invitation` email.
 *
 * The API stores it encrypted (`context.tempPasswordEnc`, AES-256-GCM with DATA_ENCRYPTION_KEY) only so the worker can put it in the
 * email. Once the message has been handled for good (sent, skipped, failed for good) the worker deletes it and leaves
 * `tempPasswordRemoved: true`, so `platform.email_messages` never keeps a usable password. The admin who created or re-sent the
 * invitation already saw the password once in the Users screen; a lost one is replaced with "Resend invitation", never recovered.
 */

/** The marker left in `context` once the password has been removed. */
export const PASSWORD_REMOVED_KEY = 'tempPasswordRemoved';

/**
 * The context to render from: the encrypted password turned back into `tempPassword`. A plain `tempPassword` already in the context
 * (a row queued by an older release, before the upgrade that stopped storing it) is used as it is and scrubbed after delivery.
 */
export function contextForRender(context: Record<string, unknown> | null): Record<string, unknown> {
  const c: Record<string, unknown> = { ...(context ?? {}) };
  if (typeof c.tempPasswordEnc === 'string') c.tempPassword = decryptSecret(c.tempPasswordEnc);
  delete c.tempPasswordEnc;
  return c;
}

/** True when an invitation has no password left to send (it was removed after delivery). */
export function invitationPasswordMissing(template: string, rendered: Record<string, unknown>): boolean {
  return template === 'user_invitation' && typeof rendered.tempPassword !== 'string';
}

/** The text of an email for a log line, with any one-time password hidden. */
export function maskSecrets(text: string, rendered: Record<string, unknown>): string {
  const pw = rendered.tempPassword;
  return typeof pw === 'string' && pw.length > 0 ? text.split(pw).join('[hidden]') : text;
}

/** Remove the password (encrypted or plain) from a message's context and leave the marker. Safe to call twice. */
export async function removeInvitationPassword(db: Kysely<DB>, id: string): Promise<void> {
  await platformDb(db)
    .updateTable('email_messages')
    .set({
      context: sql`(coalesce(context, '{}'::jsonb) - 'tempPassword' - 'tempPasswordEnc') || ${JSON.stringify({ [PASSWORD_REMOVED_KEY]: true })}::jsonb`,
    })
    .where('id', '=', id)
    .where('template', '=', 'user_invitation')
    .execute();
}
