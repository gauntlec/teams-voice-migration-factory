import { sql, type Kysely } from 'kysely';
import { platformDb, tenantDb, type DB } from '@tvmf/db';
import {
  SR_CUSTOMER_NOTIFY_STATUSES,
  SR_TYPE_DEFS,
  SR_WAITING_MAX_REMINDERS,
  SR_WAITING_REMINDER_DAYS,
  agentLabel,
  srDuration,
  srEffectiveTargets,
  srReference,
  srSla,
  type ServiceRequestActivityContext,
  type ServiceRequestMessageContext,
  type SrSettings,
  type ServiceRequestStatusChangedContext,
} from '@tvmf/shared';
import type { DeploymentVerification } from '@tvmf/shared';
import type { MailEnqueuer } from './mail/enqueue';
import { emailRequestTeam, emitRequestEvent } from './sr-agents';

/**
 * Managed Services: a deployment run started from a service request's Deploy
 * tab (scope.serviceRequestId) has finished.
 *
 * - Always: a staff-only 'deployment' entry on the request's timeline with
 *   the run's outcome, linked to the run.
 * - A live run with no failed changes, on a request that is Designed & built,
 *   moves the request to Deployed (status_changed entry) and emails the
 *   requester - the same email the API sends when an engineer moves it by hand.
 *
 * Best-effort, like the completion email: a problem here is logged and never
 * fails the run itself.
 */
export async function recordServiceRequestRun(
  db: Kysely<DB>,
  enqueueMail: MailEnqueuer,
  args: {
    tenantId: string;
    schema: string;
    serviceRequestId: string;
    deploymentId: string;
    operatorUserId: string;
    mode: 'dry_run' | 'execute';
    counts: { applied: number; skipped: number; failed: number; whatif: number };
    /** Set when the run itself didn't finish. */
    errorMessage?: string;
    /** Set when an assistant started the run (as a person approved): its outcome is recorded on the proposal, and the request only moves to Deployed once the live re-check passes. */
    agent?: { agentId: string; proposalId: string };
  },
): Promise<void> {
  try {
    const s = tenantDb(db, args.schema);
    const sr = await s
      .selectFrom('service_requests')
      .select(['id', 'number', 'type', 'title', 'status', 'priority', 'requested_by', 'waiting_since', 'waiting_seconds', 'incident_id', 'assigned_to'])
      .where('id', '=', args.serviceRequestId)
      .executeTakeFirst();
    if (!sr) return;

    const what = args.mode === 'execute' ? 'Deployment' : 'What-If run';
    const { applied, skipped, failed, whatif } = args.counts;
    const clean = !args.errorMessage && failed === 0;
    const body = args.errorMessage
      ? `${what} failed: ${args.errorMessage}`
      : failed > 0
        ? `${what} finished with ${failed} failed change${failed === 1 ? '' : 's'} (${applied} applied, ${skipped} skipped). Fix them and deploy again.`
        : args.mode === 'execute'
          ? `${what} finished: ${applied} change${applied === 1 ? '' : 's'} applied, ${skipped} already in place.`
          : `${what} finished: ${whatif} change${whatif === 1 ? '' : 's'} would be made, ${skipped} already in place.`;
    await s
      .insertInto('service_request_events')
      .values({ request_id: sr.id, kind: 'deployment', body, internal: true, deployment_id: args.deploymentId, author_id: args.operatorUserId })
      .execute();

    if (args.agent && args.mode === 'execute') {
      await s
        .updateTable('service_request_actions')
        .set({ state: clean ? 'done' : 'failed', finished_at: new Date().toISOString(), result: JSON.stringify({ deploymentId: args.deploymentId, ...args.counts }), ...(clean ? {} : { error: body }) })
        .where('id', '=', args.agent.proposalId)
        .execute();
      if (!clean) await agentDeployNeedsCheck(db, enqueueMail, args, sr, body);
      // A clean run is not "Deployed" yet: the live re-check (finishAgentDeployment) decides that.
      await s.updateTable('service_requests').set({ updated_at: new Date().toISOString() }).where('id', '=', sr.id).execute();
      return;
    }
    if (args.mode !== 'execute' || !clean || sr.status !== 'built') {
      await s.updateTable('service_requests').set({ updated_at: new Date().toISOString() }).where('id', '=', sr.id).execute();
      return;
    }

    await markRequestDeployed(db, enqueueMail, sr, { tenantId: args.tenantId, schema: args.schema, operatorUserId: args.operatorUserId, note: 'Deployed to Microsoft Teams.', author: { id: args.operatorUserId, type: 'user' } });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[deployment ${args.deploymentId}] service request update failed: ${(e as Error).message}`);
  }
}

/** Moves a Designed & built request to Deployed and tells the requester (the same email as when an engineer moves it by hand). */
export async function markRequestDeployed(
  db: Kysely<DB>,
  enqueueMail: MailEnqueuer,
  sr: { id: string; number: number; type: keyof typeof SR_TYPE_DEFS; title: string; requested_by: string; waiting_since: string | null; waiting_seconds: number },
  args: { tenantId: string; schema: string; operatorUserId: string; note: string; author: { id: string; type: 'user' | 'agent' } },
): Promise<boolean> {
  const s = tenantDb(db, args.schema);
  const now = new Date().toISOString();
  const moved = await s
    .updateTable('service_requests')
    .set({
      status: 'deployed',
      deployed_at: now,
      updated_at: now,
      assigned_agent_id: null,
      // Deploying ends any wait on the customer.
      ...(sr.waiting_since
        ? {
            waiting_since: null,
            waiting_seconds: sr.waiting_seconds + Math.max(0, Math.round((Date.now() - new Date(sr.waiting_since).getTime()) / 1000)),
            waiting_reminded_at: null,
            waiting_reminders: 0,
          }
        : {}),
    })
    .where('id', '=', sr.id)
    .where('status', '=', 'built') // an engineer moving it at the same moment wins
    .returning('id')
    .executeTakeFirst();
  if (!moved) return false;
  await s
    .insertInto('service_request_events')
    .values({ request_id: sr.id, kind: 'status_changed', from_status: 'built', to_status: 'deployed', body: args.note, author_id: args.author.id, actor_type: args.author.type })
    .execute();
  await s.updateTable('service_request_claims').set({ released_at: now, release_reason: 'released' }).where('request_id', '=', sr.id).where('released_at', 'is', null).execute();

  if (!SR_CUSTOMER_NOTIFY_STATUSES.includes('deployed') || sr.requested_by === args.operatorUserId) return true;
  const [requester, tenant] = await Promise.all([
    platformDb(db).selectFrom('users').select(['email', 'display_name', 'status']).where('id', '=', sr.requested_by).executeTakeFirst(),
    platformDb(db).selectFrom('tenants').select('name').where('id', '=', args.tenantId).executeTakeFirst(),
  ]);
  if (!requester || requester.status !== 'active') return true;
  const webOrigin = (process.env.WEB_ORIGIN ?? '').replace(/\/+$/, '');
  const context: ServiceRequestStatusChangedContext = {
    customerName: tenant?.name ?? 'your organisation',
    reference: srReference(sr.number),
    title: sr.title,
    typeLabel: SR_TYPE_DEFS[sr.type].label,
    fromStatus: 'built',
    toStatus: 'deployed',
    moveKind: 'forward',
    note: args.note,
    runUrl: `${webOrigin}/service-requests/${sr.id}`,
  };
  await enqueueMail({
    template: 'service_request_status_changed',
    to: { email: requester.email, name: requester.display_name },
    context,
    related: { type: 'service_request', id: sr.id },
    createdBy: args.author.type === 'user' ? args.operatorUserId : null,
    tenantId: args.tenantId,
  });
  await emitRequestEvent(db, args.tenantId, { id: sr.id, number: sr.number, type: sr.type, status: 'deployed', priority: 'normal' }, 'sr.updated', { change: 'status', from: 'built', to: 'deployed', by: args.author.type === 'agent' ? 'agent' : 'person' });
  return true;
}

/** A run an assistant started did not finish cleanly, or its live re-check found differences: the request stays Designed & built for a person to look at. */
async function agentDeployNeedsCheck(
  db: Kysely<DB>,
  enqueueMail: MailEnqueuer,
  args: { tenantId: string; schema: string; deploymentId: string; agent?: { agentId: string; proposalId: string } },
  sr: { id: string; number: number; type: keyof typeof SR_TYPE_DEFS; title: string; priority: string; incident_id: string | null; assigned_to: string | null },
  why: string,
): Promise<void> {
  const s = tenantDb(db, args.schema);
  const agentId = args.agent?.agentId;
  const agent = agentId ? await platformDb(db).selectFrom('agents').select('name').where('id', '=', agentId).executeTakeFirst() : null;
  const name = agentLabel(agent?.name ?? 'The assistant');
  const now = new Date().toISOString();
  await s.insertInto('service_request_events').values({ request_id: sr.id, kind: 'deployment', body: `${name}'s deployment needs a person to check it: ${why}`, internal: true, deployment_id: args.deploymentId, author_id: agentId ?? args.deploymentId, actor_type: 'agent' }).execute();
  // The assistant stops: the lease ends and the request is nobody's, for a person to pick up.
  await s.updateTable('service_request_claims').set({ released_at: now, release_reason: 'released' }).where('request_id', '=', sr.id).where('released_at', 'is', null).execute();
  await s.updateTable('service_requests').set({ assigned_agent_id: null, updated_at: now }).where('id', '=', sr.id).execute();
  const tenant = await platformDb(db).selectFrom('tenants').select(['id', 'name']).where('id', '=', args.tenantId).executeTakeFirst();
  if (tenant) await emailRequestTeam(db, enqueueMail, tenant, sr, 'agent_deploy_check', name, why);
  // An incident this request was raised for hears about it too.
  if (sr.incident_id) {
    await s
      .insertInto('incident_events')
      .values({ incident_id: sr.incident_id, kind: 'comment', body: `${srReference(sr.number)} was deployed by ${name} but needs a person to check it: ${why}`, internal: true, author_id: agentId ?? args.deploymentId, actor_type: 'agent' })
      .execute()
      .catch(() => undefined);
  }
}

/**
 * An assistant's deployment has been re-read from the live tenant (deployment-verify.ts). Only a clean re-check (every
 * account matches the design) moves the request to Deployed. Anything else, including a re-check that could not run,
 * leaves it Designed & built and tells the team: an unattended change must be provably right before it is called done.
 */
export async function finishAgentDeployment(
  db: Kysely<DB>,
  enqueueMail: MailEnqueuer,
  args: { tenantId: string; schema: string; serviceRequestId: string; deploymentId: string; agentId: string; proposalId: string; operatorUserId: string; verification: DeploymentVerification | null },
): Promise<'deployed' | 'needs_check' | 'skipped'> {
  const s = tenantDb(db, args.schema);
  const sr = await s
    .selectFrom('service_requests')
    .select(['id', 'number', 'type', 'title', 'status', 'priority', 'requested_by', 'waiting_since', 'waiting_seconds', 'incident_id', 'assigned_to'])
    .where('id', '=', args.serviceRequestId)
    .executeTakeFirst();
  if (!sr || sr.status !== 'built') return 'skipped';
  // The run itself must have been clean (its proposal is marked done only then); a failed run already told the team.
  const prop = await s.selectFrom('service_request_actions').select('state').where('id', '=', args.proposalId).executeTakeFirst();
  if (prop?.state !== 'done') return 'skipped';
  const v = args.verification;
  const agent = await platformDb(db).selectFrom('agents').select('name').where('id', '=', args.agentId).executeTakeFirst();
  if (v && v.status === 'verified' && v.differing.length === 0 && v.checked > 0) {
    const approver = await platformDb(db).selectFrom('users').select('display_name').where('id', '=', args.operatorUserId).executeTakeFirst();
    const note = `Deployed to Microsoft Teams by ${agentLabel(agent?.name ?? 'an assistant')}${approver ? `, as approved by ${approver.display_name}` : ''}. The live tenant was re-read and matches the design.`;
    await markRequestDeployed(db, enqueueMail, sr, { tenantId: args.tenantId, schema: args.schema, operatorUserId: args.operatorUserId, note, author: { id: args.agentId, type: 'agent' } });
    return 'deployed';
  }
  const why = !v
    ? 'the live re-check did not run.'
    : v.status === 'verified'
      ? v.differing.length
        ? `the live re-check found differences: ${v.differing.slice(0, 3).map((d) => `${d.upn}: ${d.differences.slice(0, 2).join('; ')}`).join(' | ')}`
        : 'the live re-check had nothing to check.'
      : `the live re-check ${v.status === 'pending' ? 'did not finish' : v.status === 'skipped' ? 'was skipped' : 'failed'}.`;
  await agentDeployNeedsCheck(db, enqueueMail, { tenantId: args.tenantId, schema: args.schema, deploymentId: args.deploymentId, agent: { agentId: args.agentId, proposalId: args.proposalId } }, sr, why);
  return 'needs_check';
}

/**
 * Managed Services housekeeping, every 15 minutes:
 * - Waiting on customer: remind the requester every SR_WAITING_REMINDER_DAYS
 *   days, at most SR_WAITING_MAX_REMINDERS times, quoting the team's question.
 */
export async function sweepServiceRequests(db: Kysely<DB>, enqueueMail: MailEnqueuer): Promise<void> {
  const webOrigin = (process.env.WEB_ORIGIN ?? '').replace(/\/+$/, '');
  const tenants = await platformDb(db)
    .selectFrom('tenants')
    .select(['id', 'schema_name', 'name', 'sr_settings'])
    .where('managed_services_enabled', '=', true)
    .where('status', '=', 'active')
    .execute();
  let reminders = 0;
  let targetEmails = 0;
  for (const tenant of tenants) {
    try {
      const s = tenantDb(db, tenant.schema_name);
      const dueBefore = Date.now() - SR_WAITING_REMINDER_DAYS * 86_400_000;
      const waiting = await s
        .selectFrom('service_requests')
        .select(['id', 'number', 'type', 'title', 'requested_by', 'waiting_since', 'waiting_reminded_at', 'waiting_reminders'])
        .where('waiting_since', 'is not', null)
        .where('status', 'in', ['new', 'planned', 'built'])
        .where('waiting_reminders', '<', SR_WAITING_MAX_REMINDERS)
        .execute();
      for (const r of waiting) {
        // pg hands timestamps back as Date objects; compare as times.
        const last = new Date(r.waiting_reminded_at ?? r.waiting_since!).getTime();
        if (last > dueBefore) continue;
        const question = await s
          .selectFrom('service_request_events')
          .select(['body', 'author_id'])
          .where('request_id', '=', r.id)
          .where('kind', '=', 'waiting')
          .orderBy('created_at', 'desc')
          .executeTakeFirst();
        const [requester, author] = await Promise.all([
          platformDb(db).selectFrom('users').select(['email', 'display_name', 'status']).where('id', '=', r.requested_by).executeTakeFirst(),
          question ? platformDb(db).selectFrom('users').select('display_name').where('id', '=', question.author_id).executeTakeFirst() : undefined,
        ]);
        // Claim the reminder first so two workers never both send it.
        const claimed = await s
          .updateTable('service_requests')
          .set({ waiting_reminded_at: new Date().toISOString(), waiting_reminders: r.waiting_reminders + 1 })
          .where('id', '=', r.id)
          .where('waiting_reminders', '=', r.waiting_reminders)
          .returning('id')
          .executeTakeFirst();
        if (!claimed || !requester || requester.status !== 'active') continue;
        const context: ServiceRequestMessageContext = {
          customerName: tenant.name,
          reference: srReference(r.number),
          title: r.title,
          typeLabel: SR_TYPE_DEFS[r.type].label,
          kind: 'reminder',
          author: author?.display_name ?? 'The team',
          body: question?.body ?? 'The team needs more information from you.',
          runUrl: `${webOrigin}/service-requests/${r.id}`,
        };
        await enqueueMail({
          template: 'service_request_message',
          to: { email: requester.email, name: requester.display_name },
          context,
          related: { type: 'service_request', id: r.id },
          tenantId: tenant.id,
        });
        reminders++;
      }
      targetEmails += await sweepTargets(db, enqueueMail, tenant, webOrigin);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[service requests] sweep failed for ${tenant.schema_name}: ${(e as Error).message}`);
    }
  }
  if (reminders || targetEmails) {
    // eslint-disable-next-line no-console
    console.log(`service request sweep: sent ${reminders} reminder(s), ${targetEmails} target email(s)`);
  }
}

/**
 * Response/resolution targets: email the team once when an open request is
 * at risk (SR_SLA_WARN_FRACTION of the target left) and once when it's missed.
 * "The team" is the assignee, or every engineer and Super Admin on the
 * customer when nobody is assigned. Paused requests (waiting on the customer)
 * are skipped.
 */
async function sweepTargets(
  db: Kysely<DB>,
  enqueueMail: MailEnqueuer,
  tenant: { id: string; schema_name: string; name: string; sr_settings: unknown },
  webOrigin: string,
): Promise<number> {
  const s = tenantDb(db, tenant.schema_name);
  const targets = srEffectiveTargets(tenant.sr_settings as SrSettings);
  const open = await s
    .selectFrom('service_requests')
    .select([
      'id', 'number', 'type', 'title', 'priority', 'status', 'assigned_to', 'created_at', 'first_response_at', 'deployed_at',
      'declined_at', 'cancelled_at', 'waiting_since', 'waiting_seconds', 'reopened_at', 'sla_notified',
    ])
    .where('status', 'in', ['new', 'planned', 'built'])
    .execute();
  let sent = 0;
  let team: { id: string; email: string; display_name: string }[] | null = null;
  const loadTeam = async () => {
    if (team) return team;
    const p = platformDb(db);
    const [engineers, admins] = await Promise.all([
      p
        .selectFrom('tenant_memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select(['u.id as id', 'u.email as email', 'u.display_name as display_name'])
        .where('m.tenant_id', '=', tenant.id)
        .where('u.role', '=', 'ENGINEER')
        .where('u.status', '=', 'active')
        .execute(),
      p.selectFrom('users').select(['id', 'email', 'display_name']).where('role', '=', 'SUPER_ADMIN').where('status', '=', 'active').execute(),
    ]);
    const byId = new Map<string, { id: string; email: string; display_name: string }>();
    for (const u of [...engineers, ...admins]) byId.set(u.id, u);
    team = [...byId.values()];
    return team;
  };

  for (const r of open) {
    const sla = srSla(r, targets);
    const notified = { ...((r.sla_notified ?? {}) as Record<string, string>) };
    const due: { key: string; kind: 'sla_warning' | 'sla_breached'; body: string }[] = [];
    for (const which of ['response', 'resolution'] as const) {
      const c = sla[which];
      const what = which === 'response' ? 'First response' : 'Resolution';
      if (c.state === 'overdue' && !notified[`${which}_breached`]) {
        due.push({ key: `${which}_breached`, kind: 'sla_breached', body: `${what} was due ${srDuration(c.leftMs ?? 0)} ago (${r.priority} priority).` });
      } else if (c.state === 'at_risk' && !notified[`${which}_warning`] && !notified[`${which}_breached`]) {
        due.push({ key: `${which}_warning`, kind: 'sla_warning', body: `${what} is due in ${srDuration(c.leftMs ?? 0)} (${r.priority} priority).` });
      }
    }
    if (!due.length) continue;
    const now = new Date().toISOString();
    for (const d of due) notified[d.key] = now;
    // Claim first (compare-and-set on the old value) so two workers don't both send.
    const claimed = await s
      .updateTable('service_requests')
      .set({ sla_notified: JSON.stringify(notified) })
      .where('id', '=', r.id)
      .where(sql<boolean>`sla_notified = ${JSON.stringify(r.sla_notified ?? {})}::jsonb`)
      .returning('id')
      .executeTakeFirst();
    if (!claimed) continue;
    const members = await loadTeam();
    const to = r.assigned_to ? members.filter((m) => m.id === r.assigned_to) : members;
    for (const d of due) {
      const context: ServiceRequestActivityContext = {
        customerName: tenant.name,
        reference: srReference(r.number),
        title: r.title,
        typeLabel: SR_TYPE_DEFS[r.type].label,
        kind: d.kind,
        author: null,
        body: d.body,
        runUrl: `${webOrigin}/service-requests/${r.id}`,
      };
      for (const m of to) {
        await enqueueMail({
          template: 'service_request_activity',
          to: { email: m.email, name: m.display_name },
          context,
          related: { type: 'service_request', id: r.id },
          tenantId: tenant.id,
        });
        sent++;
      }
    }
  }
  return sent;
}
