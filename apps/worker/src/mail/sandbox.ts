import type { Kysely } from 'kysely';
import { platformDb, type DB } from '@tvmf/db';
import { sandboxRedirect } from '@tvmf/shared';

/**
 * Test customers (`platform.tenants.sandbox`, docs/EMAIL.md): decided here, at
 * send time, so it covers every template, every producer (API and worker) and
 * every resend. Real customers are untouched.
 */

export interface MailRowForDelivery {
  to_email: string;
  to_name: string | null;
  tenant_id: string | null;
  created_by: string | null;
  /** set once a test-customer email has been redirected (to_email is then where it went) */
  original_to_email: string | null;
}

export type Delivery =
  | {
      action: 'send';
      to: string;
      toName: string | null;
      subject: string;
      /** the real recipient when this was redirected (stored on the row), else null */
      originalTo: string | null;
    }
  | { action: 'skip'; reason: string; originalTo: string };

/** Where (and with what subject) one email should actually go. */
export async function planDelivery(db: Kysely<DB>, row: MailRowForDelivery, subject: string): Promise<Delivery> {
  // A resend of a redirected email starts again from the real recipient, so
  // turning "test customer" off and resending reaches them.
  const originalTo = row.original_to_email ?? row.to_email;
  const tenant = row.tenant_id
    ? await platformDb(db).selectFrom('tenants').select(['sandbox', 'sandbox_email']).where('id', '=', row.tenant_id).executeTakeFirst()
    : undefined;
  if (!tenant?.sandbox) {
    return { action: 'send', to: originalTo, toName: row.to_name, subject, originalTo: null };
  }

  const trigger = row.created_by
    ? await platformDb(db).selectFrom('users').select(['email', 'display_name']).where('id', '=', row.created_by).executeTakeFirst()
    : undefined;
  const r = sandboxRedirect({
    originalTo,
    triggeredBy: trigger ? { email: trigger.email, name: trigger.display_name } : null,
    fallbackEmail: tenant.sandbox_email,
  });
  if (r.action === 'skip') return { action: 'skip', reason: r.reason, originalTo };
  return { action: 'send', to: r.to, toName: r.toName, subject: `${r.subjectPrefix} ${subject}`, originalTo };
}
