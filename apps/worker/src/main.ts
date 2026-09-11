import 'dotenv/config';
import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { createDb, platformDb, tenantDb } from '@tvmf/db';
import { planIdentityRow, planResourceAccountRow } from './planner';
import {
  renderCommand,
  SimulatedTeamsExecutor,
  type CmdletInvocation,
  type TeamsExecutor,
} from './teams/executor';
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

async function handleDeploymentRun(job: Job) {
  const { schema, deploymentId, connectionId, mode, scope, operatorUserId } = job.data as {
    schema: string;
    deploymentId: string;
    connectionId: string;
    mode: 'dry_run' | 'execute';
    scope: { siteId: string; sheets: string[]; rowIds?: string[] };
    operatorUserId: string;
  };
  const scoped = tenantDb(db, schema);
  const exec = executors.get(connectionId) ?? new SimulatedTeamsExecutor();
  if (!executors.has(connectionId)) await exec.awaitSignIn(); // scaffold fallback

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
      for (const row of rows) {
        const calls = planIdentityRow(
          {
            id: row.id,
            upn: row.upn,
            e164: row.e164,
            number_type: row.number_type,
            revoke_ev: row.revoke_ev,
            policies: (row.policies as Record<string, string | null>) ?? {},
            voicemail: (row.voicemail as { enabled?: boolean | null; language?: string | null }) ?? null,
          },
          objectType,
        );
        for (const call of calls) await runCall(call);
      }
    }
  }

  if (scope.sheets.includes('resource_accounts')) {
    let q = scoped.selectFrom('build_resource_accounts').selectAll().where('site_id', '=', scope.siteId);
    if (scope.rowIds?.length) q = q.where('id', 'in', scope.rowIds);
    const rows = await q.execute();
    for (const row of rows) {
      const calls = planResourceAccountRow({
        id: row.id,
        upn: row.upn,
        display_name: row.display_name,
        kind: row.kind,
        location_id: row.location_id,
        phone_number: row.phone_number,
        number_type: row.number_type,
        voice_routing_policy: row.voice_routing_policy,
        application_id: row.application_id,
      });
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
