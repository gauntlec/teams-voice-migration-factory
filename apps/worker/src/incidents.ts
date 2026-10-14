import { sql, type Kysely } from 'kysely';
import { platformDb, tenantDb, type DB } from '@tvmf/db';
import {
  INC_AUTOCLOSE_DAYS,
  INC_MAJOR_ESCALATE_AFTER_MINUTES,
  INC_PRIORITY_LABELS,
  INC_WAITING_MAX_REMINDERS,
  INC_WAITING_REMINDER_DAYS,
  incCategoryLabel,
  incReference,
  incSlaFor,
  srDuration,
  type IncSettings,
  type IncidentActivityContext,
  type IncidentMessageContext,
  type IncidentStatusChangedContext,
} from '@tvmf/shared';
import { emitAgentEvent } from './agents';
import type { MailEnqueuer } from './mail/enqueue';

type Person = { id: string; email: string; display_name: string };

/**
 * Incident housekeeping, every few minutes (docs/INCIDENT-MANAGEMENT.md):
 * - Waiting on the customer: remind the reporter every INC_WAITING_REMINDER_DAYS
 *   days, at most INC_WAITING_MAX_REMINDERS times, quoting the team's question.
 * - Targets: email the team once when a response, restoration or resolution
 *   target is at risk and once when it is missed - to the assignee, or the whole
 *   team when nobody has it. Held incidents (paused clocks) are skipped.
 * - Major incidents: when a customer update is due, remind the comms owner; if it is
 *   INC_MAJOR_ESCALATE_AFTER_MINUTES late, tell the lead and the whole team.
 * - Auto-close: a Resolved incident with no reply for INC_AUTOCLOSE_DAYS closes
 *   by itself, and the reporter and followers are told.
 * Every action claims the row first (compare-and-set), so two workers never both act.
 * `opts.tenantId` limits it to one customer (tests).
 */
export async function sweepIncidents(db: Kysely<DB>, enqueueMail: MailEnqueuer, opts: { tenantId?: string } = {}): Promise<{ reminders: number; targetEmails: number; closed: number; majorReminders: number }> {
  const webOrigin = (process.env.WEB_ORIGIN ?? '').replace(/\/+$/, '');
  let q = platformDb(db)
    .selectFrom('tenants')
    .select(['id', 'schema_name', 'name', 'inc_settings'])
    .where('managed_services_enabled', '=', true)
    .where('status', '=', 'active');
  if (opts.tenantId) q = q.where('id', '=', opts.tenantId);
  const tenants = await q.execute();
  const total = { reminders: 0, targetEmails: 0, closed: 0, majorReminders: 0 };
  for (const tenant of tenants) {
    try {
      const ctx = { db, enqueueMail, tenant, webOrigin };
      total.reminders += await remindWaiting(ctx);
      total.targetEmails += await sweepTargets(ctx);
      total.closed += await autoClose(ctx);
      total.majorReminders += await remindMajorUpdates(ctx);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[incidents] sweep failed for ${tenant.schema_name}: ${(e as Error).message}`);
    }
  }
  if (total.reminders || total.targetEmails || total.closed || total.majorReminders) {
    // eslint-disable-next-line no-console
    console.log(`incident sweep: ${total.reminders} reminder(s), ${total.targetEmails} target email(s), ${total.closed} auto-closed, ${total.majorReminders} major update reminder(s)`);
  }
  return total;
}

interface Ctx {
  db: Kysely<DB>;
  enqueueMail: MailEnqueuer;
  tenant: { id: string; schema_name: string; name: string; inc_settings: unknown };
  webOrigin: string;
}

const link = (c: Ctx, id: string) => `${c.webOrigin}/incidents/${id}`;

async function teamOf(c: Ctx): Promise<Person[]> {
  const p = platformDb(c.db);
  const [engineers, admins] = await Promise.all([
    p
      .selectFrom('tenant_memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['u.id as id', 'u.email as email', 'u.display_name as display_name'])
      .where('m.tenant_id', '=', c.tenant.id)
      .where('u.role', '=', 'ENGINEER')
      .where('u.status', '=', 'active')
      .execute(),
    p.selectFrom('users').select(['id', 'email', 'display_name']).where('role', '=', 'SUPER_ADMIN').where('status', '=', 'active').execute(),
  ]);
  const byId = new Map<string, Person>();
  for (const u of [...engineers, ...admins]) byId.set(u.id, u);
  return [...byId.values()];
}

async function reporterAndFollowers(c: Ctx, incidentId: string, reporterId: string): Promise<Person[]> {
  const w = await tenantDb(c.db, c.tenant.schema_name).selectFrom('incident_watchers').select('user_id').where('incident_id', '=', incidentId).execute();
  const ids = [...new Set([reporterId, ...w.map((x) => x.user_id)])];
  return platformDb(c.db).selectFrom('users').select(['id', 'email', 'display_name']).where('id', 'in', ids).where('status', '=', 'active').execute();
}

async function send(c: Ctx, template: 'incident_message' | 'incident_activity' | 'incident_status_changed', to: Person[], context: object, incidentId: string) {
  for (const r of to) {
    await c.enqueueMail({
      template,
      to: { email: r.email, name: r.display_name },
      context: context as Record<string, unknown>,
      related: { type: 'incident', id: incidentId },
      tenantId: c.tenant.id,
    });
  }
}

/** Waiting on the customer: a reminder every few days, quoting the team's question. */
async function remindWaiting(c: Ctx): Promise<number> {
  const s = tenantDb(c.db, c.tenant.schema_name);
  const dueBefore = Date.now() - INC_WAITING_REMINDER_DAYS * 86_400_000;
  const waiting = await s
    .selectFrom('incidents')
    .select(['id', 'number', 'title', 'reporter_id', 'paused_since', 'waiting_reminded_at', 'waiting_reminders'])
    .where('status', '=', 'on_hold')
    .where('hold_reason', '=', 'customer')
    .where('waiting_reminders', '<', INC_WAITING_MAX_REMINDERS)
    .execute();
  let sent = 0;
  for (const r of waiting) {
    // pg hands timestamps back as Date objects; compare as times.
    const last = new Date(r.waiting_reminded_at ?? r.paused_since ?? 0).getTime();
    if (!last || last > dueBefore) continue;
    const question = await s.selectFrom('incident_events').select(['body', 'author_id']).where('incident_id', '=', r.id).where('kind', '=', 'waiting').orderBy('created_at', 'desc').executeTakeFirst();
    const [reporter, author] = await Promise.all([
      platformDb(c.db).selectFrom('users').select(['id', 'email', 'display_name', 'status']).where('id', '=', r.reporter_id).executeTakeFirst(),
      question?.author_id ? platformDb(c.db).selectFrom('users').select('display_name').where('id', '=', question.author_id).executeTakeFirst() : undefined,
    ]);
    const claimed = await s
      .updateTable('incidents')
      .set({ waiting_reminded_at: new Date().toISOString(), waiting_reminders: r.waiting_reminders + 1 })
      .where('id', '=', r.id)
      .where('waiting_reminders', '=', r.waiting_reminders)
      .returning('id')
      .executeTakeFirst();
    if (!claimed || !reporter || reporter.status !== 'active') continue;
    const context: IncidentMessageContext = {
      customerName: c.tenant.name,
      reference: incReference(r.number),
      title: r.title,
      kind: 'reminder',
      author: author?.display_name ?? 'The team',
      body: question?.body ?? 'The team needs more information from you.',
      runUrl: link(c, r.id),
    };
    await send(c, 'incident_message', [reporter], context, r.id);
    sent++;
  }
  return sent;
}

/** Response, restoration and resolution targets: one email to the team when at risk, one when missed. */
async function sweepTargets(c: Ctx): Promise<number> {
  const s = tenantDb(c.db, c.tenant.schema_name);
  const settings = (c.tenant.inc_settings ?? {}) as IncSettings;
  const open = await s
    .selectFrom('incidents')
    .select([
      'id', 'number', 'title', 'category', 'subcategory', 'priority', 'status', 'assigned_to', 'created_at', 'acknowledged_at', 'restored_at', 'resolved_at',
      'reopened_at', 'paused_since', 'paused_seconds', 'pause_log', 'sla_notified', 'version',
    ])
    .where('status', 'in', ['new', 'in_progress', 'on_hold', 'restored'])
    .execute();
  let sent = 0;
  let team: Person[] | null = null;
  for (const r of open) {
    const sla = incSlaFor(r, settings);
    const notified = { ...((r.sla_notified ?? {}) as Record<string, string>) };
    const due: { key: string; kind: 'sla_warning' | 'sla_breached'; body: string }[] = [];
    for (const which of ['response', 'restoration', 'resolution'] as const) {
      const clock = sla[which];
      const what = which === 'response' ? 'First response' : which === 'restoration' ? 'Service restoration' : 'Resolution';
      const text = `(${INC_PRIORITY_LABELS[r.priority]})`;
      if (clock.state === 'overdue' && !notified[`${which}_breached`]) {
        due.push({ key: `${which}_breached`, kind: 'sla_breached', body: `${what} was due ${srDuration(clock.leftMs ?? 0)} ago ${text}.` });
      } else if (clock.state === 'at_risk' && !notified[`${which}_warning`] && !notified[`${which}_breached`]) {
        due.push({ key: `${which}_warning`, kind: 'sla_warning', body: `${what} is due in ${srDuration(clock.leftMs ?? 0)} ${text}.` });
      }
    }
    if (!due.length) continue;
    const now = new Date().toISOString();
    for (const d of due) notified[d.key] = now;
    // Claim first (compare-and-set on the old value) so two workers don't both send.
    const claimed = await s
      .updateTable('incidents')
      .set({ sla_notified: JSON.stringify(notified) })
      .where('id', '=', r.id)
      .where(sql<boolean>`sla_notified = ${JSON.stringify(r.sla_notified ?? {})}::jsonb`)
      .returning('id')
      .executeTakeFirst();
    if (!claimed) continue;
    team ??= await teamOf(c);
    const to = r.assigned_to ? team.filter((m) => m.id === r.assigned_to) : team;
    // Agents hear about it too.
    for (const d of due) await emitAgentEvent(c.db, c.tenant.id, { id: r.id, number: r.number, priority: r.priority, status: r.status, version: r.version, category: r.category }, d.kind === 'sla_warning' ? 'sla.at_risk' : 'sla.breached', { detail: d.body }, null);
    for (const d of due) {
      const context: IncidentActivityContext = {
        customerName: c.tenant.name,
        reference: incReference(r.number),
        title: r.title,
        categoryLabel: incCategoryLabel(r.category, r.subcategory),
        priorityLabel: INC_PRIORITY_LABELS[r.priority],
        kind: d.kind,
        author: null,
        body: d.body,
        runUrl: link(c, r.id),
      };
      await send(c, 'incident_activity', to, context, r.id);
      sent += to.length;
    }
  }
  return sent;
}

/** A Resolved incident nobody has replied to for INC_AUTOCLOSE_DAYS closes itself. */
async function autoClose(c: Ctx): Promise<number> {
  const s = tenantDb(c.db, c.tenant.schema_name);
  const cutoff = new Date(Date.now() - INC_AUTOCLOSE_DAYS * 86_400_000).toISOString();
  const resolved = await s
    .selectFrom('incidents')
    .select(['id', 'number', 'title', 'reporter_id', 'resolved_at', 'version'])
    .where('status', '=', 'resolved')
    .where('resolved_at', '<=', cutoff)
    .execute();
  let closed = 0;
  for (const r of resolved) {
    // Someone has written since it was resolved: it's being discussed, not forgotten.
    const talked = await s
      .selectFrom('incident_events')
      .select('id')
      .where('incident_id', '=', r.id)
      .where('internal', '=', false)
      .where('kind', 'in', ['comment', 'waiting'])
      .where('created_at', '>', r.resolved_at!)
      .executeTakeFirst();
    if (talked) continue;
    const now = new Date().toISOString();
    const moved = await s
      .updateTable('incidents')
      .set({ status: 'closed', closed_at: now, updated_at: now, version: r.version + 1 })
      .where('id', '=', r.id)
      .where('status', '=', 'resolved')
      .where('version', '=', r.version)
      .returning('id')
      .executeTakeFirst();
    if (!moved) continue;
    await s
      .insertInto('incident_events')
      .values({
        incident_id: r.id,
        kind: 'status_changed',
        from_status: 'resolved',
        to_status: 'closed',
        body: `Closed automatically: no reply for ${INC_AUTOCLOSE_DAYS} days.`,
        actor_type: 'system',
        author_id: null,
        meta: JSON.stringify({ kind: 'close', auto: true }),
      })
      .execute();
    const context: IncidentStatusChangedContext = {
      customerName: c.tenant.name,
      reference: incReference(r.number),
      title: r.title,
      kind: 'auto_close',
      runUrl: link(c, r.id),
    };
    await send(c, 'incident_status_changed', await reporterAndFollowers(c, r.id, r.reporter_id), context, r.id);
    closed++;
  }
  return closed;
}

/**
 * A live major incident whose customer update is due: the comms owner is reminded once; if it is still
 * not posted INC_MAJOR_ESCALATE_AFTER_MINUTES later, the lead and the whole team are told once.
 * Posting an update (or changing the cadence) sets a new due time, which starts the cycle again.
 */
async function remindMajorUpdates(c: Ctx): Promise<number> {
  const s = tenantDb(c.db, c.tenant.schema_name);
  const now = Date.now();
  const due = await s
    .selectFrom('incidents')
    .select(['id', 'number', 'title', 'category', 'subcategory', 'priority', 'lead_id', 'comms_id', 'next_update_due_at', 'update_reminded_at', 'update_escalated_at'])
    .where('major', '=', true)
    .where('major_ended_at', 'is', null)
    .where('status', 'in', ['new', 'in_progress', 'on_hold', 'restored'])
    .where('next_update_due_at', '<=', new Date(now).toISOString())
    .execute();
  let sent = 0;
  let team: Person[] | null = null;
  for (const r of due) {
    const dueAt = new Date(r.next_update_due_at!).getTime();
    const mark = new Date(now).toISOString();
    const context = (kind: 'update_due' | 'update_overdue', minutesLate: number): IncidentActivityContext => ({
      customerName: c.tenant.name,
      reference: incReference(r.number),
      title: r.title,
      categoryLabel: incCategoryLabel(r.category, r.subcategory),
      priorityLabel: INC_PRIORITY_LABELS[r.priority],
      kind,
      author: null,
      body: kind === 'update_due' ? 'The customer is waiting for the next update.' : `The update was due ${minutesLate} minutes ago.`,
      runUrl: link(c, r.id),
    });
    // Claim each step first (the due time must still be the one we read), so two workers never both send.
    if (!r.update_reminded_at || new Date(r.update_reminded_at).getTime() < dueAt) {
      const claimed = await s.updateTable('incidents').set({ update_reminded_at: mark }).where('id', '=', r.id).where('next_update_due_at', '=', r.next_update_due_at!).returning('id').executeTakeFirst();
      if (claimed) {
        team ??= await teamOf(c);
        const to = team.filter((m) => m.id === r.comms_id);
        await send(c, 'incident_activity', to, context('update_due', 0), r.id);
        sent += to.length;
      }
    }
    if (now >= dueAt + INC_MAJOR_ESCALATE_AFTER_MINUTES * 60_000 && (!r.update_escalated_at || new Date(r.update_escalated_at).getTime() < dueAt)) {
      const claimed = await s.updateTable('incidents').set({ update_escalated_at: mark }).where('id', '=', r.id).where('next_update_due_at', '=', r.next_update_due_at!).returning('id').executeTakeFirst();
      if (claimed) {
        team ??= await teamOf(c);
        // The lead first, then everyone else on the team: this one is late.
        const to = team;
        await send(c, 'incident_activity', to, context('update_overdue', Math.round((now - dueAt) / 60_000)), r.id);
        sent += to.length;
      }
    }
  }
  return sent;
}
