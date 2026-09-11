import type { Job } from 'bullmq';
import type { Kysely } from 'kysely';
import { platformDb, tenantDb, type DB } from '@tvmf/db';
import {
  TENANT_DISCOVERY_STEPS,
  TENANT_POLICY_TYPES,
  type DiscoveryCompletedContext,
  type TenantDiscoveryProgress,
  type TenantObjectChangeKind,
  type TenantObjectType,
} from '@tvmf/shared';
import type { TeamsExecutor } from '../teams/executor';
import type { MailEnqueuer } from '../mail/enqueue';
import {
  STEP_CMDLETS,
  STEP_TYPES,
  policyValue,
  type CmdletSpec,
  type DiscoveryFilterOpts,
} from './cmdlets';

type Rec = Record<string, unknown>;
type Scoped = ReturnType<typeof tenantDb>;

const emptyProgress = (): TenantDiscoveryProgress => ({
  step: null,
  completed: [],
  counts: {},
  changed: { added: 0, updated: 0, removed: 0, readded: 0 },
  skipped: { notLicensed: 0 },
  filterDisabledReason: null,
  note: null,
  errors: [],
});

/** Human label for an object type, for the live "Storing 3,400 users…" note. */
const TYPE_NOUN: Partial<Record<TenantObjectType, string>> = {
  user: 'users',
  resource_account: 'resource accounts',
  phone_number: 'phone numbers',
  policy: 'policies',
  auto_attendant: 'auto attendants',
  call_queue: 'call queues',
  voice_route: 'voice routes',
  emergency_location: 'emergency locations',
  civic_address: 'civic addresses',
};
const nounFor = (t: TenantObjectType) => TYPE_NOUN[t] ?? `${t.replace(/_/g, ' ')}s`;

/** Stable JSON so two records compare equal regardless of key order. */
const canon = (v: unknown): string => {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.keys(x as Rec)
              .sort()
              .map((k) => [k, sort((x as Rec)[k])]),
          )
        : x;
  return JSON.stringify(sort(v));
};

/** Top-level keys whose value differs between two records (added, removed or changed). */
function diffKeys(before: Rec | null, after: Rec | null): string[] {
  const b = before ?? {};
  const a = after ?? {};
  const out: string[] = [];
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (canon(b[k]) !== canon(a[k])) out.push(k);
  }
  return out.sort();
}

/**
 * Pull every step's objects from the connected tenant and upsert the current
 * snapshot. Per-step failures are recorded and the run carries on; only a lost
 * sign-in fails the run. See docs/DISCOVERY.md.
 */
export async function handleTenantDiscoveryRun(
  job: Job,
  db: Kysely<DB>,
  getExecutor: (connectionId: string) => TeamsExecutor | undefined,
  enqueueMail?: MailEnqueuer,
) {
  const startedAt = Date.now();
  const {
    schema,
    tenantId,
    runId,
    connectionId,
    operatorUserId,
    scopeTypes,
    includeDisabled,
    includeUnlicensed,
    filterUsers,
    targetedUpns,
  } = job.data as {
    schema: string;
    tenantId?: string;
    runId: string;
    connectionId: string;
    /** platform.users.id of whoever started the run */
    operatorUserId?: string;
    /** object types to discover; undefined = full run (every step) */
    scopeTypes?: TenantObjectType[];
    includeDisabled?: boolean;
    includeUnlicensed?: boolean;
    /** customer default: false = don't filter users to Teams-licensed */
    filterUsers?: boolean;
    /**
     * Set only by BuildService.validateSite (via TenantDiscoveryService.
     * startTargetedUserRun) - a users-only check for exactly these UPNs,
     * not a full sweep. Never set by the Discovery UI's own "start a run"
     * flow.
     */
    targetedUpns?: string[];
  };
  const s = tenantDb(db, schema);
  const exec = getExecutor(connectionId);
  const wantType = (t: TenantObjectType) => !scopeTypes || scopeTypes.includes(t);
  const filterOpts: DiscoveryFilterOpts = { includeDisabled, includeUnlicensed, filterUsers };
  const progress = emptyProgress();

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
    await notifyRunComplete(db, s, enqueueMail, {
      tenantId,
      runId,
      operatorUserId,
      outcome: 'failed',
      errorMessage: 'The tenant connection was no longer available on the worker.',
      startedAt,
      progress,
      scopeTypes,
    });
    return;
  }

  await s
    .updateTable('tenant_discovery_runs')
    .set({ status: 'running', started_at: new Date().toISOString(), progress })
    .where('id', '=', runId)
    .execute();

  // A targeted check never runs the full step loop below - critically, it
  // must never reach the "tombstone every object this run's successful step
  // didn't see" reconciliation further down, which assumes a *complete*
  // sweep of the type. Running that here would wrongly mark every other
  // user in the tenant as removed.
  if (targetedUpns?.length) {
    await runTargetedUserSync(s, exec, runId, targetedUpns, progress);
    progress.step = null;
    await s
      .updateTable('tenant_discovery_runs')
      .set({ status: 'completed', finished_at: new Date().toISOString(), progress })
      .where('id', '=', runId)
      .execute();
    // No completion email - this is an implementation detail of one
    // Validate click, not a Discovery event the customer's
    // notify_on_complete setting should fire for.
    return;
  }

  const succeededTypes = new Set<TenantObjectType>();
  let signInLost = false;
  const ctx: RunContext = { assignees: null };

  for (const step of TENANT_DISCOVERY_STEPS) {
    const specs = STEP_CMDLETS[step].filter((sp) => wantType(sp.objectType));
    if (!specs.length) continue; // step not in this run's scope
    progress.step = step;
    progress.note = null;
    await saveProgress(s, runId, progress);
    try {
      for (const spec of specs) {
        // runSpec now updates progress.counts[spec.objectType] itself, live
        await runSpec(s, exec, runId, spec, ctx, progress, filterOpts);
      }
      for (const t of STEP_TYPES[step]) if (wantType(t)) succeededTypes.add(t);
      progress.completed.push(step);
      progress.note = null;
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      progress.errors.push({ step, message });
      // eslint-disable-next-line no-console
      console.warn(`[discovery ${runId}] step ${step} failed: ${message}`);
      // Only stop the whole run if the pwsh session is actually gone. A single
      // slow or failing cmdlet (a command timeout while the child is still up)
      // is recorded as a step error and the run carries on.
      const sessionGone =
        !exec.alive ||
        /pwsh exited|could not start pwsh|executor disposed|run connect-microsoftteams|not connected|session is disconnected|no valid connection|token.*expired/i.test(
          message,
        );
      if (sessionGone) {
        signInLost = true;
        break;
      }
    }
    await saveProgress(s, runId, progress);
  }

  // Tombstone objects that a *successful* step no longer returned.
  if (succeededTypes.size) {
    progress.step = null;
    progress.note = 'Reconciling removed objects…';
    await saveProgress(s, runId, progress);
    const types = Array.from(succeededTypes);
    const sweptAt = new Date().toISOString();
    // Record a 'removed' version for each object about to be tombstoned.
    const doomed = await s
      .selectFrom('tenant_objects')
      .select(['id', 'object_type', 'object_key', 'display_name', 'data'])
      .where('object_type', 'in', types)
      .where('removed_at', 'is', null)
      .where((eb) => eb.or([eb('last_seen_run_id', '<>', runId), eb('last_seen_run_id', 'is', null)]))
      .execute();
    if (doomed.length) {
      const rows = doomed.map((d) => ({
        object_id: d.id,
        run_id: runId,
        object_type: d.object_type as TenantObjectType,
        object_key: d.object_key,
        display_name: d.display_name,
        change_kind: 'removed' as TenantObjectChangeKind,
        changed_fields: [],
        before: d.data,
        after: null,
        changed_at: sweptAt,
      }));
      for (let i = 0; i < rows.length; i += 500) {
        await s.insertInto('tenant_object_versions').values(rows.slice(i, i + 500)).execute();
      }
      progress.changed.removed += doomed.length;
    }
    await s
      .updateTable('tenant_objects')
      .set({ removed_at: sweptAt })
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
  progress.note = null;
  const total = Object.values(progress.counts).reduce((a, b) => a + (b ?? 0), 0);
  await s
    .updateTable('tenant_discovery_runs')
    .set({
      status: signInLost ? 'failed' : 'completed',
      finished_at: new Date().toISOString(),
      progress,
      summary: {
        total,
        counts: progress.counts,
        changed: progress.changed,
        skipped: progress.skipped,
        filterDisabledReason: progress.filterDisabledReason ?? null,
        errors: progress.errors.length,
      },
      error: signInLost ? 'Lost the tenant sign-in part-way through - sign in again and re-run.' : null,
    })
    .where('id', '=', runId)
    .execute();
  if (signInLost) {
    await s.updateTable('connections').set({ status: 'expired' }).where('id', '=', connectionId).execute();
  }
  // eslint-disable-next-line no-console
  console.log(
    `[discovery ${runId}] ${signInLost ? 'failed' : 'completed'} - ${total} objects` +
      `${scopeTypes ? ` (scope: ${scopeTypes.join(', ')})` : ''}`,
    progress.counts,
    progress.changed,
  );

  await notifyRunComplete(db, s, enqueueMail, {
    tenantId,
    runId,
    operatorUserId,
    outcome: signInLost
      ? 'failed'
      : progress.errors.length
        ? 'completed_with_errors'
        : 'completed',
    errorMessage: signInLost ? 'Lost the tenant sign-in part-way through the run.' : null,
    startedAt,
    progress,
    scopeTypes,
  });
}

/**
 * Email the person who started the run once it reaches a terminal state — unless
 * the customer has turned it off (`tenant_discovery_config.notify_on_complete`).
 * Best-effort: a mail failure is logged and never fails the run.
 */
async function notifyRunComplete(
  db: Kysely<DB>,
  s: Scoped,
  enqueueMail: MailEnqueuer | undefined,
  args: {
    tenantId?: string;
    runId: string;
    operatorUserId?: string;
    outcome: DiscoveryCompletedContext['outcome'];
    errorMessage?: string | null;
    startedAt: number;
    progress: TenantDiscoveryProgress;
    scopeTypes?: TenantObjectType[];
  },
): Promise<void> {
  if (!enqueueMail || !args.operatorUserId) return;
  try {
    const cfg = await s
      .selectFrom('tenant_discovery_config')
      .select('notify_on_complete')
      .executeTakeFirst()
      .catch(() => undefined);
    if (cfg && cfg.notify_on_complete === false) return;

    const user = await platformDb(db)
      .selectFrom('users')
      .select(['email', 'display_name'])
      .where('id', '=', args.operatorUserId)
      .executeTakeFirst();
    if (!user?.email) return;

    let customerName = 'your customer';
    if (args.tenantId) {
      const tn = await platformDb(db)
        .selectFrom('tenants')
        .select('name')
        .where('id', '=', args.tenantId)
        .executeTakeFirst();
      if (tn?.name) customerName = tn.name;
    }

    const p = args.progress;
    const total = Object.values(p.counts).reduce((a, b) => a + (b ?? 0), 0);
    const breakdown = (Object.entries(p.counts) as [TenantObjectType, number][])
      .filter(([, nn]) => (nn ?? 0) > 0)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .slice(0, 6)
      .map(([t, nn]) => ({ label: nounFor(t), count: nn }));

    const secs = Math.max(1, Math.round((Date.now() - args.startedAt) / 1000));
    const durationText =
      secs < 90 ? `${secs} s` : `${Math.floor(secs / 60)} min ${String(secs % 60).padStart(2, '0')} s`;

    const webOrigin = (process.env.WEB_ORIGIN ?? '').replace(/\/+$/, '');

    const context: DiscoveryCompletedContext = {
      recipientName: user.display_name ?? user.email,
      customerName,
      outcome: args.outcome,
      scopeLabel: args.scopeTypes?.length
        ? `Partial: ${args.scopeTypes.map(nounFor).join(', ')}`
        : 'Full discovery',
      durationText,
      totalObjects: total,
      added: p.changed.added,
      updated: p.changed.updated,
      removed: p.changed.removed,
      readded: p.changed.readded,
      skippedNotLicensed: p.skipped?.notLicensed ?? 0,
      errorCount: p.errors.length,
      filterNote: p.filterDisabledReason ?? null,
      errorMessage: args.errorMessage ?? null,
      breakdown,
      runUrl: webOrigin ? `${webOrigin}/discovery` : '/discovery',
    };

    await enqueueMail({
      template: 'discovery_completed',
      to: { email: user.email, name: user.display_name },
      createdBy: args.operatorUserId,
      related: { type: 'tenant_discovery_run', id: args.runId },
      context,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[discovery ${args.runId}] completion email not sent: ${(e as Error).message}`);
  }
}

async function saveProgress(s: Scoped, runId: string, progress: TenantDiscoveryProgress) {
  await s.updateTable('tenant_discovery_runs').set({ progress }).where('id', '=', runId).execute();
}

interface Assignee {
  upn: string | null;
  displayName: string | null;
  kind: 'user' | 'resource_account';
}
interface RunContext {
  /** Entra object id -> who holds it; built once, after the users + resource-account steps */
  assignees: Map<string, Assignee> | null;
}

/** Who a phone number is assigned to, resolved from what this run has already stored. */
async function loadAssignees(s: Scoped): Promise<Map<string, Assignee>> {
  const map = new Map<string, Assignee>();
  const users = await s
    .selectFrom('tenant_users')
    .select(['entra_id', 'upn', 'display_name'])
    .where('removed_at', 'is', null)
    .execute();
  for (const u of users) if (u.entra_id) map.set(u.entra_id, { upn: u.upn, displayName: u.display_name, kind: 'user' });
  const ras = await s
    .selectFrom('tenant_objects')
    .select(['object_key', 'display_name', 'data'])
    .where('object_type', '=', 'resource_account')
    .where('removed_at', 'is', null)
    .execute();
  for (const ra of ras) {
    map.set(ra.object_key, {
      upn: str((ra.data as Rec).UserPrincipalName),
      displayName: ra.display_name,
      kind: 'resource_account',
    });
  }
  return map;
}

/** Keys the module wraps every policy in that carry no settings - hidden from the stored definition. */
const POLICY_NOISE_KEYS = new Set([
  'Key',
  'SchemaId',
  'DefaultXml',
  'AuthorityId',
  'XmlRoot',
  'Element',
  'Anchor',
  'Signature',
  'ConfigObject',
  'IsModified',
  'ScopeClass',
  'Class',
  'TypedIdentity',
]);
const cleanPolicy = (r: Rec): Rec =>
  Object.fromEntries(Object.entries(r).filter(([k]) => !POLICY_NOISE_KEYS.has(k)));

interface PrevObject {
  data: Rec;
  display_name: string | null;
  removed_at: string | null;
}
type NewVersion = {
  object_id: string;
  run_id: string;
  object_type: TenantObjectType;
  object_key: string;
  display_name: string | null;
  change_kind: TenantObjectChangeKind;
  changed_fields: string[];
  before: Rec | null;
  after: Rec | null;
  changed_at: string;
};

/**
 * Fetch one cmdlet (paging when supported) and upsert every record. To keep the
 * query load flat on large tenants we read the whole current snapshot for this
 * object type once (not once per row) and batch the version-history inserts.
 */
async function runSpec(
  s: Scoped,
  exec: TeamsExecutor,
  runId: string,
  spec: CmdletSpec,
  ctx: RunContext,
  progress: TenantDiscoveryProgress,
  filterOpts: DiscoveryFilterOpts = {},
): Promise<number> {
  const noun = nounFor(spec.objectType);
  let skippedUnlicensed = 0;
  // Filter `User` accounts down to Teams-licensed ones, unless the customer
  // turned the filter off (filterOpts.filterUsers === false) or the engineer
  // opted in to everything for this run. Also flipped off by the probe below if
  // `Get-CsOnlineUser` returns no licence data at all for this tenant.
  let filterUsers =
    spec.objectType === 'user' &&
    filterOpts.filterUsers !== false &&
    !filterOpts.includeUnlicensed;
  let licenceProbed = false;

  // Current snapshot for this type, keyed by object_key - one read for the step.
  progress.note = `Loading existing ${noun}…`;
  await saveProgress(s, runId, progress);
  const prev = new Map<string, PrevObject>();
  for (const row of await s
    .selectFrom('tenant_objects')
    .select(['object_key', 'data', 'display_name', 'removed_at'])
    .where('object_type', '=', spec.objectType)
    .execute()) {
    prev.set(row.object_key, {
      data: row.data as Rec,
      display_name: row.display_name,
      removed_at: row.removed_at,
    });
  }

  const versions: NewVersion[] = [];
  const flushVersions = async () => {
    if (!versions.length) return;
    const batch = versions.splice(0, versions.length);
    for (let i = 0; i < batch.length; i += 500) {
      await s.insertInto('tenant_object_versions').values(batch.slice(i, i + 500)).execute();
    }
  };

  const base = progress.counts[spec.objectType] ?? 0;
  let stored = 0;
  let lastSaved = 0;
  let expected = 0; // total this step will store, once known (non-paged pull)
  const seen = spec.buckets ? new Set<string>() : null; // de-dup across buckets
  const handle = async (records: unknown[]) => {
    for (const raw of records) {
      if (!raw || typeof raw !== 'object') continue;
      const recs = spec.explode ? spec.explode(raw as Rec) : [raw as Rec];
      for (let r of recs) {
        if (spec.objectType === 'phone_number') {
          ctx.assignees ??= await loadAssignees(s);
          const target = str(r.AssignedPstnTargetId);
          const who = target ? ctx.assignees.get(target) : undefined;
          if (who) r = { ...r, AssignedTo: who };
        }
        const key = spec.key(r) ?? fallbackKey(r);
        if (seen) {
          if (seen.has(key)) continue;
          seen.add(key);
        }
        // Skip AccountType 'User' accounts not licensed for Teams - not
        // migration candidates. Never applies to ResourceAccount /
        // SfbOnPremUser, or when the engineer opted in, or when the probe
        // disabled the filter.
        if (filterUsers && str(r.AccountType) === 'User' && !isTeamsCandidate(r)) {
          skippedUnlicensed += 1;
          continue;
        }
        const name = spec.name(r);
        const p = prev.get(key);
        const { id: objectId, change } = await upsertObject(s, runId, spec.objectType, key, name, r, p);
        if (change) {
          progress.changed[change] += 1;
          versions.push({
            object_id: objectId,
            run_id: runId,
            object_type: spec.objectType,
            object_key: key,
            display_name: name,
            change_kind: change,
            changed_fields: change === 'updated' ? diffKeys(p?.data ?? null, r) : [],
            before: p?.data ?? null,
            after: r,
            changed_at: new Date().toISOString(),
          });
        }
        if (spec.objectType === 'user') await projectUser(s, runId, objectId, r);
        if (spec.objectType === 'policy' && spec.policyType) {
          await projectPolicy(s, runId, objectId, spec.policyType, r);
        }
        stored += 1;
        progress.counts[spec.objectType] = base + stored;
      }
      if (versions.length >= 500) await flushVersions();
      // heartbeat the run row so the UI shows the count climbing on a big step
      if (stored - lastSaved >= 250) {
        lastSaved = stored;
        progress.note = expected
          ? `Storing ${noun}: ${stored.toLocaleString()} / ${expected.toLocaleString()}…`
          : `Storing ${stored.toLocaleString()} ${noun}…`;
        await saveProgress(s, runId, progress);
      }
    }
  };

  const qopts = { select: spec.select, depth: spec.depth, timeoutMs: spec.timeoutMs };

  // Bucketed fetch (Get-CsOnlineUser): one -Filter per disjoint slice, so a huge
  // result comes back in visible chunks and no single call can time out. One
  // bad bucket is recorded and skipped - it must not abort the others.
  if (spec.buckets) {
    const buckets = spec.buckets(filterOpts);
    let fetched = 0;
    for (let i = 0; i < buckets.length; i++) {
      const bk = buckets[i];
      progress.note = `Fetching ${noun}: ${fetched.toLocaleString()} so far (${bk.label}, ${i + 1}/${buckets.length})…`;
      await saveProgress(s, runId, progress);
      let recs: unknown[];
      try {
        recs = await exec.query(
          spec.command,
          { Filter: bk.filter, ...(spec.resultSize ? { ResultSize: spec.resultSize } : {}) },
          qopts,
        );
      } catch (e) {
        const message = (e as Error).message ?? String(e);
        if (!exec.alive || /pwsh exited|could not start pwsh|executor disposed|not connected|session is disconnected/i.test(message)) {
          throw e; // session really gone - let the step handler stop the run
        }
        progress.errors.push({
          step: progress.step ?? 'users',
          message: `bucket "${bk.label}": ${message}`,
        });
        continue;
      }
      fetched += recs.length;

      // Probe once: if the first slice that contains real `User` records carries
      // no licence data for any of them, `Get-CsOnlineUser -Filter` isn't
      // returning it on this tenant - don't filter blind, store everyone and say so.
      if (filterUsers && !licenceProbed) {
        const sample = recs.filter(
          (x) => x && typeof x === 'object' && str((x as Rec).AccountType) === 'User',
        ) as Rec[];
        if (sample.length) {
          licenceProbed = true;
          if (!sample.some(hasLicenceData)) {
            filterUsers = false;
            progress.filterDisabledReason =
              'Get-CsOnlineUser returned no licence data for this tenant, so the Teams-licence filter was not applied - every enabled user was stored.';
            progress.errors.push({ step: progress.step ?? 'users', message: progress.filterDisabledReason });
            await saveProgress(s, runId, progress);
            // eslint-disable-next-line no-console
            console.warn(`[discovery ${runId}] users: no licence data on -Filter path; user filter disabled`);
          }
        }
      }

      await handle(recs);
    }
    await flushVersions();
    if (spec.objectType === 'user') {
      progress.skipped = { notLicensed: (progress.skipped?.notLicensed ?? 0) + skippedUnlicensed };
    }
    if (skippedUnlicensed) {
      progress.note = `Stored ${stored.toLocaleString()} ${noun} · skipped ${skippedUnlicensed.toLocaleString()} not licensed for Teams`;
      await saveProgress(s, runId, progress);
      // eslint-disable-next-line no-console
      console.log(`[discovery ${runId}] users: skipped ${skippedUnlicensed} not licensed for Teams`);
    }
    return stored;
  }

  if (!spec.page) {
    progress.note = `Fetching ${noun} from the tenant (this can take a few minutes on a large tenant)…`;
    await saveProgress(s, runId, progress);
    const records = await exec.query(
      spec.command,
      spec.resultSize ? { ResultSize: spec.resultSize } : {},
      qopts,
    );
    expected = base + records.length;
    progress.note = `Fetched ${records.length.toLocaleString()} ${noun}, storing…`;
    await saveProgress(s, runId, progress);
    await handle(records);
    await flushVersions();
    return stored;
  }

  // Paged: keep going until a short page.
  const size = spec.page.size;
  for (let skip = 0; ; skip += size) {
    progress.note = `Fetching ${noun}${skip ? ` (from ${skip.toLocaleString()})` : ''}…`;
    await saveProgress(s, runId, progress);
    const params = spec.page.style === 'first-skip' ? { First: size, Skip: skip } : { Top: size, Skip: skip };
    const batch = await exec.query(spec.command, params, qopts);
    await handle(batch);
    if (batch.length < size) break;
    if (skip > 500_000) break; // safety valve
  }
  await flushVersions();
  return stored;
}

function fallbackKey(r: Rec): string {
  const j = JSON.stringify(r);
  let h = 0;
  for (let i = 0; i < j.length; i++) h = (h * 31 + j.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(16)}`;
}

/**
 * Upsert one object into the current snapshot and classify how it changed
 * against `prev` (the row already loaded for this type, or undefined if new).
 * The caller records the version row; this only writes `tenant_objects`.
 */
async function upsertObject(
  s: Scoped,
  runId: string,
  objectType: TenantObjectType,
  objectKey: string,
  displayName: string | null,
  data: Rec,
  prev: PrevObject | undefined,
): Promise<{ id: string; change: TenantObjectChangeKind | null }> {
  let change: TenantObjectChangeKind | null = null;
  if (!prev) change = 'added';
  else if (prev.removed_at) change = 'readded';
  else if (
    canon(prev.data) !== canon(data) ||
    (prev.display_name ?? null) !== (displayName ?? null)
  ) {
    change = 'updated';
  }

  const now = new Date().toISOString();
  const row = await s
    .insertInto('tenant_objects')
    .values({
      object_type: objectType,
      object_key: objectKey,
      display_name: displayName,
      data,
      first_seen_run_id: runId,
      last_seen_run_id: runId,
      discovered_at: now,
      content_changed_at: change ? now : null,
    })
    .onConflict((oc) =>
      oc.columns(['object_type', 'object_key']).doUpdateSet({
        display_name: displayName,
        data,
        last_seen_run_id: runId,
        discovered_at: now,
        removed_at: null,
        ...(change ? { content_changed_at: now } : {}),
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();

  return { id: row.id, change };
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

const LIVE_STATUS = new Set(['Enabled', 'Warning']); // Warning = licence grace period

/** The record carries FeatureTypes / AssignedPlan we can actually judge by. */
function hasLicenceData(r: Rec): boolean {
  return (
    (Array.isArray(r.FeatureTypes) && r.FeatureTypes.length > 0) ||
    (Array.isArray(r.AssignedPlan) && r.AssignedPlan.length > 0)
  );
}

/**
 * A Teams-voice migration candidate: licensed for Teams. `FeatureTypes`
 * enumerates a user's Teams/SfB capabilities, so any entry there counts;
 * otherwise fall back to an active `MCO*` / `TEAMS*` service plan. Fails OPEN -
 * a record with no licence fields at all is kept, not dropped (the run-level
 * probe in `runSpec` handles the case where `-Filter` returns no licence data
 * for anyone). Never applied to ResourceAccount / SfbOnPremUser.
 */
function isTeamsCandidate(r: Rec): boolean {
  if (!hasLicenceData(r)) return true;
  if (Array.isArray(r.FeatureTypes) && r.FeatureTypes.length > 0) return true;
  const plans = Array.isArray(r.AssignedPlan) ? (r.AssignedPlan as Rec[]) : [];
  return plans.some(
    (p) =>
      /^(MCO|TEAMS)/i.test(String(p?.Capability ?? '')) &&
      LIVE_STATUS.has(String(p?.CapabilityStatus ?? '')),
  );
}

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

/**
 * `Get-CsOnlineUser -Identity <upn>`, one call per UPN - not the bucketed
 * full-tenant sweep `STEP_CMDLETS.users[0].buckets` uses. Same command/
 * select/depth so results land through the identical upsertObject +
 * projectUser path a full sync uses; a genuinely nonexistent UPN just comes
 * back empty, correctly leaving no tenant_users row (existsInTenant stays
 * false - that's the right answer, not a bug to retry). One bad identity is
 * recorded and skipped, same as the bucket loop, unless the session itself
 * is gone.
 */
async function runTargetedUserSync(
  s: Scoped,
  exec: TeamsExecutor,
  runId: string,
  upns: string[],
  progress: TenantDiscoveryProgress,
) {
  const spec = STEP_CMDLETS.users[0];
  progress.step = 'users';
  progress.counts.user = progress.counts.user ?? 0;
  for (let i = 0; i < upns.length; i++) {
    const upn = upns[i];
    progress.note = `Checking ${upn} (${i + 1}/${upns.length})…`;
    await saveProgress(s, runId, progress);
    let recs: unknown[];
    try {
      recs = await exec.query(spec.command, { Identity: upn }, { select: spec.select, depth: spec.depth });
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      if (!exec.alive || /pwsh exited|could not start pwsh|executor disposed|not connected|session is disconnected/i.test(message)) {
        throw e; // session really gone
      }
      progress.errors.push({ step: 'users', message: `${upn}: ${message}` });
      continue;
    }
    const r = recs.find((x) => x && typeof x === 'object') as Rec | undefined;
    if (!r) continue; // not found - leave tenant_users unset, existsInTenant correctly stays false
    const key = spec.key(r) ?? upn;
    const name = spec.name(r);
    const prevRow = await s
      .selectFrom('tenant_objects')
      .select(['id', 'data', 'display_name', 'removed_at'])
      .where('object_type', '=', 'user')
      .where('object_key', '=', key)
      .executeTakeFirst();
    const { id: objectId } = await upsertObject(
      s,
      runId,
      'user',
      key,
      name,
      r,
      prevRow ? { data: prevRow.data as Rec, display_name: prevRow.display_name, removed_at: prevRow.removed_at } : undefined,
    );
    await projectUser(s, runId, objectId, r);
    progress.counts.user += 1;
  }
  progress.note = null;
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
    // the settings only - the raw record (with the module's XML wrapper) stays on tenant_objects
    data: cleanPolicy(r),
    last_seen_run_id: runId,
    removed_at: null,
  };
  await s
    .insertInto('tenant_policies')
    .values(values)
    .onConflict((oc) => oc.column('object_id').doUpdateSet(values))
    .execute();
}
