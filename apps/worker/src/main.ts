import 'dotenv/config';
import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { createDb, platformDb, tenantDb } from '@tvmf/db';
import { planUserRow } from './planner';
import { renderCommand, SimulatedTeamsExecutor, type CmdletInvocation } from './teams/executor';
import { renderEmail } from './mail/templates';
import { mailerConfigured, sendMail } from './mail/mailer';

const QUEUE_NAME = 'deployments';
const MAIL_QUEUE_NAME = 'mail';
const connection = new IORedis(process.env.REDIS_URL ?? 'redis://redis:6379', {
  maxRetriesPerRequest: null,
});
const { db } = createDb();

/** In-memory registry of live executors, keyed by connectionId. Never persisted. */
const executors = new Map<string, SimulatedTeamsExecutor>();

async function handleConnectionStart(job: Job) {
  const { schema, connectionId, tenantDomain } = job.data as {
    schema: string;
    connectionId: string;
    tenantDomain: string | null;
  };
  const exec = new SimulatedTeamsExecutor();
  executors.set(connectionId, exec);

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
    .set({ status: 'active', upn: signIn.upn })
    .where('id', '=', connectionId)
    .execute();

  // eslint-disable-next-line no-console
  console.log(`[connection ${connectionId}] active as ${signIn.upn}`);
}

async function handleDeploymentRun(job: Job) {
  const { schema, deploymentId, connectionId, mode, scope, operatorUserId } = job.data as {
    schema: string;
    deploymentId: string;
    connectionId: string;
    mode: 'dry_run' | 'execute';
    scope: { sheets: string[]; rowIds?: string[] };
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

  if (scope.sheets.includes('users')) {
    let q = scoped.selectFrom('build_users').selectAll().where('hidden', '=', false);
    if (scope.rowIds?.length) q = q.where('id', 'in', scope.rowIds);
    const rows = await q.execute();

    for (const row of rows) {
      const calls: CmdletInvocation[] = planUserRow({
        id: row.id,
        upn: row.upn,
        e164: row.e164,
        number_type: row.number_type,
        revoke_ev: row.revoke_ev,
        policies: (row.policies as Record<string, string | null>) ?? {},
      });
      for (const call of calls) {
        const res = await exec.invoke(call, { whatIf });
        counts[res.result] += 1;
        if (whatIf) scriptLines.push(renderCommand(call));
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
      }
    }
  }

  if (whatIf && scriptLines.length) {
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
