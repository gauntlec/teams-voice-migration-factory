import type { Kysely } from 'kysely';
import { platformDb, type DB } from '@tvmf/db';

/**
 * Deleting a customer (apps/api/src/tenants/tenant-deletion.service.ts) needs two things from the worker, because the worker is
 * the only place a customer's Microsoft Teams sign-in lives (in memory, in a PowerShell process; nothing is saved):
 *
 *  1. `tenant.release` - close every open sign-in belonging to that customer's schema, so nothing stays signed in to the
 *     customer's Microsoft tenant after the customer is gone. A sign-in that was still being entered fails by itself.
 *  2. Refuse any job for a customer that is being deleted (or is already gone), so a job that was queued a moment earlier cannot
 *     start a new sign-in or write into a schema that is about to be dropped.
 */

export interface Disposable {
  dispose(): Promise<void>;
}

/** Closes and forgets every open sign-in of one customer's schema. Returns how many were closed. */
export async function releaseTenantSessions(
  executors: Map<string, Disposable>,
  executorSchema: Map<string, string>,
  schema: string,
): Promise<number> {
  let closed = 0;
  for (const [connectionId, s] of [...executorSchema]) {
    if (s !== schema) continue;
    const exec = executors.get(connectionId);
    executors.delete(connectionId);
    executorSchema.delete(connectionId);
    if (exec) {
      await exec.dispose().catch(() => undefined);
      closed += 1;
    }
  }
  return closed;
}

/** Thrown for a job that must not run. BullMQ's UnrecoverableError (no retries) is applied by the caller. */
export class CustomerBeingDeletedError extends Error {}

/**
 * Throws when the job's customer is being deleted or no longer exists. Jobs without a customer in their data are let through.
 */
export async function refuseJobForDeletedCustomer(db: Kysely<DB>, data: unknown): Promise<void> {
  const tenantId = (data as { tenantId?: string } | null)?.tenantId;
  if (!tenantId) return;
  const row = await platformDb(db).selectFrom('tenants').select('status').where('id', '=', tenantId).executeTakeFirst();
  if (!row) throw new CustomerBeingDeletedError('This customer no longer exists.');
  if (row.status === 'deleting') throw new CustomerBeingDeletedError('This customer is being deleted.');
}
