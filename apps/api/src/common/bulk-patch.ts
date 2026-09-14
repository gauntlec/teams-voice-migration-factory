import { sql } from 'kysely';
import { tenantDb } from '@tvmf/db';
import type { AuditActor, AuditService } from './audit.service';

type Scoped = ReturnType<typeof tenantDb>;

/**
 * Shared core of every "select many rows, set a handful of fields once,
 * apply to all of them in one request" bulk-edit action - Design & Build's
 * Users/CAPs and Data Collection's Users/CAPs both funnel through this. One
 * implementation, so a fix or improvement here (chunking very large id
 * lists, the merge behaviour, the audit shape, …) lands in every module at
 * once instead of drifting between hand-copied versions.
 *
 * `jsonbMergeKeys` names patch keys backed by a jsonb column where a bulk
 * patch must merge into the existing value rather than replace it wholesale
 * (Design & Build's policy_ids/policies/voicemail - one touched sub-key
 * shouldn't wipe the rest). Most callers pass none.
 */
export async function applyBulkPatch(
  scoped: Scoped,
  table: string,
  ids: string[],
  patch: Record<string, unknown>,
  jsonbMergeKeys: string[] = [],
): Promise<{ updated: number; appliedPatch: Record<string, unknown> }> {
  const appliedPatch: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };
  for (const key of jsonbMergeKeys) {
    if (key in appliedPatch) {
      appliedPatch[key] = sql`${sql.ref(key)} || ${JSON.stringify(appliedPatch[key])}::jsonb`;
    }
  }
  const result = await (scoped as never as { updateTable: (t: string) => any })
    .updateTable(table)
    .set(appliedPatch)
    .where('id', 'in', ids)
    .executeTakeFirst();
  return { updated: Number(result?.numUpdatedRows ?? 0), appliedPatch };
}

/**
 * The one summary audit row every bulk-patch caller wants: not one row per
 * id, a single row naming which ids were targeted, how many actually
 * matched, and which fields were touched.
 */
export async function auditBulkPatch(
  audit: AuditService,
  schema: string,
  action: string,
  opts: { actor: AuditActor; targetType: string; ids: string[]; updated: number; patch: Record<string, unknown> },
): Promise<void> {
  await audit.tenant(schema, action, {
    actor: opts.actor,
    targetType: opts.targetType,
    detail: { ids: opts.ids, count: opts.updated, fields: Object.keys(opts.patch) },
  });
}
