import type { Kysely } from 'kysely';
import type { DB } from './schema';

/**
 * Writes one row of the platform audit log from code that has no `AuditService` (the worker, and database helpers shared with the API).
 * `detail` must hold no secret, token or code.
 */
export async function writePlatformAudit(
  db: Kysely<DB>,
  e: { action: string; actorUserId?: string | null; actorEmail?: string | null; targetType?: string; targetId?: string; detail?: Record<string, unknown>; at?: Date },
): Promise<void> {
  await db
    .withSchema('platform')
    .insertInto('platform_audit_log')
    .values({
      action: e.action,
      actor_user_id: e.actorUserId ?? null,
      actor_email: e.actorEmail ?? null,
      target_type: e.targetType ?? null,
      target_id: e.targetId ?? null,
      tenant_id: null,
      ip: null,
      detail: (e.detail ?? {}) as object,
      ...(e.at ? { at: e.at.toISOString() } : {}),
    })
    .execute();
}
