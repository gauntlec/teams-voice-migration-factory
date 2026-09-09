import type { Job } from 'bullmq';
import type { Kysely } from 'kysely';
import { tenantDb, type DB } from '@tvmf/db';
import {
  TENANT_DISCOVERY_STEPS,
  TENANT_POLICY_TYPES,
  type TenantDiscoveryProgress,
  type TenantObjectType,
} from '@tvmf/shared';
import type { TeamsExecutor } from '../teams/executor';
import { STEP_CMDLETS, STEP_TYPES, policyValue, type CmdletSpec } from './cmdlets';

type Rec = Record<string, unknown>;
type Scoped = ReturnType<typeof tenantDb>;

const emptyProgress = (): TenantDiscoveryProgress => ({ step: null, completed: [], counts: {}, errors: [] });

/**
 * Pull every step's objects from the connected tenant and upsert the current
 * snapshot. Per-step failures are recorded and the run carries on; only a lost
 * sign-in fails the run. See docs/DISCOVERY.md.
 */
export async function handleTenantDiscoveryRun(
  job: Job,
  db: Kysely<DB>,
  getExecutor: (connectionId: string) => TeamsExecutor | undefined,
) {
  const { schema, runId, connectionId } = job.data as { schema: string; runId: string; connectionId: string };
  const s = tenantDb(db, schema);
  const exec = getExecutor(connectionId);

  if (!exec) {
    await s
      .updateTable('tenant_discovery_runs')
      .set({
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: 'The tenant connection is no longer available on the worker - sign in again and re-run.',
      })
      .where('id', '=', runId)
      .execute();
    await s.updateTable('connections').set({ status: 'expired' }).where('id', '=', connectionId).execute();
    return;
  }

  const progress = emptyProgress();
  await s
    .updateTable('tenant_discovery_runs')
    .set({ status: 'running', started_at: new Date().toISOString(), progress })
    .where('id', '=', runId)
    .execute();

  const succeededTypes = new Set<TenantObjectType>();
  let signInLost = false;

  for (const step of TENANT_DISCOVERY_STEPS) {
    progress.step = step;
    await saveProgress(s, runId, progress);
    try {
      for (const spec of STEP_CMDLETS[step]) {
        const n = await runSpec(s, exec, runId, spec);
        progress.counts[spec.objectType] = (progress.counts[spec.objectType] ?? 0) + n;
      }
      for (const t of STEP_TYPES[step]) succeededTypes.add(t);
      progress.completed.push(step);
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      progress.errors.push({ step, message });
      // eslint-disable-next-line no-console
      console.warn(`[discovery ${runId}] step ${step} failed: ${message}`);
      if (/not connected|exited|disposed|timed out/i.test(message)) {
        signInLost = true;
        break;
      }
    }
    await saveProgress(s, runId, progress);
  }

  // Tombstone objects that a *successful* step no longer returned.
  if (succeededTypes.size) {
    const types = Array.from(succeededTypes);
    await s
      .updateTable('tenant_objects')
      .set({ removed_at: new Date().toISOString() })
      .where('object_type', 'in', types)
      .where('removed_at', 'is', null)
      .where((eb) => eb.or([eb('last_seen_run_id', '<>', runId), eb('last_seen_run_id', 'is', null)]))
      .execute();
    if (succeededTypes.has('user')) {
      await s
        .updateTable('tenant_users')
        .set({ removed_at: new Date().toISOString() })
        .where('removed_at', 'is', null)
        .where((eb) => eb.or([eb('last_seen_run_id', '<>', runId), eb('last_seen_run_id', 'is', null)]))
        .execute();
    }
    if (succeededTypes.has('policy')) {
      await s
        .updateTable('tenant_policies')
        .set({ removed_at: new Date().toISOString() })
        .where('removed_at', 'is', null)
        .where((eb) => eb.or([eb('last_seen_run_id', '<>', runId), eb('last_seen_run_id', 'is', null)]))
        .execute();
    }
  }

  progress.step = null;
  const total = Object.values(progress.counts).reduce((a, b) => a + (b ?? 0), 0);
  await s
    .updateTable('tenant_discovery_runs')
    .set({
      status: signInLost ? 'failed' : 'completed',
      finished_at: new Date().toISOString(),
      progress,
      summary: { total, counts: progress.counts, errors: progress.errors.length },
      error: signInLost ? 'Lost the tenant sign-in part-way through - sign in again and re-run.' : null,
    })
    .where('id', '=', runId)
    .execute();
  if (signInLost) {
    await s.updateTable('connections').set({ status: 'expired' }).where('id', '=', connectionId).execute();
  }
  // eslint-disable-next-line no-console
  console.log(`[discovery ${runId}] ${signInLost ? 'failed' : 'completed'} - ${total} objects`, progress.counts);
}

async function saveProgress(s: Scoped, runId: string, progress: TenantDiscoveryProgress) {
  await s.updateTable('tenant_discovery_runs').set({ progress }).where('id', '=', runId).execute();
}

/** Fetch one cmdlet (paging when supported) and upsert every record. Returns the count stored. */
async function runSpec(s: Scoped, exec: TeamsExecutor, runId: string, spec: CmdletSpec): Promise<number> {
  let stored = 0;
  const handle = async (records: unknown[]) => {
    for (const raw of records) {
      if (!raw || typeof raw !== 'object') continue;
      const recs = spec.explode ? spec.explode(raw as Rec) : [raw as Rec];
      for (const r of recs) {
        const key = spec.key(r) ?? fallbackKey(r);
        const objectId = await upsertObject(s, runId, spec.objectType, key, spec.name(r), r);
        if (spec.objectType === 'user') await projectUser(s, runId, objectId, r);
        if (spec.objectType === 'policy' && spec.policyType) {
          await projectPolicy(s, runId, objectId, spec.policyType, r);
        }
        stored += 1;
      }
    }
  };

  if (!spec.page) {
    await handle(await exec.query(spec.command, spec.resultSize ? { ResultSize: spec.resultSize } : {}));
    return stored;
  }

  // Paged: keep going until a short page.
  const size = spec.page.size;
  for (let skip = 0; ; skip += size) {
    const params = spec.page.style === 'first-skip' ? { First: size, Skip: skip } : { Top: size, Skip: skip };
    const batch = await exec.query(spec.command, params);
    await handle(batch);
    if (batch.length < size) break;
    if (skip > 500_000) break; // safety valve
  }
  return stored;
}

function fallbackKey(r: Rec): string {
  const j = JSON.stringify(r);
  let h = 0;
  for (let i = 0; i < j.length; i++) h = (h * 31 + j.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(16)}`;
}

async function upsertObject(
  s: Scoped,
  runId: string,
  objectType: TenantObjectType,
  objectKey: string,
  displayName: string | null,
  data: Rec,
): Promise<string> {
  const row = await s
    .insertInto('tenant_objects')
    .values({
      object_type: objectType,
      object_key: objectKey,
      display_name: displayName,
      data,
      first_seen_run_id: runId,
      last_seen_run_id: runId,
      discovered_at: new Date().toISOString(),
    })
    .onConflict((oc) =>
      oc.columns(['object_type', 'object_key']).doUpdateSet({
        display_name: displayName,
        data,
        last_seen_run_id: runId,
        discovered_at: new Date().toISOString(),
        removed_at: null,
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
/**
 * `pg` encodes a JS array as a Postgres array literal ("{a,b}"), which a jsonb
 * column rejects ("invalid input syntax for type json"). Objects are fine, so
 * only array-valued jsonb fields go through this. The cast keeps Kysely's
 * column typing while the value on the wire is JSON text.
 */
const jsonb = <T>(v: T): T => JSON.stringify(v) as unknown as T;
const bool = (v: unknown): boolean | null =>
  typeof v === 'boolean' ? v : typeof v === 'string' ? /^true$/i.test(v) : null;
const iso = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(String(v).replace(/^\/Date\((\d+)\)\/$/, '$1'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

async function projectUser(s: Scoped, runId: string, objectId: string, r: Rec) {
  const upn = str(r.UserPrincipalName);
  if (!upn) return;
  const policies: Record<string, string | null> = {};
  for (const t of TENANT_POLICY_TYPES) policies[t] = policyValue(r[t]);
  const numbers = Array.isArray(r.TelephoneNumbers)
    ? (r.TelephoneNumbers as Rec[]).map((n) => ({
        number: str(n.TelephoneNumber) ?? str(n.Number) ?? '',
        category: str(n.AssignmentCategory) ?? undefined,
      }))
    : [];
  const values = {
    object_id: objectId,
    upn,
    entra_id: str(r.Identity),
    display_name: str(r.DisplayName),
    account_type: str(r.AccountType),
    account_enabled: bool(r.AccountEnabled),
    enterprise_voice_enabled: bool(r.EnterpriseVoiceEnabled) ?? false,
    line_uri: str(r.LineUri) ?? str(r.LineURI),
    telephone_numbers: jsonb(numbers),
    feature_types: Array.isArray(r.FeatureTypes) ? (r.FeatureTypes as unknown[]).map(String) : [],
    assigned_plans: jsonb(Array.isArray(r.AssignedPlan) ? (r.AssignedPlan as unknown[]) : []),
    usage_location: str(r.UsageLocation),
    department: str(r.Department),
    job_title: str(r.Title) ?? str(r.JobTitle),
    interpreted_user_type: str(r.InterpretedUserType),
    policies,
    effective_policy_assignments: jsonb(
      Array.isArray(r.EffectivePolicyAssignments) ? (r.EffectivePolicyAssignments as unknown[]) : [],
    ),
    when_changed: iso(r.WhenChanged),
    last_seen_run_id: runId,
    removed_at: null,
  };
  await s
    .insertInto('tenant_users')
    .values(values)
    .onConflict((oc) => oc.column('object_id').doUpdateSet(values))
    .execute();
}

async function projectPolicy(s: Scoped, runId: string, objectId: string, policyType: string, r: Rec) {
  const identity = str(r.Identity);
  if (!identity) return;
  const name = identity.replace(/^Tag:/i, '');
  const values = {
    object_id: objectId,
    policy_type: policyType,
    identity,
    name,
    is_global: /^global$/i.test(name),
    data: r,
    last_seen_run_id: runId,
    removed_at: null,
  };
  await s
    .insertInto('tenant_policies')
    .values(values)
    .onConflict((oc) => oc.column('object_id').doUpdateSet(values))
    .execute();
}
