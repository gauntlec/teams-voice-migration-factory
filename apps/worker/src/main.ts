import 'dotenv/config';
import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { sql } from 'kysely';
import { createDb, platformDb, tenantDb } from '@tvmf/db';
import { buildColorRamp, type Branding, type DiscoverySiteOverview, type PortDocumentItemSummary } from '@tvmf/shared';
import {
  CALL_QUEUE_NO_AGENT_ACTIONS,
  CALL_QUEUE_NO_AGENT_APPLY_TO,
  CALL_QUEUE_OVERFLOW_ACTIONS,
  CALL_QUEUE_ROUTING_METHODS,
  CALL_QUEUE_TIMEOUT_ACTIONS,
  collectAutoAttendantUserUpns,
  collectCallQueueTargetUpns,
  decodeCallQueueEnum,
  extractLiveCallTargetId,
  liveAutoAttendantToStructured,
  orderAutoAttendantRowsByDependency,
  planAutoAttendantRow,
  planCallQueueRow,
  planIdentityRow,
  planResourceAccountRow,
  renderCommand,
  type AutoAttendantCallableEntity,
  type AutoAttendantCallFlow,
  type AutoAttendantCrossRef,
  type AutoAttendantHolidayCallFlow,
  type AutoAttendantLiveState,
  type AutoAttendantSchedule,
  type BuildAutoAttendantRow,
  type CallDelegate,
  type CallForwardingSettings,
  type CallQueueActionSettings,
  type CallQueueLiveState,
  type CmdletInvocation,
  type DeploymentCompletedContext,
  type LiveCallableEntityRef,
  type LiveIdentityState,
  type PickupGroupSettings,
} from '@tvmf/shared';
import { SimulatedTeamsExecutor, type TeamsExecutor } from './teams/executor';
import { PwshTeamsExecutor } from './teams/pwsh-executor';
import { handleTenantDiscoveryRun } from './discovery/run';
import { renderEmail } from './mail/templates';
import type { EmailBranding } from './mail/layout';
import { mailerConfigured, sendMail } from './mail/mailer';
import { makeMailEnqueuer } from './mail/enqueue';

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

setInterval(() => {
  const now = Date.now();
  for (const [id, exec] of executors) {
    const schema = executorSchema.get(id);
    if (!schema) continue;
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
  const tenants = await platformDb(db).selectFrom('tenants').select('schema_name').execute();
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
 * Who gets a number-port document email: every active CUSTOMER user scoped
 * to this site (or whole-customer, via an empty `site_ids`), falling back to
 * the site overview's `primaryContactEmail` if no CUSTOMER account exists
 * yet. Duplicated from the API's equivalent in
 * apps/api/src/modules/number-port/number-port.service.ts rather than
 * shared - api and worker don't share a DB-access layer beyond @tvmf/db's
 * Kysely types.
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
  if (rows.length) return rows.map((r) => ({ email: r.email, name: r.display_name }));
  return overview.primaryContactEmail ? [{ email: overview.primaryContactEmail }] : [];
}

/**
 * Periodic nudge for number-port document requests still `awaiting_documents`
 * once each site's configured interval (`overview.portDocReminderDays`,
 * default 7 days) has passed since the last reminder (or since submission,
 * if none has gone out yet). Runs hourly - reminder intervals are measured
 * in days, so this is far more often than needed, but cheap and idempotent.
 */
async function sweepPortDocumentReminders() {
  const webOrigin = (process.env.WEB_ORIGIN ?? '').replace(/\/+$/, '');
  const tenants = await platformDb(db).selectFrom('tenants').select(['id', 'schema_name', 'name']).execute();
  let sent = 0;
  for (const tenant of tenants) {
    const scoped = tenantDb(db, tenant.schema_name);
    const due = await scoped
      .selectFrom('number_port_requests as req')
      .innerJoin('discovery_number_ranges as r', 'r.id', 'req.range_id')
      .innerJoin('discovery_sites as s', 's.sitecode', 'r.sitecode')
      .select(['req.id', 'req.submitted_at', 'req.reminder_sent_at', 'r.range_start', 'r.range_end', 's.id as site_id', 's.name as site_name', 's.sitecode', 's.overview'])
      .where('req.status', '=', 'awaiting_documents')
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
 * Batch-resolves tenant_policies ids (build_users/build_caps.policy_ids,
 * build_resource_accounts.voice_routing_policy_id) to their *current* live
 * name, so a deployment always grants whatever the tenant calls that policy
 * right now - not a stale copy from whenever the engineer last saved the
 * row in Design & Build (see BuildService.resolvePolicyIds, which is what
 * keeps `policies.<key>` roughly in sync, but only as of the last write).
 * A removed/unresolvable id is simply absent from the returned map; callers
 * fall back to the row's stored name.
 */
async function resolveLivePolicyNames(scoped: ReturnType<typeof tenantDb>, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  const rows = await scoped
    .selectFrom('tenant_policies')
    .select(['id', 'name'])
    .where('id', 'in', wanted)
    .where('removed_at', 'is', null)
    .execute();
  for (const r of rows) out.set(r.id, r.name);
  return out;
}

/**
 * Batch-fetches what Discovery's live-tenant snapshot (tenant_users) knows
 * about a set of UPNs, keyed by lowercased UPN, so a deployment only issues
 * a cmdlet when it would actually change something - see the identical
 * apps/api/src/modules/deployment/deployment.service.ts helper this mirrors
 * (kept a separate copy - api and worker don't share a DB-access layer
 * beyond @tvmf/db's Kysely types), which the preview endpoint uses so an
 * engineer reviewing "planned changes" sees exactly what a real run would do.
 */
async function resolveLiveIdentityState(scoped: ReturnType<typeof tenantDb>, upns: string[]) {
  const wanted = [...new Set(upns.map((u) => u.toLowerCase()))];
  const out = new Map<string, LiveIdentityState>();
  if (wanted.length === 0) return out;
  const rows = await scoped
    .selectFrom('tenant_users')
    .select([
      'upn',
      'enterprise_voice_enabled',
      'line_uri',
      'policies',
      'entra_id',
      'voicemail_enabled',
      'voicemail_prompt_language',
    ])
    .where('removed_at', 'is', null)
    .where(sql`lower(upn)`, 'in', wanted)
    .execute();
  for (const r of rows) {
    out.set(r.upn.toLowerCase(), {
      enterpriseVoiceEnabled: r.enterprise_voice_enabled,
      lineUri: r.line_uri,
      policies: (r.policies as Record<string, string | null>) ?? {},
      // See the identical apps/api/.../deployment.service.ts helper's comment:
      // entra_id (not object_id, our own internal tenant_objects.id) is the
      // real Entra GUID Set-CsCallQueue -Users etc. expect.
      objectId: r.entra_id ?? undefined,
      // null (never targeted-checked) becomes undefined so planIdentityRow's
      // fallback-to-always-emit applies, same as an unmatched UPN.
      voicemailEnabled: r.voicemail_enabled ?? undefined,
      voicemailPromptLanguage: r.voicemail_prompt_language,
    });
  }
  return out;
}

/** Mirrors the identical apps/api/.../deployment.service.ts helper - see that copy for why it's duplicated. */
async function resolveLiveCallQueueState(scoped: ReturnType<typeof tenantDb>, names: string[]) {
  const wanted = [...new Set(names.map((n) => n.toLowerCase()).filter(Boolean))];
  const out = new Map<string, CallQueueLiveState>();
  if (wanted.length === 0) return out;
  const rows = await scoped
    .selectFrom('tenant_objects')
    .select(['display_name', 'data'])
    .where('object_type', '=', 'call_queue')
    .where('removed_at', 'is', null)
    .where(sql`lower(display_name)`, 'in', wanted)
    .execute();
  for (const r of rows) {
    if (!r.display_name) continue;
    const d = r.data as Record<string, unknown>;
    const agents = Array.isArray(d.Agents)
      ? (d.Agents as Record<string, unknown>[])
          .map((a) => (typeof a?.ObjectId === 'string' ? a.ObjectId : null))
          .filter((v): v is string => !!v)
      : [];
    out.set(r.display_name.toLowerCase(), {
      identity: String(d.Identity ?? ''),
      routingMethod: decodeCallQueueEnum(d.RoutingMethod, CALL_QUEUE_ROUTING_METHODS),
      agentAlertTime: typeof d.AgentAlertTime === 'number' ? d.AgentAlertTime : undefined,
      presenceBasedRouting: typeof d.PresenceBasedRouting === 'boolean' ? d.PresenceBasedRouting : undefined,
      agentObjectIds: agents,
      overflowAction: decodeCallQueueEnum(d.OverflowAction, CALL_QUEUE_OVERFLOW_ACTIONS),
      overflowThreshold: typeof d.OverflowThreshold === 'number' ? d.OverflowThreshold : undefined,
      overflowActionTarget: extractLiveCallTargetId(d.OverflowActionTarget),
      timeoutAction: decodeCallQueueEnum(d.TimeoutAction, CALL_QUEUE_TIMEOUT_ACTIONS),
      timeoutThreshold: typeof d.TimeoutThreshold === 'number' ? d.TimeoutThreshold : undefined,
      timeoutActionTarget: extractLiveCallTargetId(d.TimeoutActionTarget),
      noAgentAction: decodeCallQueueEnum(d.NoAgentAction, CALL_QUEUE_NO_AGENT_ACTIONS),
      noAgentActionTarget: extractLiveCallTargetId(d.NoAgentActionTarget),
      noAgentApplyTo: decodeCallQueueEnum(d.NoAgentApplyTo, CALL_QUEUE_NO_AGENT_APPLY_TO),
      languageId: typeof d.LanguageId === 'string' ? d.LanguageId : undefined,
      applicationInstanceIds: Array.isArray(d.ApplicationInstances)
        ? (d.ApplicationInstances as unknown[]).filter((v): v is string => typeof v === 'string')
        : undefined,
    });
  }
  return out;
}

/** Mirrors the identical apps/api/.../deployment.service.ts helper - see that copy for why it's duplicated. */
async function resolveLiveAutoAttendantState(
  scoped: ReturnType<typeof tenantDb>,
  names: string[],
  deep?: { scheduleByKey: Map<string, Record<string, unknown>>; resolveTarget: (ref: LiveCallableEntityRef | undefined) => AutoAttendantCallableEntity | undefined },
): Promise<Map<string, AutoAttendantLiveState>> {
  const wanted = [...new Set(names.map((n) => n.toLowerCase()).filter(Boolean))];
  const out = new Map<string, AutoAttendantLiveState>();
  if (wanted.length === 0) return out;
  const rows = await scoped
    .selectFrom('tenant_objects')
    .select(['display_name', 'data'])
    .where('object_type', '=', 'auto_attendant')
    .where('removed_at', 'is', null)
    .where(sql`lower(display_name)`, 'in', wanted)
    .execute();
  for (const r of rows) {
    if (!r.display_name) continue;
    const d = r.data as Record<string, unknown>;
    out.set(r.display_name.toLowerCase(), {
      identity: String(d.Identity ?? ''),
      languageId: typeof d.LanguageId === 'string' ? d.LanguageId : undefined,
      timeZoneId: typeof d.TimeZoneId === 'string' ? d.TimeZoneId : undefined,
      voiceId: typeof d.VoiceId === 'string' ? d.VoiceId : undefined,
      // Get-CsAutoAttendant's own property is VoiceResponseEnabled, not the
      // New/Set-CsAutoAttendant *write* parameter name EnableVoiceResponse -
      // see aa-live-parse.ts's liveAutoAttendantToStructured for the same fix.
      enableVoiceResponse: typeof d.VoiceResponseEnabled === 'boolean' ? d.VoiceResponseEnabled : undefined,
      applicationInstanceIds: Array.isArray(d.ApplicationInstances)
        ? (d.ApplicationInstances as unknown[]).filter((v): v is string => typeof v === 'string')
        : undefined,
      structured: deep ? liveAutoAttendantToStructured(d, deep.scheduleByKey, deep.resolveTarget) : undefined,
    });
  }
  return out;
}

/** Mirrors the identical apps/api/.../deployment.service.ts helper - see that copy for why it's duplicated. */
async function resolveAutoAttendantDeepContext(scoped: ReturnType<typeof tenantDb>, crossRef: AutoAttendantCrossRef) {
  const [scheduleRows, userRows] = await Promise.all([
    scoped.selectFrom('tenant_objects').select(['object_key', 'data']).where('object_type', '=', 'schedule').where('removed_at', 'is', null).execute(),
    scoped.selectFrom('tenant_users').select(['entra_id', 'upn']).where('entra_id', 'is not', null).execute(),
  ]);
  const scheduleByKey = new Map(scheduleRows.map((r) => [r.object_key, r.data as Record<string, unknown>]));
  const upnByEntraId = new Map(userRows.map((r) => [r.entra_id!.toLowerCase(), r.upn]));
  const liveIdToBuild = new Map<string, { kind: 'auto_attendant' | 'call_queue'; buildId: string }>();
  for (const [key, identity] of crossRef) {
    const sep = key.indexOf(':');
    liveIdToBuild.set(identity.toLowerCase(), { kind: key.slice(0, sep) as 'auto_attendant' | 'call_queue', buildId: key.slice(sep + 1) });
  }
  const resolveTarget = (ref: LiveCallableEntityRef | undefined): AutoAttendantCallableEntity | undefined => {
    if (!ref) return undefined;
    if (ref.kind === 'external' && ref.number) return { kind: 'external', number: ref.number };
    if (ref.kind === 'user' && ref.liveId) {
      const upn = upnByEntraId.get(ref.liveId.toLowerCase());
      return upn ? { kind: 'user', upn } : undefined;
    }
    if (ref.kind === 'voice_app' && ref.liveId) {
      const hit = liveIdToBuild.get(ref.liveId.toLowerCase());
      return hit ? { kind: hit.kind, buildId: hit.buildId } : undefined;
    }
    return undefined;
  };
  return { scheduleByKey, resolveTarget };
}

/** Mirrors the identical apps/api/.../deployment.service.ts helper - see that copy for why it's duplicated. */
async function buildAutoAttendantCrossRef(scoped: ReturnType<typeof tenantDb>, siteId: string): Promise<AutoAttendantCrossRef> {
  const [aaRows, cqRows] = await Promise.all([
    scoped.selectFrom('build_auto_attendants').select(['id', 'name']).where('site_id', '=', siteId).execute(),
    scoped.selectFrom('build_call_queues').select(['id', 'name']).where('site_id', '=', siteId).execute(),
  ]);
  const [liveAa, liveCq] = await Promise.all([
    resolveLiveAutoAttendantState(scoped, aaRows.map((r) => r.name)),
    resolveLiveCallQueueState(scoped, cqRows.map((r) => r.name)),
  ]);
  const crossRef: AutoAttendantCrossRef = new Map();
  for (const row of aaRows) {
    const live = liveAa.get(row.name.toLowerCase());
    if (live?.identity) crossRef.set(`auto_attendant:${row.id}`, live.identity);
  }
  for (const row of cqRows) {
    const live = liveCq.get(row.name.toLowerCase());
    if (live?.identity) crossRef.set(`call_queue:${row.id}`, live.identity);
  }
  return crossRef;
}

async function handleDeploymentRun(job: Job) {
  const { schema, deploymentId, connectionId, mode, scope, operatorUserId, tenantId } = job.data as {
    schema: string;
    deploymentId: string;
    connectionId: string;
    mode: 'dry_run' | 'execute';
    scope: { siteId: string; sheets: string[]; rowIds?: string[] };
    operatorUserId: string;
    tenantId: string;
  };
  const scoped = tenantDb(db, schema);
  const exec = executors.get(connectionId);
  const startedAt = Date.now();

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
    await runDeployment(exec);
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
    throw err;
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

  /** Records one cmdlet's outcome as a deployment_changes row. */
  const record = async (call: CmdletInvocation, res: Awaited<ReturnType<typeof exec.invoke>>) => {
    counts[res.result] += 1;
    if (res.result === 'whatif') scriptLines.push(renderCommand(call));
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
        before: res.before as object,
        after: res.after as object,
        result: res.result,
        message: res.message ?? null,
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
  const runCall = async (call: CmdletInvocation) => {
    if (call.deferred) {
      const res = { result: 'whatif' as const, before: {}, after: {}, message: 'Deferred - needs manual licensing before rerunning.' };
      await record(call, res);
      return res.result;
    }
    if (teamsReadOnly) {
      const res = { result: 'whatif' as const, before: {}, after: {}, message: 'Tenant is read-only - cmdlet not sent to Microsoft Teams.' };
      await record(call, res);
      return res.result;
    }
    const res = await exec.invoke(call, { whatIf });
    await record(call, res);
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

  if (scope.sheets.includes('users') || scope.sheets.includes('caps')) {
    for (const [sheet, table, objectType] of [
      ['users', 'build_users', 'user'],
      ['caps', 'build_caps', 'cap'],
    ] as const) {
      if (!scope.sheets.includes(sheet)) continue;
      let q = scoped.selectFrom(table).selectAll().where('site_id', '=', scope.siteId).where('hidden', '=', false);
      if (scope.rowIds?.length) q = q.where('id', 'in', scope.rowIds);
      const rows = await q.execute();
      const [liveNames, liveState] = await Promise.all([
        resolveLivePolicyNames(
          scoped,
          rows.flatMap((row) => Object.values((row.policy_ids as Record<string, string | null>) ?? {})),
        ),
        resolveLiveIdentityState(scoped, rows.map((row) => row.upn)),
      ]);
      for (const row of rows) {
        const policyIds = (row.policy_ids as Record<string, string | null>) ?? {};
        const storedPolicies = (row.policies as Record<string, string | null>) ?? {};
        // A row with a policy_ids link always deploys whatever that policy
        // is called *right now* in the tenant, not whatever name was live
        // when the engineer last saved - a rename since then shouldn't ship
        // stale. Rows with no link (legacy, or the untracked
        // dial_out_policy) fall back to the stored name unchanged.
        const policies: Record<string, string | null> = {};
        for (const key of Object.keys(storedPolicies)) {
          const linkedId = policyIds[key];
          policies[key] = (linkedId && liveNames.get(linkedId)) || storedPolicies[key];
        }
        const calls = planIdentityRow(
          {
            id: row.id,
            upn: row.upn,
            e164: row.e164,
            number_type: row.number_type,
            revoke_ev: row.revoke_ev,
            policies,
            voicemail: (row.voicemail as { enabled?: boolean | null; language?: string | null }) ?? null,
            call_forwarding: (row.call_forwarding as CallForwardingSettings) ?? null,
            pickup_group: (row.pickup_group as PickupGroupSettings) ?? null,
            delegates: (row.delegates as CallDelegate[]) ?? null,
          },
          objectType,
          liveState.get(row.upn.toLowerCase()),
        );
        for (const call of calls) await runCall(call);
      }
    }
  }

  if (scope.sheets.includes('resource_accounts')) {
    let q = scoped.selectFrom('build_resource_accounts').selectAll().where('site_id', '=', scope.siteId);
    if (scope.rowIds?.length) q = q.where('id', 'in', scope.rowIds);
    const rows = await q.execute();
    const [liveNames, liveState] = await Promise.all([
      resolveLivePolicyNames(scoped, rows.map((r) => r.voice_routing_policy_id)),
      resolveLiveIdentityState(scoped, rows.map((row) => row.upn)),
    ]);
    for (const row of rows) {
      const linkedId = row.voice_routing_policy_id;
      const calls = planResourceAccountRow(
        {
          id: row.id,
          upn: row.upn,
          display_name: row.display_name,
          kind: row.kind,
          location_id: row.location_id,
          phone_number: row.phone_number,
          number_type: row.number_type,
          voice_routing_policy: (linkedId && liveNames.get(linkedId)) || row.voice_routing_policy,
          application_id: row.application_id,
        },
        liveState.get(row.upn.toLowerCase()),
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
      })),
    );
    const allUpns = [...rows.flatMap((r) => (r.agents as string[] | null) ?? []), ...ras.map((r) => r.upn), ...cqTargetUpns];
    const [liveIdentity, liveQueues] = await Promise.all([
      resolveLiveIdentityState(scoped, allUpns),
      resolveLiveCallQueueState(scoped, rows.map((r) => r.name)),
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
        },
        agentObjectIds,
        raObjectIds,
        liveQueues.get(row.name.toLowerCase()),
      );
      let created = false;
      for (const call of calls) {
        const result = await runCall(call);
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
    const liveAutoAttendants = await resolveLiveAutoAttendantState(scoped, rows.map((r) => r.name), aaDeep);
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
      const calls = planAutoAttendantRow(planRow, crossRef!, raObjectIds, userObjectIds, liveAutoAttendants.get(planRow.name.toLowerCase()));
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
        content: ['Connect-MicrosoftTeams', ...scriptLines, 'Disconnect-MicrosoftTeams'].join('\n'),
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
    const webOrigin = (process.env.WEB_ORIGIN ?? '').replace(/\/+$/, '');

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
  const webOrigin = (process.env.WEB_ORIGIN ?? '').replace(/\/+$/, '');
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
    .select(['id', 'to_email', 'to_name', 'template', 'context', 'status', 'tenant_id', 'msp_id'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    // eslint-disable-next-line no-console
    console.warn(`[mail ${id}] no email_messages row - dropping job`);
    return;
  }
  if (row.status === 'sent') return;

  const branding = await loadEmailBranding(row.tenant_id, row.msp_id);
  const rendered = renderEmail(row.template, (row.context ?? {}) as Record<string, unknown>, branding);

  if (!mailerConfigured) {
    // eslint-disable-next-line no-console
    console.log(
      `[mail ${id}] SMTP not configured - not sent.\n` +
        `  to: ${row.to_email}\n  subject: ${rendered.subject}\n\n${rendered.text}\n`,
    );
    await platformDb(db)
      .updateTable('email_messages')
      .set({ status: 'failed', error: 'SMTP not configured', subject: rendered.subject })
      .where('id', '=', id)
      .execute();
    return;
  }

  try {
    await sendMail({
      to: row.to_email,
      toName: row.to_name,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    await platformDb(db)
      .updateTable('email_messages')
      .set({
        status: 'sent',
        subject: rendered.subject,
        sent_at: new Date().toISOString(),
        error: null,
        attempts: (job.attemptsMade ?? 0) + 1,
      })
      .where('id', '=', id)
      .execute();
    // eslint-disable-next-line no-console
    console.log(`[mail ${id}] sent to ${row.to_email}`);
  } catch (err) {
    await platformDb(db)
      .updateTable('email_messages')
      .set({
        error: (err as Error).message,
        subject: rendered.subject,
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
    switch (job.name) {
      case 'connection.start':
        return handleConnectionStart(job);
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
