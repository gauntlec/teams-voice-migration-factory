import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { sql } from 'kysely';
import {
  buildAutoAttendantCrossRef,
  audioImportMap,
  computeSiteDrift,
  createDb,
  platformDb,
  resolveAutoAttendantDeepContext,
  resolveLiveAutoAttendantState,
  resolveLiveCallQueueState,
  resolveLiveIdentityState,
  resolveLiveSharedCallingPolicyState,
  tenantDb, emailEnabled, webOrigin as resolveWebOrigin, sweepStaffAccess } from '@tvmf/db';
import { HUB_HEARTBEAT_SECONDS, NOT_DEPLOYED_CMDLET, buildColorRamp, siteContactTargets, type Branding, type DiscoverySiteOverview, type PortDocumentItemSummary } from '@tvmf/shared';
import {
  collectAutoAttendantUserUpns,
  collectCallQueueTargetUpns,
  orderAutoAttendantRowsByDependency,
  planAutoAttendantRow,
  planCallQueueRow,
  planSharedCallingPolicyRow,
  DEFERRED_SCRIPT_NOTE,
  renderCommand,
  renderExportScript,
  type AutoAttendantCallableEntity,
  type AutoAttendantCallFlow,
  type AutoAttendantCrossRef,
  type AutoAttendantHolidayCallFlow,
  type AutoAttendantLiveState,
  type AutoAttendantSchedule,
  type BuildAutoAttendantRow,
  type CallQueueActionSettings,
  type CallQueueLiveState,
  type CmdletInvocation,
  type DeploymentCompletedContext,
} from '@tvmf/shared';
import { SimulatedTeamsExecutor, type TeamsExecutor } from './teams/executor';
import { PwshTeamsExecutor } from './teams/pwsh-executor';
import { CustomerBeingDeletedError, refuseJobForDeletedCustomer, releaseTenantSessions } from './tenant-release';
import { handleTenantDiscoveryRun, syncTenantGroups } from './discovery/run';
import { resolveAudioPlaceholders as resolveAudioPlaceholdersFor } from './deployment-audio';
import { beforeStateResolver, planIdentityRows, planResourceAccountRows, verifyDeployment } from './deployment-verify';
import { renderEmail } from './mail/templates';
import type { EmailBranding } from './mail/layout';
import { resolveMail, sendMail } from './mail/mailer';
import { makeMailEnqueuer } from './mail/enqueue';
import { sendHubHeartbeat } from './hub-heartbeat';
import { HubTunnel } from './hub-tunnel';
import { planDelivery } from './mail/sandbox';
import { contextForRender, invitationPasswordMissing, maskSecrets, removeInvitationPassword as removeInvitationPasswordRow } from './mail/invitation-secret';
import { deliverWebhooks, sweepAgents } from './agents';
import { deliverMspNotifications } from './msp-notify';
import { sweepIncidents } from './incidents';
import { finishAgentDeployment, recordServiceRequestRun, sweepServiceRequests } from './service-requests';

const QUEUE_NAME = 'deployments';
const MAIL_QUEUE_NAME = 'mail';
const connection = new IORedis(process.env.REDIS_URL ?? 'redis://redis:6379', {
  maxRetriesPerRequest: null,
});
const { db } = createDb();
/** Producer for the `mail` queue — used by jobs the worker originates. */
const enqueueMail = makeMailEnqueuer(db, connection);

/**
 * TEAMS_EXECUTOR=pwsh (default) drives the real MicrosoftTeams module;
 * =simulated returns fake data so the app runs without a customer tenant.
 */
const EXECUTOR_KIND = (process.env.TEAMS_EXECUTOR ?? 'pwsh').toLowerCase();
const newExecutor = (): TeamsExecutor =>
  EXECUTOR_KIND === 'simulated' ? new SimulatedTeamsExecutor() : new PwshTeamsExecutor();

/**
 * Idle sessions are torn down after this long (tokens die with the pwsh
 * process). It's an *idle* timeout - an active run keeps the session alive - and
 * `connections.expires_at` is pushed forward on activity so the UI shows a live
 * session, not a fixed countdown.
 */
const SESSION_TTL_MS = Math.max(5, Number(process.env.TEAMS_SESSION_TTL_MINUTES ?? 240)) * 60_000;

/** In-memory registry of live executors, keyed by connectionId. Never persisted. */
const executors = new Map<string, TeamsExecutor>();
/** connectionId -> tenant schema, so the sweeper can mark the row expired. */
const executorSchema = new Map<string, string>();

async function expireConnection(schema: string, connectionId: string, reason: string) {
  const exec = executors.get(connectionId);
  executors.delete(connectionId);
  executorSchema.delete(connectionId);
  if (exec) await exec.dispose().catch(() => undefined);
  await tenantDb(db, schema)
    .updateTable('connections')
    .set({ status: 'expired', closed_at: new Date().toISOString() })
    .where('id', '=', connectionId)
    .where('status', 'in', ['pending', 'active'])
    .execute()
    .catch(() => undefined);
  // eslint-disable-next-line no-console
  console.log(`[connection ${connectionId}] expired (${reason})`);
}

setInterval(async () => {
  const now = Date.now();
  for (const [id, exec] of executors) {
    const schema = executorSchema.get(id);
    if (!schema) continue;
    // A scheduled live run waiting on this sign-in keeps it alive until it starts (scheduled cutover, migration 0067).
    const waiting = await tenantDb(db, schema)
      .selectFrom('deployments')
      .select('id')
      .where('connection_id', '=', id)
      .where('status', '=', 'queued')
      .where('run_at', 'is not', null)
      .executeTakeFirst()
      .catch(() => undefined);
    if (waiting) exec.lastUsedAt = now;
    if (now - exec.lastUsedAt > SESSION_TTL_MS) {
      void expireConnection(schema, id, 'idle timeout');
    } else {
      // session is alive - keep expires_at ahead of the idle window so the UI
      // (and summary's activeConnection filter) shows a live session
      void tenantDb(db, schema)
        .updateTable('connections')
        .set({ expires_at: new Date(now + SESSION_TTL_MS).toISOString() })
        .where('id', '=', id)
        .where('status', '=', 'active')
        .execute()
        .catch(() => undefined);
    }
  }
}, 60_000).unref();

/**
 * Sessions and discovery runs live only in this process: after a restart every
 * connection row that still says pending/active is dead, and any discovery run
 * still queued/running can never make progress (nothing resumes it). Mark them
 * so the UI asks for a fresh sign-in / lets a new run start instead of hanging.
 */
async function expireOrphanedWork() {
  const tenants = await platformDb(db).selectFrom('tenants').select('schema_name').where('status', '!=', 'deleting').execute();
  let conns = 0;
  let runs = 0;
  let deployments = 0;
  for (const { schema_name } of tenants) {
    const c = await tenantDb(db, schema_name)
      .updateTable('connections')
      .set({ status: 'expired', closed_at: new Date().toISOString() })
      .where('status', 'in', ['pending', 'active'])
      .executeTakeFirst()
      .catch(() => undefined);
    conns += Number(c?.numUpdatedRows ?? 0);
    const r = await tenantDb(db, schema_name)
      .updateTable('tenant_discovery_runs')
      .set({
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: 'The worker restarted before this run finished - start a new discovery.',
      })
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst()
      .catch(() => undefined);
    runs += Number(r?.numUpdatedRows ?? 0);
    const d = await tenantDb(db, schema_name)
      .updateTable('deployments')
      .set({
        status: 'failed',
        finished_at: new Date().toISOString(),
        summary: { applied: 0, skipped: 0, failed: 0, whatif: 0, total: 0 },
      })
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst()
      .catch(() => undefined);
    deployments += Number(d?.numUpdatedRows ?? 0);
    await tenantDb(db, schema_name)
      .updateTable('deployments')
      .set({
        verification: {
          status: 'failed',
          checkedAt: new Date().toISOString(),
          reason: 'The worker restarted before the re-check finished. Run Validate against tenant on this site to check it.',
        },
      })
      .where(sql<boolean>`verification->>'status' = 'pending'`)
      .execute()
      .catch(() => undefined);
  }
  if (conns || runs || deployments) {
    // eslint-disable-next-line no-console
    console.log(
      `startup sweep: expired ${conns} orphaned connection(s), failed ${runs} orphaned discovery run(s), failed ${deployments} orphaned deployment run(s)`,
    );
  }
}
void expireOrphanedWork();

/**
 * Who gets a number-port document email: every active CUSTOMER user scoped to this site (or whole-customer, via an empty
 * `site_ids`), plus the site's Site contact(s) from the overview, picked from the users or typed. Duplicated from the API's
 * equivalent in apps/api/src/modules/number-port/number-port.service.ts rather than shared - api and worker don't share a
 * DB-access layer beyond @tvmf/db's Kysely types.
 */
async function resolvePortRecipients(
  tenantId: string,
  siteId: string,
  overview: DiscoverySiteOverview,
): Promise<{ email: string; name?: string | null }[]> {
  const rows = await platformDb(db)
    .selectFrom('users as u')
    .innerJoin('tenant_memberships as m', 'm.user_id', 'u.id')
    .select(['u.email', 'u.display_name'])
    .where('m.tenant_id', '=', tenantId)
    .where('u.role', '=', 'CUSTOMER')
    .where('u.status', '=', 'active')
    .where(sql<boolean>`(m.site_ids = '{}' or ${siteId}::uuid = any(m.site_ids))`)
    .execute();
  const out = new Map<string, { email: string; name?: string | null }>();
  for (const r of rows) out.set(r.email.toLowerCase(), { email: r.email, name: r.display_name });

  const targets = siteContactTargets(overview);
  if (targets.userIds.length) {
    const picked = await platformDb(db).selectFrom('users').select(['email', 'display_name']).where('id', 'in', targets.userIds).where('status', '=', 'active').execute();
    for (const r of picked) if (!out.has(r.email.toLowerCase())) out.set(r.email.toLowerCase(), { email: r.email, name: r.display_name });
  }
  for (const c of targets.typed) if (!out.has(c.email.toLowerCase())) out.set(c.email.toLowerCase(), c);
  return [...out.values()];
}

/**
 * Periodic nudge for number-port document requests still `awaiting_documents`
 * once each site's configured interval (`overview.portDocReminderDays`,
 * default 7 days) has passed since the last reminder (or since submission,
 * if none has gone out yet). Runs hourly - reminder intervals are measured
 * in days, so this is far more often than needed, but cheap and idempotent.
 */
async function sweepPortDocumentReminders() {
  const webOrigin = await resolveWebOrigin(db);
  const tenants = await platformDb(db).selectFrom('tenants').select(['id', 'schema_name', 'name']).where('status', '!=', 'deleting').execute();
  let sent = 0;
  for (const tenant of tenants) {
    const scoped = tenantDb(db, tenant.schema_name);
    const due = await scoped
      .selectFrom('number_port_requests as req')
      .innerJoin('discovery_number_ranges as r', 'r.id', 'req.range_id')
      .innerJoin('discovery_sites as s', 's.sitecode', 'r.sitecode')
      .select(['req.id', 'req.submitted_at', 'req.reminder_sent_at', 'r.range_start', 'r.range_end', 's.id as site_id', 's.name as site_name', 's.sitecode', 's.overview'])
      .where('req.status', '=', 'awaiting_documents')
      .where('r.kind', '<>', 'retain') // a re-point range has no porting requirements, so no reminders
      .execute();
    for (const row of due) {
      const overview = (row.overview ?? {}) as DiscoverySiteOverview;
      const intervalDays = Math.max(1, overview.portDocReminderDays ?? 7);
      const last = row.reminder_sent_at ?? row.submitted_at;
      if (!last || Date.now() - new Date(last).getTime() < intervalDays * 86_400_000) continue;

      const items = await scoped
        .selectFrom('number_port_request_items as i')
        .innerJoin('port_document_types as dt', 'dt.id', 'i.document_type_id')
        .select(['dt.label', 'i.note', 'i.status', 'i.reject_reason'])
        .where('i.request_id', '=', row.id)
        .execute();
      const itemSummaries: PortDocumentItemSummary[] = items.map((i) => ({
        label: i.label,
        note: i.note,
        status: i.status,
        rejectReason: i.reject_reason,
      }));
      const recipients = await resolvePortRecipients(tenant.id, row.site_id, overview);
      if (!recipients.length) continue; // nothing we can do until a customer contact exists

      for (const to of recipients) {
        await enqueueMail({
          template: 'port_documents_reminder',
          to: { email: to.email, name: to.name },
          context: {
            customerName: tenant.name,
            siteName: row.site_name ?? row.sitecode,
            sitecode: row.sitecode,
            rangeLabel: `${row.range_start} - ${row.range_end}`,
            items: itemSummaries,
            portalUrl: webOrigin
              ? `${webOrigin}/data-collection/sites/${row.site_id}/number-porting`
              : `/data-collection/sites/${row.site_id}/number-porting`,
          },
          tenantId: tenant.id,
        });
      }
      await scoped
        .updateTable('number_port_requests')
        .set({ reminder_sent_at: new Date().toISOString() })
        .where('id', '=', row.id)
        .execute();
      sent += recipients.length;
    }
  }
  if (sent) {
    // eslint-disable-next-line no-console
    console.log(`port-document reminder sweep: sent ${sent} email(s)`);
  }
}
setInterval(() => void sweepPortDocumentReminders(), 60 * 60_000).unref();
void sweepPortDocumentReminders();
// Managed Services: waiting-on-customer reminders (and, later, target warnings).
setInterval(() => void sweepServiceRequests(db, enqueueMail).catch((e) => console.warn('service request sweep failed', e)), 15 * 60_000).unref();
void sweepServiceRequests(db, enqueueMail).catch((e) => console.warn('service request sweep failed', e));
// Incidents: waiting-on-customer reminders, target warnings and misses, auto-close of resolved ones.
setInterval(() => void sweepIncidents(db, enqueueMail).catch((e) => console.warn('incident sweep failed', e)), 5 * 60_000).unref();
void sweepIncidents(db, enqueueMail).catch((e) => console.warn('incident sweep failed', e));
// The Voxshift Hub (if one is connected): report this installation's version and health once a minute.
setInterval(() => void sendHubHeartbeat(db).catch((e) => console.warn('hub heartbeat failed', e)), HUB_HEARTBEAT_SECONDS * 1000).unref();
setTimeout(() => void sendHubHeartbeat(db).catch((e) => console.warn('hub heartbeat failed', e)), 5_000).unref();
// Voxshift staff access (single sign-on): approved windows that have run out end, and requests nobody answered lapse. The API also does this whenever they are looked at.
setInterval(() => void sweepStaffAccess(db).catch((e) => console.warn('staff access sweep failed', e)), 60_000).unref();
// Remote access through the hub: only while the customer's switch is on, one outbound connection the hub sends browser requests down.
new HubTunnel(db).start();
// AI agents: expire proposals, put incidents back in the queue when a lease lapses, clear old events, and push events to webhooks.
setInterval(() => void sweepAgents(db, enqueueMail).catch((e) => console.warn('agent sweep failed', e)), 60_000).unref();
setInterval(() => void deliverMspNotifications(db).catch((e) => console.warn('MSP Teams delivery failed', e)), 15_000).unref();
setInterval(() => void deliverWebhooks(db).catch((e) => console.warn('agent webhook delivery failed', e)), 15_000).unref();

async function handleConnectionStart(job: Job) {
  const { schema, connectionId, tenantDomain } = job.data as {
    schema: string;
    connectionId: string;
    tenantDomain: string | null;
  };
  const exec = newExecutor();
  executors.set(connectionId, exec);
  executorSchema.set(connectionId, schema);

  try {
    const prompt = await exec.beginDeviceCode(tenantDomain);
    await tenantDb(db, schema)
      .updateTable('connections')
      .set({
        status: 'pending',
        user_code: prompt.userCode,
        verification_uri: prompt.verificationUri,
        expires_at: prompt.expiresAt.toISOString(),
      })
      .where('id', '=', connectionId)
      .execute();

    const signIn = await exec.awaitSignIn();
    await tenantDb(db, schema)
      .updateTable('connections')
      .set({
        status: 'active',
        upn: signIn.upn,
        expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      })
      .where('id', '=', connectionId)
      .execute();

    // eslint-disable-next-line no-console
    console.log(`[connection ${connectionId}] active as ${signIn.upn}`);
  } catch (err) {
    await expireConnection(schema, connectionId, (err as Error).message);
    throw err;
  }
}

/**
 * Optional second sign-in on an already-active connection, to Microsoft
 * Graph (`Group.Read.All`, read-only) - lets Design & Build search M365
 * groups by name for the Shared Voicemail `groupId` field. Reuses the same
 * live `TeamsExecutor` already sitting in `executors` for this connection
 * (no separate map, no separate process) - once signed in, pulls the
 * tenant's entire group list and caches it in `tenant_groups` via
 * `syncTenantGroups`, so searching afterward is a normal DB read, not a
 * live round trip per keystroke. The same helper is called again by every
 * subsequent discovery run on this connection (see
 * `discovery/run.ts::handleTenantDiscoveryRun`) for as long as this Graph
 * sub-session stays alive, so the cache doesn't just freeze at this first
 * sign-in.
 */
/** How long to wait for the device code to appear before giving up: it only appears once the session is free to run the sign-in. */
const GRAPH_CODE_WAIT_MS = 90_000;

async function handleGraphConnect(job: Job) {
  const { schema, connectionId } = job.data as { schema: string; connectionId: string };
  const scoped = tenantDb(db, schema);
  const fail = (message: string) =>
    scoped
      .updateTable('connections')
      .set({ graph_status: 'failed', graph_user_code: null, graph_error: message })
      .where('id', '=', connectionId)
      .execute()
      .catch(() => undefined);
  const exec = executors.get(connectionId);
  if (!exec) {
    await fail('The tenant connection is no longer available on the worker. Sign in to the tenant again.');
    throw new Error('the tenant connection is no longer available on the worker - sign in again');
  }
  try {
    // The sign-in shares the session with everything else, which runs one command at a time. If the session is busy the code
    // cannot appear: give up cleanly after a short wait, and drop the queued sign-in so it never runs later unseen.
    let timer: NodeJS.Timeout | undefined;
    const busy = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        exec.cancelGraphSignIn();
        reject(new GraphBusyError());
      }, GRAPH_CODE_WAIT_MS);
    });
    let prompt: Awaited<ReturnType<typeof exec.beginGraphDeviceCode>>;
    try {
      prompt = await Promise.race([exec.beginGraphDeviceCode(), busy]);
    } finally {
      clearTimeout(timer);
    }
    await scoped
      .updateTable('connections')
      .set({
        graph_status: 'pending',
        graph_user_code: prompt.userCode,
        graph_verification_uri: prompt.verificationUri,
        graph_expires_at: prompt.expiresAt.toISOString(),
        graph_error: null,
      })
      .where('id', '=', connectionId)
      .execute();

    const signIn = await exec.awaitGraphSignIn();
    // Connected as soon as the sign-in succeeds. The group list is cached afterwards and best-effort: it queues behind any sync
    // already running on this session, and the connection must not wait for that to show as connected.
    await scoped
      .updateTable('connections')
      .set({ graph_status: 'active', graph_upn: signIn.upn, graph_user_code: null, graph_error: null })
      .where('id', '=', connectionId)
      .execute();
    // eslint-disable-next-line no-console
    console.log(`[connection ${connectionId}] graph active as ${signIn.upn}`);
    try {
      const syncedCount = await syncTenantGroups(scoped, exec);
      // eslint-disable-next-line no-console
      console.log(`[connection ${connectionId}] ${syncedCount} group(s) synced`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[connection ${connectionId}] group sync after sign-in failed: ${(e as Error).message}`);
    }
  } catch (err) {
    const message = (err as Error).message ?? '';
    await fail(
      err instanceof GraphBusyError
        ? err.message
        : /timed out|expired/i.test(message)
          ? 'The sign-in code expired before the sign-in was completed. Add group lookup again.'
          : `Group lookup sign-in failed: ${message.slice(0, 300) || 'no reason given'}`,
    );
    throw err;
  }
}

class GraphBusyError extends Error {
  constructor() {
    super('The session is busy with a sync or another job, so no sign-in code could be shown. Try again when it has finished.');
  }
}

/**
 * Live deployments on one connection share a single pwsh session, and a call's
 * construction steps ($flow1, $ce1, ...) are session variables that persist
 * between round-trips. BullMQ runs several jobs at once, so two live runs on the
 * same connection would interleave and overwrite each other's variables (the
 * final New-CsAutoAttendant then used the other run's call flow - reproduced
 * against the real executor). Run them one at a time per connection.
 */
const connectionLocks = new Map<string, Promise<void>>();

/**
 * How long a live run waits before re-reading what it changed - Teams can take
 * a little while to report a change it has just accepted, and re-reading at
 * once would list it as "still differs". DEPLOY_VERIFY_DELAY_SECONDS, default 60.
 */
const VERIFY_DELAY_MS = Math.max(0, Number(process.env.DEPLOY_VERIFY_DELAY_SECONDS ?? 60)) * 1000;
async function withConnectionLock<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = connectionLocks.get(connectionId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = previous.then(() => mine);
  connectionLocks.set(connectionId, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (connectionLocks.get(connectionId) === tail) connectionLocks.delete(connectionId);
  }
}

async function handleDeploymentRun(job: Job) {
  const { schema, deploymentId, connectionId, mode, scope, operatorUserId, tenantId } = job.data as {
    schema: string;
    deploymentId: string;
    connectionId: string;
    mode: 'dry_run' | 'execute';
    /** serviceRequestId: started from a service request's Deploy tab - see service-requests.ts. */
    scope: { siteId: string; sheets: string[]; rowIds?: string[]; serviceRequestId?: string; agentId?: string; proposalId?: string };
    operatorUserId: string;
    tenantId: string;
  };
  const scoped = tenantDb(db, schema);
  const exec = executors.get(connectionId);
  const startedAt = Date.now();

  // A scheduled run that was cancelled while it waited (its job may still fire if removing it raced) does nothing.
  const current = await scoped.selectFrom('deployments').select('status').where('id', '=', deploymentId).executeTakeFirst();
  if (current && current.status !== 'queued') {
    // eslint-disable-next-line no-console
    console.log(`[deployment ${deploymentId}] not started: it is ${current.status}`);
    return;
  }

  const counts = { applied: 0, skipped: 0, failed: 0, whatif: 0 };
  // One entry per failed cmdlet, with its own error text - see
  // notifyDeploymentRunComplete, which is the entire reason this is tracked
  // separately from `counts.failed` (a count alone can't tell the recipient
  // what actually broke).
  const failures: DeploymentCompletedContext['failures'] = [];
  const scriptLines: string[] = [];
  let seq = 0;

  try {
    // The in-memory executors map is empty after a worker restart, and an
    // idle connection is deleted from it by the sweeper above - either way,
    // a queued job whose connection is gone must fail closed, never fall
    // back to a fake executor that reports every cmdlet as applied without
    // touching the tenant (confirmed this session: the old
    // `?? new SimulatedTeamsExecutor()` fallback did exactly that).
    if (!exec) {
      throw new Error('The tenant connection is no longer available (it expired, or the worker restarted since it was made) - reconnect to the customer tenant and run the deployment again.');
    }
    // Dry runs never run a cmdlet, so only live runs need the lock.
    if (mode === 'execute') await withConnectionLock(connectionId, () => runDeployment(exec));
    else await runDeployment(exec);
  } catch (err) {
    // A run that throws (e.g. a pwsh command timeout - see pwsh-executor.ts)
    // must still leave `deployments` in a terminal state. Without this, the
    // row is orphaned at 'running' forever: confirmed live in production,
    // where a hung New-CsAutoAttendant call timed out in BullMQ but the
    // Postgres row never moved past 'running' because nothing here caught
    // the throw. Mirrors Discovery's own failure path in run.ts.
    const message = (err as Error).message || 'Unknown error';
    // eslint-disable-next-line no-console
    console.error(`[deployment ${deploymentId}] ${mode} failed:`, message);
    await scoped
      .updateTable('deployments')
      .set({
        status: 'failed',
        finished_at: new Date().toISOString(),
        summary: { ...counts, total: seq },
      })
      .where('id', '=', deploymentId)
      .execute();
    await notifyDeploymentRunComplete(scoped, {
      tenantId,
      siteId: scope.siteId,
      deploymentId,
      operatorUserId,
      mode,
      startedAt,
      counts,
      total: seq,
      failures,
      errorMessage: message,
    });
    if (scope.serviceRequestId) {
      await recordServiceRequestRun(db, enqueueMail, {
        tenantId,
        schema,
        serviceRequestId: scope.serviceRequestId,
        deploymentId,
        operatorUserId,
        mode,
        counts,
        errorMessage: message,
        ...(scope.agentId && scope.proposalId ? { agent: { agentId: scope.agentId, proposalId: scope.proposalId } } : {}),
      });
    }
    throw err;
  }

  // Did it land? Re-read what this run touched and compare it to the design
  // (deployment-verify.ts). Outside the connection lock - it only reads, like
  // any Discovery run - and it can never fail the deployment, which is
  // already recorded as finished.
  if (mode === 'execute') {
    let verification: Awaited<ReturnType<typeof verifyDeployment>> | null = null;
    try {
      const v = await verifyDeployment(scoped, exec!, {
        deploymentId,
        siteId: scope.siteId,
        connectionId,
        operatorUserId,
        delayMs: VERIFY_DELAY_MS,
      });
      verification = v;
      // eslint-disable-next-line no-console
      console.log(`[deployment ${deploymentId}] verification: ${v.status}`);
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      // eslint-disable-next-line no-console
      console.warn(`[deployment ${deploymentId}] verification error: ${message}`);
      await scoped
        .updateTable('deployments')
        .set({ verification: { status: 'failed', checkedAt: new Date().toISOString(), reason: `The re-check stopped unexpectedly: ${message.slice(0, 300)}` } })
        .where('id', '=', deploymentId)
        .execute()
        .catch(() => undefined);
    }
    // An assistant's deployment is only "done" once the live tenant has been re-read and matches the design.
    if (scope.serviceRequestId && scope.agentId && scope.proposalId) {
      await finishAgentDeployment(db, enqueueMail, { tenantId, schema, serviceRequestId: scope.serviceRequestId, deploymentId, agentId: scope.agentId, proposalId: scope.proposalId, operatorUserId, verification }).catch((e) =>
        // eslint-disable-next-line no-console
        console.warn(`[deployment ${deploymentId}] could not finish the assistant's deployment: ${(e as Error).message}`),
      );
    }
  }

  async function runDeployment(exec: TeamsExecutor) {
    // Re-checked fresh here rather than trusted from the queued job payload,
    // so toggling this off/on always takes effect on the next cmdlet, even
    // for a run already in flight. See docs/SECURITY.md.
    const tenantRow = await platformDb(db)
      .selectFrom('tenants')
      .select('teams_read_only')
      .where('id', '=', tenantId)
      .executeTakeFirst();
    const teamsReadOnly = tenantRow?.teams_read_only ?? false;

    await scoped
      .updateTable('deployments')
      .set({ status: 'running', started_at: new Date().toISOString() })
      .where('id', '=', deploymentId)
      .execute();

    const whatIf = mode === 'dry_run';

  /**
   * Records one cmdlet's outcome as a deployment_changes row. `before` is what
   * the call is about to change (see beforeStateResolver) - the executor itself
   * doesn't read anything back, and it's what the rollback script restores.
   */
  const record = async (call: CmdletInvocation, res: Awaited<ReturnType<typeof exec.invoke>>, before: Record<string, unknown> = {}) => {
    counts[res.result] += 1;
    if (res.result === 'whatif') {
      if (call.deferred) scriptLines.push(DEFERRED_SCRIPT_NOTE);
      scriptLines.push(renderCommand(call));
    }
    if (res.result === 'failed') {
      failures.push({ object: call.objectType, cmdlet: call.cmdlet, message: res.message ?? 'Unknown error' });
    }
    await scoped
      .insertInto('deployment_changes')
      .values({
        deployment_id: deploymentId,
        seq: ++seq,
        operator_user_id: operatorUserId,
        correlation_id: `${deploymentId}:${seq}`,
        object_type: call.objectType,
        object_id: call.objectId ?? null,
        cmdlet: call.cmdlet,
        parameters: call.parameters as object,
        before: { ...res.before, ...before } as object,
        after: res.after as object,
        result: res.result,
        message: res.message ?? null,
      })
      .execute();
  };

  /**
   * Notes that a user or common area phone was left out (or stopped part way) on the deployment, as a
   * 'skipped' row with a marker cmdlet. Nothing is sent to Teams. The change document and the deployment
   * result list these under "Not deployed".
   */
  const recordNotDeployed = async (row: { objectType: string; id: string; upn: string }, reason: string) => {
    counts.skipped += 1;
    await scoped
      .insertInto('deployment_changes')
      .values({
        deployment_id: deploymentId,
        seq: ++seq,
        operator_user_id: operatorUserId,
        correlation_id: `${deploymentId}:${seq}`,
        object_type: row.objectType,
        object_id: row.id,
        cmdlet: NOT_DEPLOYED_CMDLET,
        parameters: { upn: row.upn } as object,
        before: {} as object,
        after: {} as object,
        result: 'skipped',
        message: reason,
      })
      .execute();
  };

  /**
   * A `deferred` call (e.g. New-CsOnlineApplicationInstance) always needs a
   * manual licensing step a Teams Administrator can't do - it must never run
   * live, in either mode. Render it to the exported script and record it as
   * 'whatif' regardless of `mode`. Returns the cmdlet's result so callers
   * (the call_queues/auto_attendants blocks below) can tell whether a
   * New-CsCallQueue/New-CsAutoAttendant genuinely just created something
   * live, worth a crossRef refresh - see refreshCrossRefEntry.
   */
  // Redirect audio prompts not yet in Teams are imported in this run (deployment-audio.ts).
  const resolveAudioPlaceholders = (call: CmdletInvocation) => resolveAudioPlaceholdersFor(scoped, exec, whatIf || teamsReadOnly, call, record);

  const runCall = async (call: CmdletInvocation, before?: Record<string, unknown>) => {
    if (call.deferred) {
      const res = { result: 'whatif' as const, before: {}, after: {}, message: 'Deferred - needs manual licensing before rerunning.' };
      await record(call, res, before);
      return res.result;
    }
    if (teamsReadOnly) {
      const res = { result: 'whatif' as const, before: {}, after: {}, message: 'Tenant is read-only - cmdlet not sent to Microsoft Teams.' };
      await record(call, res, before);
      return res.result;
    }
    const res = await exec.invoke(call, { whatIf });
    await record(call, res, before);
    return res.result;
  };

  /**
   * Discovery's tenant_objects snapshot (what buildAutoAttendantCrossRef
   * reads) only updates on its own periodic sync - a Call Queue/Auto
   * Attendant this run just created via New-CsCallQueue/New-CsAutoAttendant
   * has no entry there yet. Without this, a later step in the SAME run that
   * targets it by name (an Auto Attendant transferring to a Call Queue it
   * just created, or one Auto Attendant transferring to another created
   * earlier in this same batch) would see it as unresolved and silently skip
   * the target - fixed the same way as before, just one Discovery sync +
   * one more deployment run later. One targeted live lookup closes that gap
   * immediately. Best-effort: a lookup failure here just leaves the object
   * unresolved for the rest of THIS run, exactly as if this refresh didn't
   * exist - it never fails the deployment.
   */
  const refreshCrossRefEntry = async (crossRef: AutoAttendantCrossRef, kind: 'call_queue' | 'auto_attendant', buildId: string, name: string) => {
    try {
      const recs = await exec.query(
        kind === 'call_queue' ? 'Get-CsCallQueue' : 'Get-CsAutoAttendant',
        { NameFilter: name },
        { select: ['Identity', 'Name'] },
      );
      const hit = (recs as Record<string, unknown>[]).find((r) => typeof r.Name === 'string' && r.Name.toLowerCase() === name.toLowerCase());
      const identity = hit && typeof hit.Identity === 'string' ? hit.Identity : undefined;
      if (identity) crossRef.set(`${kind}:${buildId}`, identity);
    } catch {
      // best-effort - see doc comment above
    }
  };

  // Built once, up front, whenever either sheet that can reference a
  // same-site AA/CQ target is in scope - shared by the call_queues block
  // (refreshed after each newly-created queue) and the auto_attendants block
  // (refreshed after each newly-created attendant, and reused instead of
  // rebuilt so it keeps every refresh made earlier in this same run).
  const crossRef: AutoAttendantCrossRef | undefined =
    scope.sheets.includes('call_queues') || scope.sheets.includes('auto_attendants')
      ? await buildAutoAttendantCrossRef(scoped, scope.siteId)
      : undefined;

  // Users, CAPs and resource accounts are planned by the same helpers the
  // post-deploy re-check uses (deployment-verify.ts), and each call records
  // what it's about to change for the rollback script.
  const rowFilter = scope.rowIds?.length ? scope.rowIds : undefined;
  const identityRows = [
    ...(scope.sheets.includes('users') ? await planIdentityRows(scoped, 'build_users', 'user', scope.siteId, rowFilter, true) : []),
    ...(scope.sheets.includes('caps') ? await planIdentityRows(scoped, 'build_caps', 'cap', scope.siteId, rowFilter, true) : []),
    ...(scope.sheets.includes('resource_accounts') ? await planResourceAccountRows(scoped, scope.siteId, rowFilter) : []),
  ];
  const beforeOf = await beforeStateResolver(scoped, identityRows);
  for (const row of identityRows) {
    // Errors are triaged in Design & Build, not here: a row with a blocking problem is left out and the
    // run carries on with the rest. The reasons go on the record and into the change document.
    if (row.skipReasons.length) {
      await recordNotDeployed(row, row.skipReasons.join(' '));
      continue;
    }
    for (const [i, call] of row.calls.entries()) {
      const result = await runCall(call, beforeOf(row, call));
      // One failed command stops that user (later commands usually depend on it); the others still deploy.
      if (result === 'failed' && i < row.calls.length - 1) {
        const left = row.calls.length - 1 - i;
        await recordNotDeployed(row, `Stopped after ${call.cmdlet} failed. ${left} later command${left === 1 ? ' was' : 's were'} not run for this ${row.objectType === 'cap' ? 'common area phone' : 'user'}.`);
        break;
      }
    }
  }

  if (scope.sheets.includes('shared_calling_policies')) {
    let q = scoped.selectFrom('build_shared_calling_policies').selectAll().where('site_id', '=', scope.siteId);
    if (scope.rowIds?.length) q = q.where('id', 'in', scope.rowIds);
    const rows = await q.execute();
    const raIds = [...new Set(rows.map((r) => r.resource_account_id).filter((id): id is string => !!id))];
    const ras = raIds.length
      ? await scoped.selectFrom('build_resource_accounts').select(['id', 'upn']).where('id', 'in', raIds).execute()
      : [];
    const raIdentity = await resolveLiveIdentityState(scoped, ras.map((r) => r.upn));
    const raObjectIds = new Map<string, string>();
    for (const ra of ras) {
      const oid = raIdentity.get(ra.upn.toLowerCase())?.objectId;
      if (oid) raObjectIds.set(ra.id, oid);
    }
    const live = await resolveLiveSharedCallingPolicyState(scoped, rows.map((r) => r.name));
    for (const row of rows) {
      const calls = planSharedCallingPolicyRow(
        {
          id: row.id,
          name: row.name,
          resource_account_id: row.resource_account_id,
          emergency_numbers: (row.emergency_numbers as string[] | null) ?? [],
          description: row.description,
        },
        raObjectIds,
        live.get(row.name.toLowerCase()),
      );
      for (const call of calls) await runCall(call);
    }
  }

  if (scope.sheets.includes('call_queues')) {
    let q = scoped.selectFrom('build_call_queues').selectAll().where('site_id', '=', scope.siteId);
    if (scope.rowIds?.length) q = q.where('id', 'in', scope.rowIds);
    const rows = await q.execute();
    const raIds = [...new Set(rows.flatMap((r) => (r.resource_accounts as string[] | null) ?? []))];
    const ras = raIds.length
      ? await scoped.selectFrom('build_resource_accounts').select(['id', 'upn']).where('id', 'in', raIds).execute()
      : [];
    const cqTargetUpns = collectCallQueueTargetUpns(
      rows.map((r) => ({
        overflow: (r.overflow as CallQueueActionSettings | null) ?? null,
        timeout: (r.timeout as CallQueueActionSettings | null) ?? null,
        no_agent_action: (r.no_agent_action as CallQueueActionSettings | null) ?? null,
        authorized_users: (r.authorized_users as string[] | null) ?? null,
        hide_authorized_users: (r.hide_authorized_users as string[] | null) ?? null,
      })),
    );
    const allUpns = [...rows.flatMap((r) => (r.agents as string[] | null) ?? []), ...ras.map((r) => r.upn), ...cqTargetUpns];
    const [liveIdentity, liveQueues, audio] = await Promise.all([
      resolveLiveIdentityState(scoped, allUpns),
      resolveLiveCallQueueState(scoped, rows),
      audioImportMap(scoped, rows),
    ]);
    const agentObjectIds = new Map<string, string>();
    for (const [upn, v] of liveIdentity) if (v.objectId) agentObjectIds.set(upn, v.objectId);
    const raObjectIds = new Map<string, string>();
    for (const ra of ras) {
      const oid = liveIdentity.get(ra.upn.toLowerCase())?.objectId;
      if (oid) raObjectIds.set(ra.id, oid);
    }
    for (const row of rows) {
      const calls = planCallQueueRow(
        {
          id: row.id,
          name: row.name,
          routing_method: row.routing_method,
          agent_alert_time: row.agent_alert_time,
          presence_based_routing: row.presence_based_routing,
          agents: (row.agents as string[] | null) ?? [],
          overflow: (row.overflow as CallQueueActionSettings) ?? null,
          timeout: (row.timeout as CallQueueActionSettings) ?? null,
          no_agent_action: (row.no_agent_action as CallQueueActionSettings) ?? null,
          no_agent_apply_to: row.no_agent_apply_to,
          language_id: row.language_id,
          resource_accounts: (row.resource_accounts as string[] | null) ?? [],
          authorized_users: (row.authorized_users as string[] | null) ?? null,
          hide_authorized_users: (row.hide_authorized_users as string[] | null) ?? null,
          voicemail_triage_template_id: row.voicemail_triage_template_id,
        },
        agentObjectIds,
        raObjectIds,
        liveQueues.get(row.id),
        audio,
      );
      let created = false;
      for (const planned of calls) {
        // Redirect audio prompts not yet in Teams are imported first, in this run (they must be used within 48 hours).
        const { call, imported } = await resolveAudioPlaceholders(planned);
        const result = await runCall(call);
        // An import the queue never took would be deleted by Teams: forget it so the next run imports again.
        if (result !== 'applied' && imported.length) await scoped.updateTable('voice_audio_files').set({ teams_audio_file_id: null, imported_at: null }).where('id', 'in', imported).execute();
        if (call.cmdlet === 'New-CsCallQueue' && result === 'applied') created = true;
      }
      // See refreshCrossRefEntry - lets an Auto Attendant deployed later in
      // THIS run transfer to a queue this run just created, instead of
      // waiting for a Discovery sync.
      if (created && crossRef) await refreshCrossRefEntry(crossRef, 'call_queue', row.id, row.name);
    }
  }

  if (scope.sheets.includes('auto_attendants')) {
    let q = scoped.selectFrom('build_auto_attendants').selectAll().where('site_id', '=', scope.siteId);
    if (scope.rowIds?.length) q = q.where('id', 'in', scope.rowIds);
    const rows = await q.execute();
    // Mirrors the identical apps/api/.../deployment.service.ts block, and
    // the call-queue resolution block above - an AA can have several
    // resource accounts, or none yet, exactly like a Call Queue.
    const raIds = [...new Set(rows.flatMap((r) => (r.resource_accounts as string[] | null) ?? []))];
    const ras = raIds.length
      ? await scoped.selectFrom('build_resource_accounts').select(['id', 'upn']).where('id', 'in', raIds).execute()
      : [];
    const liveIdentity = await resolveLiveIdentityState(scoped, ras.map((r) => r.upn));
    const raObjectIds = new Map<string, string>();
    for (const ra of ras) {
      const oid = liveIdentity.get(ra.upn.toLowerCase())?.objectId;
      if (oid) raObjectIds.set(ra.id, oid);
    }
    // crossRef was built once, up front, and possibly already refreshed by
    // the call_queues block above - reused rather than rebuilt so this batch
    // sees every same-run creation so far, not just Discovery's last sync.
    const aaDeep = await resolveAutoAttendantDeepContext(scoped, crossRef!);
    const liveAutoAttendants = await resolveLiveAutoAttendantState(scoped, rows, aaDeep);
    const rawPlanRows: BuildAutoAttendantRow[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      language_id: row.language_id,
      time_zone_id: row.time_zone_id,
      voice_id: row.voice_id,
      voice_response_enabled: row.voice_response_enabled,
      operator: (row.operator as AutoAttendantCallableEntity) ?? null,
      default_call_flow: (row.default_call_flow as AutoAttendantCallFlow) ?? null,
      after_hours_call_flow: (row.after_hours_call_flow as AutoAttendantCallFlow) ?? null,
      holiday_call_flows: (row.holiday_call_flows as AutoAttendantHolidayCallFlow[]) ?? [],
      schedule: (row.schedule as AutoAttendantSchedule) ?? null,
      resource_accounts: (row.resource_accounts as string[] | null) ?? [],
      authorized_users: (row.authorized_users as string[] | null) ?? null,
      hide_authorized_users: (row.hide_authorized_users as string[] | null) ?? null,
      user_name_extension: row.user_name_extension,
    }));
    // A row that transfers to another Auto Attendant IN THIS SAME BATCH
    // deploys after its target, so the target's live Identity exists by the
    // time this row is planned - see orderAutoAttendantRowsByDependency.
    const planRows = orderAutoAttendantRowsByDependency(rawPlanRows);
    // 'user'-kind callable entities (operator / menu-option transfer
    // targets) need their own UPN -> live Entra Object ID resolution -
    // see buildCallableEntity's 'user' case.
    const userLiveIdentity = await resolveLiveIdentityState(scoped, collectAutoAttendantUserUpns(planRows));
    const userObjectIds = new Map<string, string>();
    for (const [upn, v] of userLiveIdentity) if (v.objectId) userObjectIds.set(upn, v.objectId);
    for (const planRow of planRows) {
      const calls = planAutoAttendantRow(planRow, crossRef!, raObjectIds, userObjectIds, liveAutoAttendants.get(planRow.id));
      let created = false;
      for (const call of calls) {
        const result = await runCall(call);
        if (call.cmdlet === 'New-CsAutoAttendant' && result === 'applied') created = true;
      }
      // See refreshCrossRefEntry - lets a later row in this same batch (or a
      // future sheet, though auto_attendants already runs last) transfer to
      // the Auto Attendant this run just created.
      if (created && crossRef) await refreshCrossRefEntry(crossRef, 'auto_attendant', planRow.id, planRow.name);
    }
  }

  if (scriptLines.length) {
    await scoped
      .insertInto('deployment_scripts')
      .values({
        deployment_id: deploymentId,
        filename: `deployment-${deploymentId}.ps1`,
        kind: 'ps1',
        content: renderExportScript(scriptLines, { deploymentId }),
      })
      .execute();
  }

  await scoped
    .updateTable('deployments')
    .set({
      status: 'completed',
      finished_at: new Date().toISOString(),
      summary: { ...counts, total: seq },
    })
    .where('id', '=', deploymentId)
    .execute();

  // eslint-disable-next-line no-console
  console.log(`[deployment ${deploymentId}] ${mode} done`, counts);

  // A live run moves the rows it applied from "drifted" to "awaiting sync" until Discovery reads the tenant again. Best-effort.
  if (mode === 'execute') await computeSiteDrift(scoped, scope.siteId).catch(() => undefined);

  await notifyDeploymentRunComplete(scoped, {
    tenantId,
    siteId: scope.siteId,
    deploymentId,
    operatorUserId,
    mode,
    startedAt,
    counts,
    total: seq,
    failures,
  });
  if (scope.serviceRequestId) {
    await recordServiceRequestRun(db, enqueueMail, {
      tenantId,
      schema,
      serviceRequestId: scope.serviceRequestId,
      deploymentId,
      operatorUserId,
      mode,
      counts,
      ...(scope.agentId && scope.proposalId ? { agent: { agentId: scope.agentId, proposalId: scope.proposalId } } : {}),
    });
  }
  }
}

/**
 * Email the person who ran a deployment once it reaches a terminal state -
 * mirrors discovery/run.ts's notifyRunComplete. Unlike discovery, there's no
 * per-customer opt-out for this yet (deployments are a deliberate, one-off
 * action the operator is already watching, not a background sync) - always
 * sent. Best-effort: a mail failure is logged and never fails the run.
 */
async function notifyDeploymentRunComplete(
  scoped: ReturnType<typeof tenantDb>,
  args: {
    tenantId: string;
    siteId: string;
    deploymentId: string;
    operatorUserId: string;
    mode: 'dry_run' | 'execute';
    startedAt: number;
    counts: { applied: number; skipped: number; failed: number; whatif: number };
    total: number;
    failures: DeploymentCompletedContext['failures'];
    /** Set when the run itself didn't finish (e.g. a cmdlet timeout) - drives `outcome: 'failed'`. */
    errorMessage?: string;
  },
): Promise<void> {
  try {
    const user = await platformDb(db)
      .selectFrom('users')
      .select(['email', 'display_name'])
      .where('id', '=', args.operatorUserId)
      .executeTakeFirst();
    if (!user?.email) return;

    const tenant = await platformDb(db).selectFrom('tenants').select('name').where('id', '=', args.tenantId).executeTakeFirst();
    const site = await scoped
      .selectFrom('discovery_sites')
      .select(['name', 'sitecode'])
      .where('id', '=', args.siteId)
      .executeTakeFirst();

    const secs = Math.max(1, Math.round((Date.now() - args.startedAt) / 1000));
    const durationText = secs < 90 ? `${secs} s` : `${Math.floor(secs / 60)} min ${String(secs % 60).padStart(2, '0')} s`;
    const webOrigin = await resolveWebOrigin(db);

    const context: DeploymentCompletedContext = {
      recipientName: user.display_name ?? user.email,
      customerName: tenant?.name ?? 'your customer',
      siteName: site?.name ?? site?.sitecode ?? 'the site',
      sitecode: site?.sitecode ?? '',
      mode: args.mode,
      outcome: args.errorMessage ? 'failed' : args.counts.failed > 0 ? 'completed_with_errors' : 'completed',
      durationText,
      total: args.total,
      applied: args.counts.applied,
      whatif: args.counts.whatif,
      skipped: args.counts.skipped,
      failed: args.counts.failed,
      failures: args.failures,
      errorMessage: args.errorMessage ?? null,
      runUrl: webOrigin ? `${webOrigin}/deployment/sites/${args.siteId}` : `/deployment/sites/${args.siteId}`,
    };

    await enqueueMail({
      template: 'deployment_completed',
      to: { email: user.email, name: user.display_name },
      createdBy: args.operatorUserId,
      related: { type: 'deployment', id: args.deploymentId },
      context,
      tenantId: args.tenantId,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[deployment ${args.deploymentId}] completion email not sent: ${(e as Error).message}`);
  }
}

/**
 * Look up a tenant's branding (if any) and turn it into what the email
 * layout needs - a derived color ramp, plus an absolute logo URL when one's
 * been uploaded (unauthenticated by design, so it loads in any email
 * client). Tries tenant branding first, then MSP branding (the two are
 * mutually exclusive in practice - see UsersService.sendInvitation).
 * Returns undefined for platform-level mail (neither id set) or an
 * owner with no branding set at all, so renderEmail falls back to default
 * Voxshift branding.
 */
async function loadEmailBranding(tenantId: string | null, mspId: string | null): Promise<EmailBranding | undefined> {
  const webOrigin = await resolveWebOrigin(db);
  const toEmailBranding = (branding: Branding, logoPath: string): EmailBranding => ({
    logoUrl: branding.logo ? `${webOrigin}${logoPath}?v=${branding.logo.version}` : null,
    // Older logos uploaded before dimension-capture was added won't have
    // these - renderHtml falls back to a square aspect ratio in that case.
    logoSize: branding.logo?.width && branding.logo.height ? { width: branding.logo.width, height: branding.logo.height } : undefined,
    ramp: buildColorRamp(branding.accentColor),
  });

  if (tenantId) {
    const t = await platformDb(db).selectFrom('tenants').select('branding').where('id', '=', tenantId).executeTakeFirst();
    const branding = t?.branding as Branding | null | undefined;
    if (branding) return toEmailBranding(branding, `/api/public/tenants/${tenantId}/logo`);
  }
  if (mspId) {
    const m = await platformDb(db).selectFrom('msps').select('branding').where('id', '=', mspId).executeTakeFirst();
    const branding = m?.branding as Branding | null | undefined;
    if (branding) return toEmailBranding(branding, `/api/public/msps/${mspId}/logo`);
  }
  return undefined;
}

/** Remove an invitation's stored password. A failure here is logged, never allowed to turn a delivered email into a retry. */
async function removeInvitationPassword(id: string) {
  try {
    await removeInvitationPasswordRow(db, id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[mail ${id}] could not remove the invitation password:`, (err as Error).message);
  }
}

/**
 * Deliver one queued email. Renders from `platform.email_messages.template` +
 * `context`, sends via SMTP, and writes the outcome back to the row. Throwing
 * lets BullMQ retry with backoff; the `failed` handler marks the row once the
 * attempts are exhausted. See docs/EMAIL.md.
 */
async function handleMail(job: Job) {
  const { id } = job.data as { id: string };
  const row = await platformDb(db)
    .selectFrom('email_messages')
    .select(['id', 'to_email', 'to_name', 'template', 'context', 'status', 'tenant_id', 'msp_id', 'created_by', 'original_to_email', 'reply_to'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    // eslint-disable-next-line no-console
    console.warn(`[mail ${id}] no email_messages row - dropping job`);
    return;
  }
  if (row.status === 'sent') {
    await removeInvitationPassword(id);
    return;
  }

  // The master switch (Administration > Platform settings): a message queued before it was turned off is not sent.
  if (!(await emailEnabled(db, { fresh: true }))) {
    // eslint-disable-next-line no-console
    console.log(`[mail ${id}] email is switched off - not sent`);
    await platformDb(db).updateTable('email_messages').set({ status: 'skipped', error: 'Email is switched off for the platform' }).where('id', '=', id).execute();
    await removeInvitationPassword(id);
    return;
  }

  const branding = await loadEmailBranding(row.tenant_id, row.msp_id);
  // An invitation's one-time password lives encrypted in `context` until the message is handled for good, then it is removed
  // (mail/invitation-secret.ts). It is never logged.
  const renderCtx = contextForRender(row.context as Record<string, unknown> | null);
  if (invitationPasswordMissing(row.template, renderCtx)) {
    // eslint-disable-next-line no-console
    console.warn(`[mail ${id}] invitation has no password left to send (removed after delivery) - not sent`);
    await platformDb(db)
      .updateTable('email_messages')
      .set({ status: 'failed', error: 'The temporary password is no longer stored. Use Resend invitation on the Users page to issue a new one.' })
      .where('id', '=', id)
      .execute();
    return;
  }
  const rendered = renderEmail(row.template, renderCtx, branding);

  // Test customers: redirect to whoever triggered it (or skip) - see mail/sandbox.ts.
  const delivery = await planDelivery(db, row, rendered.subject);
  if (delivery.action === 'skip') {
    // eslint-disable-next-line no-console
    console.log(`[mail ${id}] test customer - not sent (would have gone to ${delivery.originalTo})`);
    await platformDb(db)
      .updateTable('email_messages')
      .set({ status: 'skipped', error: delivery.reason, subject: rendered.subject, to_email: delivery.originalTo, original_to_email: null })
      .where('id', '=', id)
      .execute();
    await removeInvitationPassword(id);
    return;
  }
  // Record where it actually goes before sending, so the email log never shows a redirected email as sent to the customer.
  await platformDb(db)
    .updateTable('email_messages')
    .set({ to_email: delivery.to, original_to_email: delivery.originalTo })
    .where('id', '=', id)
    .execute();

  const mailCfg = await resolveMail(db);
  if (mailCfg.mode === 'none') {
    // eslint-disable-next-line no-console
    console.log(
      `[mail ${id}] ${mailCfg.reason} - not sent.\n` +
        `  to: ${delivery.to}\n  subject: ${delivery.subject}\n\n${maskSecrets(rendered.text, renderCtx)}\n`,
    );
    await platformDb(db)
      .updateTable('email_messages')
      .set({ status: 'failed', error: mailCfg.reason, subject: delivery.subject })
      .where('id', '=', id)
      .execute();
    await removeInvitationPassword(id);
    return;
  }

  try {
    await sendMail(mailCfg, {
      to: delivery.to,
      toName: delivery.toName,
      subject: delivery.subject,
      html: rendered.html,
      text: rendered.text,
      replyTo: row.reply_to,
    });
    await platformDb(db)
      .updateTable('email_messages')
      .set({
        status: 'sent',
        subject: delivery.subject,
        sent_at: new Date().toISOString(),
        error: null,
        attempts: (job.attemptsMade ?? 0) + 1,
      })
      .where('id', '=', id)
      .execute();
    await removeInvitationPassword(id);
    // eslint-disable-next-line no-console
    console.log(`[mail ${id}] sent to ${delivery.to}${delivery.originalTo ? ` (test customer - would have gone to ${delivery.originalTo})` : ''}`);
  } catch (err) {
    await platformDb(db)
      .updateTable('email_messages')
      .set({
        error: (err as Error).message,
        subject: delivery.subject,
        attempts: (job.attemptsMade ?? 0) + 1,
      })
      .where('id', '=', id)
      .execute();
    throw err; // BullMQ retries
  }
}

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    // Close a deleted customer's Teams sign-ins (asked by the API when a Super Admin deletes a customer; docs/SECURITY.md).
    if (job.name === 'tenant.release') {
      return { closed: await releaseTenantSessions(executors, executorSchema, (job.data as { schema: string }).schema) };
    }
    // Everything else: never for a customer that is being deleted, and no retries.
    try {
      await refuseJobForDeletedCustomer(db, job.data);
    } catch (e) {
      if (e instanceof CustomerBeingDeletedError) throw new UnrecoverableError(e.message);
      throw e;
    }
    switch (job.name) {
      case 'connection.start':
        return handleConnectionStart(job);
      case 'graph.connect':
        return handleGraphConnect(job);
      case 'deployment.run':
        return handleDeploymentRun(job);
      case 'tenant_discovery.run':
        return handleTenantDiscoveryRun(job, db, (id) => executors.get(id), enqueueMail);
      default:
        throw new Error(`unknown job: ${job.name}`);
    }
  },
  { connection, concurrency: 4 },
);

const mailWorker = new Worker(MAIL_QUEUE_NAME, handleMail, { connection, concurrency: 4 });

worker.on('failed', (job, err) => {
  // eslint-disable-next-line no-console
  console.error(`job ${job?.id} (${job?.name}) failed:`, err.message);
});
worker.on('ready', () => {
  // eslint-disable-next-line no-console
  console.log(`worker listening on queue "${QUEUE_NAME}"`);
});

mailWorker.on('failed', async (job, err) => {
  // eslint-disable-next-line no-console
  console.error(`mail job ${job?.id} failed:`, err.message);
  const attempts = job?.opts.attempts ?? 1;
  if (job && (job.attemptsMade ?? 0) >= attempts) {
    try {
      await platformDb(db)
        .updateTable('email_messages')
        .set({ status: 'failed', error: err.message })
        .where('id', '=', (job.data as { id: string }).id)
        .execute();
      await removeInvitationPassword((job.data as { id: string }).id);
    } catch {
      /* best effort */
    }
  }
});
mailWorker.on('ready', () => {
  // eslint-disable-next-line no-console
  console.log(`worker listening on queue "${MAIL_QUEUE_NAME}"`);
});

async function shutdown() {
  await worker.close();
  await mailWorker.close();
  for (const exec of executors.values()) await exec.dispose();
  executors.clear();
  connection.disconnect();
  await db.destroy();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Liveness for the container healthcheck (deploy/dockge/compose.yaml): touch a file every 15 seconds. If the event loop hangs the file goes stale
// and Docker marks the worker unhealthy. Best effort: a failed write never stops the worker.
const ALIVE_FILE = '/tmp/worker-alive';
const touchAlive = () => { try { writeFileSync(ALIVE_FILE, String(Date.now())); } catch { /* read-only or full disk: ignore */ } };
touchAlive();
setInterval(touchAlive, 15_000).unref();
