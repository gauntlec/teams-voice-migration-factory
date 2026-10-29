import { createHash } from 'node:crypto';
import type { Job } from 'bullmq';
import { sql, type Kysely } from 'kysely';
import { computeSiteDrift, markNumbersReleased, reconcileNumbersWithTeams, type NumberReconcileResult, platformDb, sitesWithLiveRuns, tenantDb, type DB, webOrigin as resolveWebOrigin } from '@tvmf/db';
import {
  RESOURCE_ACCOUNT_APPLICATION_IDS,
  numberReleasedInTeams,
  parseLiveCallingSettings,
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
export type Scoped = ReturnType<typeof tenantDb>;

export const emptyProgress = (): TenantDiscoveryProgress => ({
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

/** What `tenant_objects.content_hash` holds: equal hashes mean equal data, whatever the key order. */
const hashOf = (data: Rec): string => createHash('sha1').update(canon(data)).digest('hex');

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

/** The pwsh session itself is gone (vs one cmdlet failing) - the run can't go on. */
const SESSION_GONE =
  /pwsh exited|could not start pwsh|executor disposed|run connect-microsoftteams|not connected|session is disconnected|no valid connection|token.*expired/i;

/**
 * Pull every step's objects from the connected tenant and upsert the current
 * snapshot. Per-step failures are recorded and the run carries on; only a lost
 * sign-in fails the run. See docs/DISCOVERY.md.
 *
 * Whatever happens, the run row ends in a terminal state: anything that throws
 * past the per-step handling (a lost session during a targeted check, a
 * database error while reconciling) marks the run failed rather than leaving
 * it 'running' - which would also block every new run for this customer until
 * the worker restarted.
 */
export async function handleTenantDiscoveryRun(
  job: Job,
  db: Kysely<DB>,
  getExecutor: (connectionId: string) => TeamsExecutor | undefined,
  enqueueMail?: MailEnqueuer,
) {
  try {
    await runDiscovery(job, db, getExecutor, enqueueMail);
  } catch (e) {
    const { schema, runId, connectionId } = job.data as { schema: string; runId: string; connectionId: string };
    const message = (e as Error)?.message ?? String(e);
    // eslint-disable-next-line no-console
    console.error(`[discovery ${runId}] failed:`, message);
    const s = tenantDb(db, schema);
    const failed = await s
      .updateTable('tenant_discovery_runs')
      .set({ status: 'failed', finished_at: new Date().toISOString(), error: `The run stopped unexpectedly: ${message.slice(0, 500)}` })
      .where('id', '=', runId)
      .where('status', 'in', ['queued', 'running'])
      .returning(['kind', 'progress', 'scope_types', 'started_at'])
      .executeTakeFirst()
      .catch(() => undefined);
    const exec = getExecutor(connectionId);
    if (!exec || !exec.alive || SESSION_GONE.test(message)) {
      await s.updateTable('connections').set({ status: 'expired' }).where('id', '=', connectionId).execute().catch(() => undefined);
    }
    // The starter hears about this failure too, same as any other finished
    // run - but only once (this run was still in flight), and never for a
    // Validate check.
    if (failed && failed.kind === 'sync') {
      const { tenantId, operatorUserId } = job.data as { tenantId?: string; operatorUserId?: string };
      await notifyRunComplete(db, s, enqueueMail, {
        tenantId,
        runId,
        operatorUserId,
        outcome: 'failed',
        errorMessage: 'The run stopped unexpectedly.',
        startedAt: failed.started_at ? new Date(failed.started_at).getTime() : Date.now(),
        // a run that never started still has the column's bare default
        progress: { ...emptyProgress(), ...((failed.progress as Partial<TenantDiscoveryProgress> | null) ?? {}) },
        scopeTypes: (failed.scope_types as TenantObjectType[] | null) ?? undefined,
      });
    }
  }
}

async function runDiscovery(
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
    // A Validate check is part of one click in Design & Build, not a Discovery run to email about.
    if (targetedUpns?.length) return;
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

  // Only a queued run starts: a second delivery of the same job (a queue that thought the first had stalled) finds it running, or
  // finished, and leaves it to the first.
  const claimed = await s
    .updateTable('tenant_discovery_runs')
    .set({ status: 'running', started_at: new Date().toISOString(), progress })
    .where('id', '=', runId)
    .where('status', '=', 'queued')
    .returning('id')
    .executeTakeFirst();
  if (!claimed) {
    // eslint-disable-next-line no-console
    console.warn(`[discovery ${runId}] already started (or finished) - not running it a second time`);
    return;
  }

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
  /** the users step came back whole, so the other voice users' settings are read once the run has finished */
  let readOtherVoiceUsers = false;
  const ctx: RunContext = { schema, assignees: null, seen: new Map(), timings: {} };
  // A new sync takes over from an earlier run's background voice settings pass (it would read the same users).
  backgroundVoice.get(schema)?.stop();

  for (const step of TENANT_DISCOVERY_STEPS) {
    const specs = STEP_CMDLETS[step].filter((sp) => wantType(sp.objectType));
    if (!specs.length) continue; // step not in this run's scope
    progress.step = step;
    progress.note = null;
    await saveProgress(s, runId, progress);
    // Each cmdlet on its own: one failing (e.g. a policy type this tenant
    // doesn't have) is recorded and the step's other cmdlets still run. A step
    // is only "complete" - and so allowed to tombstone what it didn't see - when
    // every cmdlet, and every slice of a bucketed one, came back.
    let stepComplete = true;
    for (const spec of specs) {
      try {
        // runSpec updates progress.counts[spec.objectType] itself, live
        const r = await runSpec(s, exec, runId, spec, ctx, progress, filterOpts);
        if (!r.complete) stepComplete = false;
      } catch (e) {
        const message = (e as Error).message ?? String(e);
        progress.errors.push({ step, message: specs.length > 1 ? `${spec.command}: ${message}` : message });
        // eslint-disable-next-line no-console
        console.warn(`[discovery ${runId}] step ${step} (${spec.command}) failed: ${message}`);
        // Only stop the whole run if the pwsh session is actually gone. A single
        // slow or failing cmdlet (a command timeout while the child is still up)
        // is recorded as an error and the run carries on.
        if (!exec.alive || SESSION_GONE.test(message)) {
          signInLost = true;
          break;
        }
        stepComplete = false;
      }
    }
    if (signInLost) break;
    if (step === 'users' && wantType('user') && stepComplete) {
      // Everything Teams voice keeps per voice-enabled user, so Design & Build can start from what the tenant has. Only the users in
      // Site Data or Design & Build are read here (drift and the completion email need theirs); the rest follow after the run.
      const t0 = Date.now();
      try {
        const due = await usersNeedingVoiceSettings(s, schema, 12 * 3600_000, 'in_sites');
        await syncUserVoiceSettings(s, exec, runId, due.map((u) => ({ objectId: u.object_id, upn: u.upn })), progress, { budgetMs: 90 * 60_000 });
        progress.note = null;
        readOtherVoiceUsers = true;
        // eslint-disable-next-line no-console
        console.log(`[discovery ${runId}] voice settings for ${due.length.toLocaleString()} Site Data / Design & Build users in ${minsSecs(Date.now() - t0)}`);
      } catch (e) {
        const message = (e as Error).message ?? String(e);
        progress.errors.push({ step, message: `voice settings: ${message}` });
        if (!exec.alive || SESSION_GONE.test(message)) signInLost = true;
      }
      const vt = timingFor(ctx, 'voice_settings');
      vt.ms += Date.now() - t0;
      vt.teamsMs += Date.now() - t0;
      if (signInLost) break;
    }
    progress.completed.push(step);
    progress.note = null;
    if (stepComplete) for (const t of STEP_TYPES[step]) if (wantType(t)) succeededTypes.add(t);
    await saveProgress(s, runId, progress);
  }

  const afterSteps = Date.now();
  // Tombstone objects that a *successful* step no longer returned.
  if (succeededTypes.size) {
    progress.step = null;
    progress.note = 'Reconciling removed objects…';
    await saveProgress(s, runId, progress);
    const types = Array.from(succeededTypes);
    const sweptAt = new Date().toISOString();
    // What this run saw: an unchanged object is not written, so "seen" is the run's own list, not last_seen_run_id.
    const seenIds = (ts: TenantObjectType[]) => ts.flatMap((t) => [...(ctx.seen.get(t) ?? [])]);
    const notSeen = (column: 'id' | 'object_id', ts: TenantObjectType[]) => sql<boolean>`NOT (${sql.ref(column)} = ANY(${seenIds(ts)}::uuid[]))`;
    // Record a 'removed' version for each object about to be tombstoned.
    const doomed = await s
      .selectFrom('tenant_objects')
      .select(['id', 'object_type', 'object_key', 'display_name', 'data'])
      .where('object_type', 'in', types)
      .where('removed_at', 'is', null)
      .where(notSeen('id', types))
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
    for (let i = 0; i < doomed.length; i += 500) {
      await s
        .updateTable('tenant_objects')
        .set({ removed_at: sweptAt })
        .where('id', 'in', doomed.slice(i, i + 500).map((d) => d.id))
        .execute();
    }
    if (succeededTypes.has('user')) {
      await s.updateTable('tenant_users').set({ removed_at: sweptAt }).where('removed_at', 'is', null).where(notSeen('object_id', ['user'])).execute();
    }
    // Everything still live of these types was seen now: "Last seen" for the objects this run did not need to write.
    await s
      .insertInto('tenant_object_sweeps')
      .values(types.map((t) => ({ object_type: t, run_id: runId, swept_at: sweptAt })))
      .onConflict((oc) => oc.column('object_type').doUpdateSet((eb) => ({ run_id: eb.ref('excluded.run_id'), swept_at: eb.ref('excluded.swept_at') })))
      .execute();
    if (succeededTypes.has('policy')) {
      await s
        .updateTable('tenant_policies')
        .set({ removed_at: new Date().toISOString() })
        .where('removed_at', 'is', null)
        .where((eb) => eb.or([eb('last_seen_run_id', '<>', runId), eb('last_seen_run_id', 'is', null)]))
        .execute();
    }
    if (succeededTypes.has('resource_account')) {
      await linkRequestedResourceAccounts(s);
    }
  }

  if (exec.graphAlive) {
    try {
      await syncTenantGroups(s, exec);
    } catch {
      // best-effort - Graph is a secondary, optional session on this
      // connection; a failure here must never fail the primary Teams
      // discovery run or mark connections.status expired.
    }
  }

  progress.step = null;
  progress.note = null;
  // Numbers follow Teams: whatever Teams has assigned is shown as assigned to its real holder, and a clash with Site Data is flagged.
  // Numbers Teams no longer lists are only released when this run read every number cleanly. Best-effort.
  let numbers: NumberReconcileResult | null = null;
  if (!signInLost) {
    try {
      numbers = await reconcileNumbersWithTeams(s, { releaseMissing: wantType('phone_number') && !progress.errors.some((e) => e.step === 'numbers') });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[discovery ${runId}] number reconcile failed: ${(e as Error).message}`);
    }
  }
  // removed objects, M365 groups and the number inventory, after the steps
  timingFor(ctx, 'reconcile').ms += Date.now() - afterSteps;
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
        numbers,
        // seconds per step: in all, waiting for Teams to answer, and storing (the rest is reading what was stored and bookkeeping)
        timings: {
          totalSeconds: secs(Date.now() - startedAt),
          steps: Object.fromEntries(
            Object.entries(ctx.timings).map(([k, v]) => [k, { seconds: secs(v.ms), waitingOnTeams: secs(v.teamsMs), storing: secs(v.storeMs) }]),
          ),
        },
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

  // Deployed rows that no longer match live now the tenant has been read again. A partial sync re-checks too: rows of
  // types it did not read compare against what was already stored, so their result does not change. Best-effort.
  const drift: NonNullable<DiscoveryCompletedContext['drift']> = [];
  if (!signInLost) {
    try {
      for (const siteId of await sitesWithLiveRuns(s)) {
        const d = await computeSiteDrift(s, siteId, runId);
        if (d.drifted === 0) continue;
        const site = await s.selectFrom('discovery_sites').select(['sitecode', 'name']).where('id', '=', siteId).executeTakeFirst();
        drift.push({ sitecode: site?.sitecode ?? '?', name: site?.name ?? null, drifted: d.drifted });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[discovery ${runId}] drift check failed: ${(e as Error).message}`);
    }
  }

  await notifyRunComplete(db, s, enqueueMail, {
    tenantId,
    runId,
    drift,
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

  if (!signInLost && readOtherVoiceUsers) await readOtherVoiceSettings(s, schema, exec, runId);
}

/** The background voice settings pass in flight per customer schema; a new sync stops it. */
const backgroundVoice = new Map<string, { stop: () => void }>();

/**
 * After the run has finished (status, summary and email are done), reads the voice settings of the voice-enabled users who are not in
 * Site Data or Design & Build. Nothing waits on these, so the run no longer takes up to 90 minutes longer on a big tenant. The run row
 * is not touched until the end, when `summary.voiceSettings` says how far it got. Best-effort: the users not read are read next sync.
 */
async function readOtherVoiceSettings(s: Scoped, schema: string, exec: TeamsExecutor, runId: string) {
  let stopped = false;
  const token = { stop: () => void (stopped = true) };
  backgroundVoice.set(schema, token);
  const progress = emptyProgress(); // collects errors; never saved over the finished run's own progress
  try {
    const due = await usersNeedingVoiceSettings(s, schema, 12 * 3600_000, 'others');
    if (!due.length) return;
    const r = await syncUserVoiceSettings(s, exec, runId, due.map((u) => ({ objectId: u.object_id, upn: u.upn })), progress, {
      budgetMs: 90 * 60_000,
      shouldStop: () => stopped,
      saveNotes: false,
    });
    const voiceSettings = { due: due.length, read: r.read, failed: r.failed, unfinished: r.stoppedEarly, errors: progress.errors.slice(0, 20).map((e) => e.message) };
    await s
      .updateTable('tenant_discovery_runs')
      .set({ summary: sql`summary || ${JSON.stringify({ voiceSettings })}::jsonb` as never })
      .where('id', '=', runId)
      .execute();
    // eslint-disable-next-line no-console
    console.log(`[discovery ${runId}] voice settings after the run: read ${r.read} of ${due.length}${r.stoppedEarly ? ' (the rest follow next sync)' : ''}, ${r.failed} failed`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[discovery ${runId}] voice settings after the run stopped: ${(e as Error).message}`);
  } finally {
    if (backgroundVoice.get(schema) === token) backgroundVoice.delete(schema);
  }
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
    drift?: DiscoveryCompletedContext['drift'];
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

    const webOrigin = await resolveWebOrigin(db);

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
      drift: args.drift ?? [],
      deploymentUrl: webOrigin ? `${webOrigin}/deployment` : '/deployment',
    };

    await enqueueMail({
      template: 'discovery_completed',
      to: { email: user.email, name: user.display_name },
      createdBy: args.operatorUserId,
      related: { type: 'tenant_discovery_run', id: args.runId },
      context,
      tenantId: args.tenantId,
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
  /** the customer's schema, for the raw SQL bulk updates */
  schema: string;
  /** ids of the objects this run saw, per type: what a successful step tombstones is everything live of its type not in here */
  seen: Map<TenantObjectType, Set<string>>;
  /** where the time went, per step, for the summary and the log (`summary.timings`, seconds) */
  timings: Record<string, StepTiming>;
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

/** Milliseconds a step spent in all, waiting for Teams to answer, and storing; written to the summary in seconds. */
interface StepTiming {
  ms: number;
  teamsMs: number;
  storeMs: number;
}
const timingFor = (ctx: RunContext, step: string): StepTiming => (ctx.timings[step] ??= { ms: 0, teamsMs: 0, storeMs: 0 });
const secs = (ms: number) => Math.round(ms / 100) / 10;
const minsSecs = (ms: number) => (ms < 90_000 ? `${secs(ms)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

/** What a step already has stored for one object: enough to tell whether it changed, without its data. */
interface StoredObject {
  id: string;
  hash: string | null;
  display_name: string | null;
  removed_at: string | null;
}

/** Objects are stored this many at a time: one statement per batch instead of two or three per object. */
const STORE_BATCH = 500;
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
 * query load flat on large tenants we read what is stored for this object type
 * once (ids and content hashes, not the data), store records 500 at a time, and
 * rewrite only the objects that changed: an unchanged one just has its "seen"
 * fields moved on. Rewriting every object's data on every sync was most of the
 * database load a big sync put on Postgres (the full-text column is recomputed
 * and every index updated for each rewrite), which also slowed the web app.
 */
async function runSpec(
  s: Scoped,
  exec: TeamsExecutor,
  runId: string,
  spec: CmdletSpec,
  ctx: RunContext,
  progress: TenantDiscoveryProgress,
  filterOpts: DiscoveryFilterOpts = {},
): Promise<{ stored: number; complete: boolean }> {
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
  const prev = new Map<string, StoredObject>();
  for (const row of await s
    .selectFrom('tenant_objects')
    .select(['id', 'object_key', 'content_hash', 'display_name', 'removed_at'])
    .where('object_type', '=', spec.objectType)
    .execute()) {
    prev.set(row.object_key, {
      id: row.id,
      hash: row.content_hash,
      display_name: row.display_name,
      removed_at: row.removed_at,
    });
  }
  // What each user's tenant_users row was projected from: an unchanged one is not rewritten.
  const projected = new Map<string, Projected>();
  if (spec.objectType === 'user') {
    for (const u of await s.selectFrom('tenant_users').select(['object_id', 'projection_hash', 'removed_at']).execute()) {
      projected.set(u.object_id, { hash: u.projection_hash, removed: !!u.removed_at });
    }
  }
  const seenIds = ctx.seen.get(spec.objectType) ?? new Set<string>();
  ctx.seen.set(spec.objectType, seenIds);
  const timing = timingFor(ctx, progress.step ?? spec.objectType);
  /** Waits for Teams, counting the time as waiting on Teams. */
  const fromTeams = async <T>(p: Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await p;
    } finally {
      timing.teamsMs += Date.now() - t0;
    }
  };

  const versions: NewVersion[] = [];
  // Numbers Teams has released since the last sync (assigned -> unassigned): they start the number cool-off.
  const released: string[] = [];
  const flushVersions = async () => {
    if (released.length) await markNumbersReleased(s, released.splice(0, released.length), 'Released in Teams (seen by Discovery)');
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
        queued.push({ key, name: spec.name(r), data: r });
        if (queued.length >= STORE_BATCH) await storeQueued();
      }
    }
    await storeQueued();
  };

  let queued: { key: string; name: string | null; data: Rec }[] = [];
  const storeQueued = async () => {
    if (!queued.length) return;
    const batch = queued;
    queued = [];
    const t0 = Date.now();
    await storeBatch(batch);
    if (versions.length >= 500) await flushVersions();
    timing.storeMs += Date.now() - t0;
    // heartbeat the run row so the UI shows the count climbing on a big step
    if (stored - lastSaved >= 250) {
      lastSaved = stored;
      progress.note = expected
        ? `Storing ${noun}: ${stored.toLocaleString()} / ${expected.toLocaleString()}…`
        : `Storing ${stored.toLocaleString()} ${noun}…`;
      await saveProgress(s, runId, progress);
    }
  };

  /** Stores one batch: new, re-added and changed objects are written; unchanged ones are not written at all (the run remembers it saw them). */
  const storeBatch = async (items: { key: string; name: string | null; data: Rec }[]) => {
    const now = new Date().toISOString();
    // one row per key (a key twice in one statement is an error); the later record wins
    const rows = [...new Map(items.map((i) => [i.key, i])).values()].map((i) => ({ ...i, hash: hashOf(i.data), p: prev.get(i.key) }));
    // The stored data is read back only where it is needed: for the history row of a change, or to compare an object stored before
    // content hashes existed (the first sync after migration 0080).
    const needData = rows.filter((x) => x.p && (x.p.removed_at || x.p.hash !== x.hash || (x.p.display_name ?? null) !== (x.name ?? null)));
    const before = new Map<string, Rec>();
    if (needData.length) {
      for (const row of await s.selectFrom('tenant_objects').select(['id', 'data']).where('id', 'in', needData.map((x) => x.p!.id)).execute()) {
        before.set(row.id, row.data as Rec);
      }
    }
    const judged = rows.map((x) => {
      const old = x.p ? (before.get(x.p.id) ?? null) : null;
      let change: TenantObjectChangeKind | null = null;
      if (!x.p) change = 'added';
      else if (x.p.removed_at) change = 'readded';
      else if ((x.p.display_name ?? null) !== (x.name ?? null)) change = 'updated';
      else if (x.p.hash !== x.hash && (x.p.hash !== null || canon(old) !== canon(x.data))) change = 'updated';
      return { ...x, old, change };
    });

    const ids = new Map<string, string>();
    const write = judged.filter((x) => x.change);
    if (write.length) {
      const written = await s
        .insertInto('tenant_objects')
        .values(
          write.map((x) => ({
            object_type: spec.objectType,
            object_key: x.key,
            display_name: x.name,
            data: x.data,
            content_hash: x.hash,
            first_seen_run_id: runId,
            last_seen_run_id: runId,
            discovered_at: now,
            content_changed_at: now,
          })),
        )
        .onConflict((oc) =>
          oc.columns(['object_type', 'object_key']).doUpdateSet((eb) => ({
            display_name: eb.ref('excluded.display_name'),
            data: eb.ref('excluded.data'),
            content_hash: eb.ref('excluded.content_hash'),
            last_seen_run_id: runId,
            discovered_at: now,
            removed_at: null,
            content_changed_at: now,
          })),
        )
        .returning(['id', 'object_key'])
        .execute();
      for (const w of written) ids.set(w.object_key, w.id);
    }
    const same = judged.filter((x) => !x.change);
    for (const x of same) ids.set(x.key, x.p!.id);
    // An unchanged object is left alone. Only one stored before migration 0080 is written once, to give it its content hash.
    const unhashed = same.filter((x) => x.p!.hash === null);
    if (unhashed.length) {
      await sql`UPDATE ${sql.table(`${ctx.schema}.tenant_objects`)} AS t SET content_hash = v.h
        FROM unnest(${unhashed.map((x) => x.p!.id)}::uuid[], ${unhashed.map((x) => x.hash)}::text[]) AS v(id, h)
        WHERE t.id = v.id`.execute(s);
    }

    const users: { objectId: string; r: Rec }[] = [];
    for (const x of judged) {
      const objectId = ids.get(x.key)!;
      seenIds.add(objectId);
      prev.set(x.key, { id: objectId, hash: x.hash, display_name: x.name, removed_at: null });
      if (spec.objectType === 'phone_number' && numberReleasedInTeams(x.old, x.data)) released.push(x.key);
      if (x.change) {
        progress.changed[x.change] += 1;
        versions.push({
          object_id: objectId,
          run_id: runId,
          object_type: spec.objectType,
          object_key: x.key,
          display_name: x.name,
          change_kind: x.change,
          changed_fields: x.change === 'updated' ? diffKeys(x.old, x.data) : [],
          before: x.old,
          after: x.data,
          changed_at: now,
        });
      }
      if (spec.objectType === 'user') users.push({ objectId, r: x.data });
    }
    if (users.length) await projectUsers(s, runId, users, projected);
    if (spec.objectType === 'policy' && spec.policyType) {
      for (const x of judged) await projectPolicy(s, runId, ids.get(x.key)!, spec.policyType, x.data);
    }
    stored += items.length;
    progress.counts[spec.objectType] = base + stored;
  };

  const qopts = { select: spec.select, depth: spec.depth, timeoutMs: spec.timeoutMs };

  // The objects stored so far are already updated in tenant_objects, so their
  // history rows must be written too even if the step fails part-way -
  // otherwise the next run diffs against the new data and the change is
  // never recorded anywhere.
  const started = Date.now();
  const teamsBefore = timing.teamsMs;
  const storeBefore = timing.storeMs;
  try {
    return await fetchAndStore();
  } finally {
    await flushVersions().catch((e) => {
      // eslint-disable-next-line no-console
      console.warn(`[discovery ${runId}] could not save change history: ${(e as Error).message}`);
    });
    const took = Date.now() - started;
    timing.ms += took;
    // eslint-disable-next-line no-console
    console.log(
      `[discovery ${runId}] ${spec.command}: ${stored.toLocaleString()} ${noun} in ${minsSecs(took)}` +
        ` (waiting on Teams ${minsSecs(timing.teamsMs - teamsBefore)}, storing ${minsSecs(timing.storeMs - storeBefore)})`,
    );
  }

  async function fetchAndStore(): Promise<{ stored: number; complete: boolean }> {

  // Bucketed fetch (Get-CsOnlineUser): one -Filter per disjoint slice, so a huge
  // result comes back in visible chunks and no single call can time out. One
  // bad bucket is recorded and skipped - it must not abort the others.
  if (spec.buckets) {
    const buckets = spec.buckets(filterOpts);
    let fetched = 0;
    // A slice that failed means part of the type was never seen this run, so
    // it must not be reconciled (that would mark every user in it removed).
    let failedBuckets = 0;
    // The next slice is asked for before this one is stored, so Teams works on it while the database stores this one (the session
    // runs one command at a time, so the order is unchanged).
    const ask = (i: number) => {
      const p = exec.query(spec.command, { Filter: buckets[i].filter, ...(spec.resultSize ? { ResultSize: spec.resultSize } : {}) }, qopts);
      p.catch(() => undefined); // handled when it is awaited; this only stops an unhandled rejection if the step ends first
      return p;
    };
    let nextSlice = buckets.length ? ask(0) : null;
    for (let i = 0; i < buckets.length; i++) {
      const bk = buckets[i];
      progress.note = `Fetching ${noun}: ${fetched.toLocaleString()} so far (${bk.label}, ${i + 1}/${buckets.length})…`;
      await saveProgress(s, runId, progress);
      const thisSlice = nextSlice!;
      nextSlice = i + 1 < buckets.length ? ask(i + 1) : null;
      let recs: unknown[];
      try {
        recs = await fromTeams(thisSlice);
      } catch (e) {
        const message = (e as Error).message ?? String(e);
        if (!exec.alive || /pwsh exited|could not start pwsh|executor disposed|not connected|session is disconnected/i.test(message)) {
          throw e; // session really gone - let the step handler stop the run
        }
        progress.errors.push({
          step: progress.step ?? 'users',
          message: `bucket "${bk.label}": ${message}`,
        });
        failedBuckets += 1;
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
    if (failedBuckets) {
      progress.errors.push({
        step: progress.step ?? 'users',
        message: `${failedBuckets} of ${buckets.length} slices failed, so ${noun} not seen this run were left as they were (not marked removed).`,
      });
    }
    return { stored, complete: failedBuckets === 0 };
  }

  if (!spec.page) {
    progress.note = `Fetching ${noun} from the tenant (this can take a few minutes on a large tenant)…`;
    await saveProgress(s, runId, progress);
    const records = await fromTeams(exec.query(spec.command, spec.resultSize ? { ResultSize: spec.resultSize } : {}, qopts));
    expected = records.length;
    progress.note = `Fetched ${records.length.toLocaleString()} ${noun}, storing…`;
    await saveProgress(s, runId, progress);
    await handle(records);
    await flushVersions();
    return { stored, complete: true };
  }

  // Paged: keep going until a short page.
  const size = spec.page.size;
  for (let skip = 0; ; skip += size) {
    progress.note = `Fetching ${noun}${skip ? ` (from ${skip.toLocaleString()})` : ''}…`;
    await saveProgress(s, runId, progress);
    const params = spec.page.style === 'first-skip' ? { First: size, Skip: skip } : { Top: size, Skip: skip };
    const batch = await fromTeams(exec.query(spec.command, params, qopts));
    await handle(batch);
    if (batch.length < size) break;
    // Safety valve. Stopping here means objects past this point weren't
    // seen, so the step mustn't count as complete (that would mark them removed).
    if (skip > 500_000) return { stored, complete: false };
  }
  await flushVersions();
  return { stored, complete: true };
  }
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
 * Used by the targeted check, which reads a handful of users; a sync stores in batches (runSpec).
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
      content_hash: hashOf(data),
      first_seen_run_id: runId,
      last_seen_run_id: runId,
      discovered_at: now,
      content_changed_at: change ? now : null,
    })
    .onConflict((oc) =>
      oc.columns(['object_type', 'object_key']).doUpdateSet({
        display_name: displayName,
        data,
        content_hash: hashOf(data),
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
  await projectUsers(s, runId, [{ objectId, r }]);
}

/** The `tenant_users` columns a sync sets from the record; `projection_hash` is the hash of exactly these. */
const USER_COLUMNS = [
  'upn',
  'entra_id',
  'display_name',
  'account_type',
  'account_enabled',
  'enterprise_voice_enabled',
  'line_uri',
  'telephone_numbers',
  'feature_types',
  'assigned_plans',
  'usage_location',
  'department',
  'job_title',
  'interpreted_user_type',
  'policies',
  'effective_policy_assignments',
  'when_changed',
  'removed_at',
] as const;

/** What a user's `tenant_users` row was last projected from, as `runSpec` loads it. */
interface Projected {
  hash: string | null;
  removed: boolean;
}

/**
 * Projects users into `tenant_users` in one statement. With `known` (a sync), a user whose row was projected from exactly the same
 * values and is live is skipped: nothing is written for it. A change to what is projected changes the hash, so it still reaches every
 * user. Without `known` (a targeted check) every row is written, which also moves `last_seen_run_id` on (deployment-verify reads it).
 * If the batch is refused (two accounts with one UPN, say), each user is tried on its own so the others are kept, and the first error
 * is thrown so the step is not counted complete.
 */
async function projectUsers(s: Scoped, runId: string, users: { objectId: string; r: Rec }[], known?: Map<string, Projected>) {
  const rows = [...new Map(users.map((u) => [u.objectId, userValues(runId, u.objectId, u.r)])).values()]
    .filter((v) => !!v)
    .map((v) => ({ ...v, projection_hash: hashOf(Object.fromEntries(USER_COLUMNS.map((c) => [c, v[c]]))) }))
    .filter((v) => {
      const k = known?.get(v.object_id);
      return !k || k.removed || k.hash !== v.projection_hash;
    });
  if (!rows.length) return;
  const upsert = (values: typeof rows) =>
    s
      .insertInto('tenant_users')
      .values(values)
      .onConflict((oc) =>
        oc
          .column('object_id')
          .doUpdateSet(
            (eb) =>
              ({
                ...Object.fromEntries(USER_COLUMNS.map((c) => [c, eb.ref(`excluded.${c}`)])),
                projection_hash: eb.ref('excluded.projection_hash'),
                last_seen_run_id: runId,
              }) as never,
          ),
      )
      .execute();
  let first: unknown = null;
  try {
    await upsert(rows);
  } catch {
    for (const row of rows) {
      try {
        await upsert([row]);
      } catch (e) {
        first ??= e;
      }
    }
  }
  for (const r of rows) known?.set(r.object_id, { hash: r.projection_hash, removed: false });
  if (first) throw first;
}

function userValues(runId: string, objectId: string, r: Rec) {
  const upn = str(r.UserPrincipalName);
  if (!upn) return null;
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
  return values;
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
export async function runTargetedUserSync(
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
    const prev = prevRow ? { data: prevRow.data as Rec, display_name: prevRow.display_name, removed_at: prevRow.removed_at } : undefined;
    const { id: objectId, change } = await upsertObject(s, runId, 'user', key, name, r, prev);
    // A Validate check updates the stored user, so it records the change like
    // a sync does - otherwise the next sync diffs against the new data and the
    // change never shows in the user's history or the Changes tab.
    if (change) {
      progress.changed[change] += 1;
      await s
        .insertInto('tenant_object_versions')
        .values({
          object_id: objectId,
          run_id: runId,
          object_type: 'user',
          object_key: key,
          display_name: name,
          change_kind: change,
          changed_fields: change === 'updated' ? diffKeys(prev?.data ?? null, r) : [],
          before: prev?.data ?? null,
          after: r,
          changed_at: new Date().toISOString(),
        })
        .execute();
    }
    await projectUser(s, runId, objectId, r);
    progress.counts.user += 1;
  }
  // Voice settings for the same users, read in batches (a user with no voice features is skipped).
  const found = await s
    .selectFrom('tenant_users')
    .select(['object_id', 'upn', 'enterprise_voice_enabled', 'line_uri'])
    .where('removed_at', 'is', null)
    .where(sql`lower(upn)`, 'in', upns.map((u) => u.toLowerCase()))
    .execute();
  await syncUserVoiceSettings(s, exec, runId, found.filter(isVoiceEnabled).map((u) => ({ objectId: u.object_id, upn: u.upn })), progress);
  progress.note = null;
}

/** A user with voice features: Enterprise Voice on, or a phone number. Everything else has no Teams voice settings worth reading. */
const isVoiceEnabled = (u: { enterprise_voice_enabled: boolean | null; line_uri: string | null }) => u.enterprise_voice_enabled === true || !!u.line_uri;

/** How many users go in one round trip to the session. */
const VOICE_SETTINGS_BATCH = 20;

/**
 * Everything Teams voice keeps per user beyond Get-CsOnlineUser, read for voice-enabled users only:
 * Get-CsUserCallingSettings (call forwarding, simultaneous ring, unanswered routing, call group, delegates, busy on busy) and
 * Get-CsOnlineVoicemailUserSettings (voicemail on/off, language, greeting and transcription settings). Neither has a bulk form, so each
 * batch of users is read in one round trip. A user that fails (no mailbox, say) is skipped and recorded as one error line, never failing
 * the others. `budgetMs` ends the pass early on a huge tenant; users are taken oldest-read first, so the next run carries on.
 */
export async function syncUserVoiceSettings(
  s: Scoped,
  exec: TeamsExecutor,
  runId: string,
  users: { objectId: string; upn: string }[],
  progress: TenantDiscoveryProgress,
  /** `shouldStop`: checked between batches (a newer sync took over). `saveNotes: false`: never write the run row (it has finished). */
  opts: { budgetMs?: number; shouldStop?: () => boolean; saveNotes?: boolean } = {},
): Promise<{ read: number; failed: number; stoppedEarly: boolean }> {
  const started = Date.now();
  const saveNotes = opts.saveNotes !== false;
  let read = 0;
  let failed = 0;
  for (let i = 0; i < users.length; i += VOICE_SETTINGS_BATCH) {
    if ((opts.budgetMs && Date.now() - started > opts.budgetMs) || opts.shouldStop?.()) {
      progress.note = `Read voice settings for ${read.toLocaleString()} of ${users.length.toLocaleString()} voice users; the rest follow on the next sync.`;
      if (saveNotes) await saveProgress(s, runId, progress);
      return { read, failed, stoppedEarly: true };
    }
    const batch = users.slice(i, i + VOICE_SETTINGS_BATCH);
    progress.note = `Reading voice settings: ${Math.min(i + batch.length, users.length).toLocaleString()} / ${users.length.toLocaleString()} voice-enabled users…`;
    if (saveNotes) await saveProgress(s, runId, progress);
    let results: Awaited<ReturnType<TeamsExecutor['queryMany']>>;
    try {
      results = await exec.queryMany(
        batch.flatMap((u) => [
          { key: `c:${u.objectId}`, command: 'Get-CsUserCallingSettings', params: { Identity: u.upn } },
          { key: `v:${u.objectId}`, command: 'Get-CsOnlineVoicemailUserSettings', params: { Identity: u.upn } },
        ]),
        { depth: 4, timeoutMs: 10 * 60_000 },
      );
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      if (!exec.alive || /pwsh exited|could not start pwsh|executor disposed|not connected|session is disconnected/i.test(message)) throw e;
      progress.errors.push({ step: 'users', message: `voice settings (${batch.length} users): ${message}` });
      failed += batch.length;
      continue;
    }
    const byKey = new Map(results.map((r) => [r.key, r]));
    for (const u of batch) {
      const calling = byKey.get(`c:${u.objectId}`);
      const voicemail = byKey.get(`v:${u.objectId}`);
      const callingRec = calling?.records?.find((x) => x && typeof x === 'object');
      const vmRec = voicemail?.records?.find((x) => x && typeof x === 'object') as Rec | undefined;
      if (!callingRec && !vmRec) {
        failed += 1;
        const why = calling?.error ?? voicemail?.error;
        if (why && progress.errors.length < 50) progress.errors.push({ step: 'users', message: `${u.upn}: ${why}` });
        continue;
      }
      const set: Record<string, unknown> = { voice_settings_at: new Date().toISOString() };
      if (callingRec) set.calling_settings = parseLiveCallingSettings(callingRec);
      if (vmRec) {
        set.voicemail_settings = vmRec;
        set.voicemail_enabled = bool(vmRec.VoicemailEnabled);
        set.voicemail_prompt_language = str(vmRec.PromptLanguage);
      }
      await s.updateTable('tenant_users').set(set as never).where('object_id', '=', u.objectId).execute();
      read += 1;
    }
  }
  return { read, failed, stoppedEarly: false };
}

/**
 * The voice-enabled users whose settings are oldest (never read first), skipping any read within `freshMs`. `in_sites`: only those in
 * Site Data or Design & Build (as a user or a common area phone, matched on UPN); `others`: everyone else.
 */
async function usersNeedingVoiceSettings(s: Scoped, schema: string, freshMs: number, which: 'in_sites' | 'others') {
  const cutoff = new Date(Date.now() - freshMs).toISOString();
  const inSites = sql<boolean>`lower(upn) IN (
    SELECT lower(upn) FROM ${sql.table(`${schema}.discovery_users`)} WHERE upn IS NOT NULL
    UNION SELECT lower(upn) FROM ${sql.table(`${schema}.discovery_caps`)} WHERE upn IS NOT NULL
    UNION SELECT lower(upn) FROM ${sql.table(`${schema}.build_users`)} WHERE upn IS NOT NULL
    UNION SELECT lower(upn) FROM ${sql.table(`${schema}.build_caps`)} WHERE upn IS NOT NULL)`;
  return s
    .selectFrom('tenant_users')
    .select(['object_id', 'upn'])
    .where('removed_at', 'is', null)
    .where((eb) => eb.or([eb('enterprise_voice_enabled', '=', true), eb('line_uri', 'is not', null)]))
    .where((eb) => eb.or([eb('voice_settings_at', 'is', null), eb('voice_settings_at', '<', cutoff)]))
    .where(which === 'in_sites' ? inSites : sql<boolean>`NOT (${inSites})`)
    .orderBy('voice_settings_at', (o) => o.asc().nullsFirst())
    .execute();
}

/**
 * Refreshes the M365 group cache (`tenant_groups`) from the tenant's live
 * Graph data, for the Shared Voicemail `groupId` lookup - shared by both a
 * fresh Graph sign-in (`handleGraphConnect`, apps/worker/src/main.ts) and,
 * per this run, every subsequent discovery sync on a connection that still
 * has an alive Graph sub-session (`exec.graphAlive`), so the cache stays
 * current without requiring the engineer to re-sign-in to Graph each time.
 */
export async function syncTenantGroups(s: Scoped, exec: TeamsExecutor): Promise<number> {
  const syncStart = new Date().toISOString();
  const groups = await exec.graphList('/groups?$select=id,displayName,mail');
  const rows = [
    ...new Map(
      (groups as { id?: string; displayName?: string; mail?: string | null }[])
        .filter((g) => g.id && g.displayName)
        .map((g) => [g.id!, { object_id: g.id!, display_name: g.displayName!, mail: g.mail ?? null, synced_at: new Date().toISOString() }]),
    ).values(),
  ];
  // 500 at a time: a big tenant has thousands of groups
  for (let i = 0; i < rows.length; i += 500) {
    await s
      .insertInto('tenant_groups')
      .values(rows.slice(i, i + 500))
      .onConflict((oc) =>
        oc.column('object_id').doUpdateSet((eb) => ({ display_name: eb.ref('excluded.display_name'), mail: eb.ref('excluded.mail'), synced_at: eb.ref('excluded.synced_at') })),
      )
      .execute();
  }
  const synced = rows.length;
  // Groups deleted from the tenant drop out of the cache, so they can't be
  // picked as a Shared Voicemail target any more. Only after a full list that
  // returned something - an empty answer is more likely a hiccup than a tenant
  // with no groups at all.
  if (synced > 0) await s.deleteFrom('tenant_groups').where('synced_at', '<', syncStart).execute();
  return synced;
}

/**
 * The "Resource Account Request" workflow's auto-detection step: once an
 * engineer generates a request document for a not-yet-live
 * build_resource_accounts row (requested_at gets stamped then), this is
 * what promotes it to "Created & licensed" on the next sync - no manual
 * toggle needed. Runs tenant-wide (Discovery isn't site-scoped) after a
 * successful 'resource_account' step, matching every build_resource_accounts
 * row against this run's fresh tenant_objects snapshot by UPN.
 *
 * Get-CsOnlineApplicationInstance (the cmdlet backing this object type)
 * only ever returns an object once New-CsOnlineApplicationInstance has
 * already run against it successfully - which itself requires the Phone
 * System (Virtual User) license to already be applied. So "appears in this
 * sweep at all" is exactly equivalent to "created & licensed"; no separate
 * license check is needed.
 *
 * Also backfills a missing `phone_number` from the same live record's
 * PhoneNumber field - the bug this fixes: populateResourceAccounts only
 * ever copied UserPrincipalName/ApplicationId from a live match, never the
 * number, so a linked resource account's Number column stayed blank
 * forever even once live. Only ever fills a *missing* number - never
 * overwrites one an engineer already set (a planned number for an account
 * not live yet is real input, not something a blank/stale live record
 * should clear). Best-effort, like syncVoicemailSettings above - never
 * fails the run.
 */
async function linkRequestedResourceAccounts(s: Scoped) {
  try {
    const rows = await s
      .selectFrom('build_resource_accounts')
      .select(['id', 'upn', 'kind', 'application_id', 'requested_at', 'phone_number'])
      .execute();
    if (!rows.length) return;
    const liveByUpn = new Map(
      (
        await s
          .selectFrom('tenant_objects')
          .select('data')
          .where('object_type', '=', 'resource_account')
          .where('removed_at', 'is', null)
          .execute()
      )
        .map((r) => {
          const d = r.data as Rec;
          const upn = str(d.UserPrincipalName)?.toLowerCase();
          const phone = str(d.PhoneNumber);
          return upn ? [upn, phone ? phone.replace(/^tel:/i, '') : null] : null;
        })
        .filter((e): e is [string, string | null] => !!e),
    );
    const now = new Date().toISOString();
    for (const row of rows) {
      const live = liveByUpn.get(row.upn.toLowerCase());
      if (live === undefined) continue;
      const patch: Record<string, unknown> = {};
      if (!row.application_id && row.requested_at) {
        patch.application_id = RESOURCE_ACCOUNT_APPLICATION_IDS[row.kind];
        patch.linked_at = now;
      }
      if (live && !row.phone_number) patch.phone_number = live;
      if (Object.keys(patch).length) {
        await s.updateTable('build_resource_accounts').set(patch as never).where('id', '=', row.id).execute();
      }
    }
  } catch {
    // best-effort - see docstring
  }
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
