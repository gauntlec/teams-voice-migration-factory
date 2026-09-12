import 'dotenv/config';
import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { sql } from 'kysely';
import { createDb, platformDb, tenantDb } from '@tvmf/db';
import type { DiscoverySiteOverview, PortDocumentItemSummary } from '@tvmf/shared';
import {
  planIdentityRow,
  planResourceAccountRow,
  renderCommand,
  type CmdletInvocation,
  type LiveIdentityState,
} from '@tvmf/shared';
import { SimulatedTeamsExecutor, type TeamsExecutor } from './teams/executor';
import { PwshTeamsExecutor } from './teams/pwsh-executor';
import { handleTenantDiscoveryRun } from './discovery/run';
import { renderEmail } from './mail/templates';
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
  }
  if (conns || runs) {
    // eslint-disable-next-line no-console
    console.log(
      `startup sweep: expired ${conns} orphaned connection(s), failed ${runs} orphaned discovery run(s)`,
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
    .select(['upn', 'enterprise_voice_enabled', 'line_uri', 'policies'])
    .where('removed_at', 'is', null)
    .where(sql`lower(upn)`, 'in', wanted)
    .execute();
  for (const r of rows) {
    out.set(r.upn.toLowerCase(), {
      enterpriseVoiceEnabled: r.enterprise_voice_enabled,
      lineUri: r.line_uri,
      policies: (r.policies as Record<string, string | null>) ?? {},
    });
  }
  return out;
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
  const exec = executors.get(connectionId) ?? new SimulatedTeamsExecutor();
  if (!executors.has(connectionId)) await exec.awaitSignIn(); // scaffold fallback

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

  const counts = { applied: 0, skipped: 0, failed: 0, whatif: 0 };
  const scriptLines: string[] = [];
  let seq = 0;
  const whatIf = mode === 'dry_run';

  /** Records one cmdlet's outcome as a deployment_changes row. */
  const record = async (call: CmdletInvocation, res: Awaited<ReturnType<typeof exec.invoke>>) => {
    counts[res.result] += 1;
    if (res.result === 'whatif') scriptLines.push(renderCommand(call));
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
   * 'whatif' regardless of `mode`.
   */
  const runCall = async (call: CmdletInvocation) => {
    if (call.deferred) {
      await record(call, { result: 'whatif', before: {}, after: {}, message: 'Deferred - needs manual licensing before rerunning.' });
      return;
    }
    if (teamsReadOnly) {
      await record(call, { result: 'whatif', before: {}, after: {}, message: 'Tenant is read-only - cmdlet not sent to Microsoft Teams.' });
      return;
    }
    await record(call, await exec.invoke(call, { whatIf }));
  };

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
    .select(['id', 'to_email', 'to_name', 'template', 'context', 'status'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    // eslint-disable-next-line no-console
    console.warn(`[mail ${id}] no email_messages row - dropping job`);
    return;
  }
  if (row.status === 'sent') return;

  const rendered = renderEmail(row.template, (row.context ?? {}) as Record<string, unknown>);

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
