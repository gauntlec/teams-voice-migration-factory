import { sql, type Kysely } from 'kysely';
import { platformDb, type DB } from '@tvmf/db';
import { MSP_NOTIFY_MAX_ATTEMPTS, isTeamsWebhookUrl, mspNotifyBackoffSeconds, mspNotifyEnabled, teamsPayload, type MspNotifyCard, type MspNotifyConfig, type MspNotifyKind } from '@tvmf/shared';
import { decryptSecret } from './crypto';

/** Queues a note for the MSP's Teams channel from the worker (the same outbox the API uses): only if the MSP has a channel and wants this kind. */
export async function queueMspNotification(db: Kysely<DB>, tenantId: string, kind: Exclude<MspNotifyKind, 'test'>, card: MspNotifyCard): Promise<boolean> {
  const p = platformDb(db);
  const row = await p
    .selectFrom('tenants as t')
    .innerJoin('msps as m', 'm.id', 't.msp_id')
    .select(['m.id as msp_id', 'm.teams_webhook_enc as hook', 'm.teams_notify as notify'])
    .where('t.id', '=', tenantId)
    .executeTakeFirst();
  if (!row?.hook || !mspNotifyEnabled(row.notify as Partial<MspNotifyConfig>, kind)) return false;
  await p.insertInto('msp_notifications').values({ msp_id: row.msp_id, tenant_id: tenantId, kind, card: JSON.stringify(card) }).execute();
  return true;
}

/**
 * Posts what is waiting in the outbox to the MSPs' Teams channels (docs/INTAKE.md), every 15 seconds. The address is decrypted only here,
 * and checked again to be a Microsoft webhook before anything is sent. A failure is retried with a growing delay, then given up on;
 * nothing here can hold up an incident.
 */
export async function deliverMspNotifications(db: Kysely<DB>, post: typeof fetch = fetch, opts: { limit?: number } = {}): Promise<{ sent: number; failed: number }> {
  const p = platformDb(db);
  const due = await p
    .selectFrom('msp_notifications as n')
    .innerJoin('msps as m', 'm.id', 'n.msp_id')
    .select(['n.id as id', 'n.card as card', 'n.attempts as attempts', 'm.teams_webhook_enc as hook'])
    .where('n.status', '=', 'queued')
    .where('n.next_attempt_at', '<=', sql<string>`now()`)
    .orderBy('n.created_at')
    .limit(opts.limit ?? 20)
    .execute();
  const out = { sent: 0, failed: 0 };
  for (const n of due) {
    // Claim it first, so two workers never post it twice.
    const claimed = await p.updateTable('msp_notifications').set({ attempts: n.attempts + 1, next_attempt_at: new Date(Date.now() + 60_000).toISOString() }).where('id', '=', n.id).where('attempts', '=', n.attempts).where('status', '=', 'queued').returning('id').executeTakeFirst();
    if (!claimed) continue;
    const fail = async (error: string, final = false) => {
      out.failed++;
      const attempts = n.attempts + 1;
      const giveUp = final || attempts >= MSP_NOTIFY_MAX_ATTEMPTS;
      await p
        .updateTable('msp_notifications')
        .set({ status: giveUp ? 'failed' : 'queued', error: error.slice(0, 300), next_attempt_at: new Date(Date.now() + mspNotifyBackoffSeconds(attempts) * 1000).toISOString() })
        .where('id', '=', n.id)
        .execute();
    };
    if (!n.hook) {
      await fail('The Teams channel has been disconnected.', true);
      continue;
    }
    let url: string;
    try {
      url = decryptSecret(n.hook);
    } catch {
      await fail('The stored Teams address could not be read.', true);
      continue;
    }
    if (!isTeamsWebhookUrl(url)) {
      await fail('The stored address is not a Microsoft Teams webhook.', true);
      continue;
    }
    try {
      const res = await post(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(teamsPayload(n.card as MspNotifyCard)), signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (res.ok) {
        await p.updateTable('msp_notifications').set({ status: 'sent', sent_at: new Date().toISOString(), error: null }).where('id', '=', n.id).execute();
        out.sent++;
      } else await fail(`Teams answered ${res.status}.`);
    } catch (e) {
      await fail(`Could not reach Teams: ${(e as Error).message}`);
    }
  }
  return out;
}
