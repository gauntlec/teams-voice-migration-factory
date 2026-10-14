import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { platformDb, tenantDb } from '@tvmf/db';
import {
  INC_MAJOR_DEFAULT_INTERVAL,
  INC_OPEN_STATUSES,
  incMajorActive,
  incMajorUpdateClock,
  incProblemReference,
  incReference,
  type DeclareMajorInput,
  type LinkChildrenInput,
  type MajorRolesInput,
  type MajorUpdateInput,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { assertSiteInScope, isSiteScoped } from '../data-collection/site-scope';
import { AgentEventsService } from './agent-events.service';
import { IncidentNotifier } from './incident-notifier';

/** `version = version + 1`, for the updates that don't read the row first. */
const sqlBump = sql<number>`version + 1`;

/**
 * Major incidents: a P1 (or an engineer's call) that gets a lead, a comms owner, a
 * cadence of customer updates and child incidents. Everything here is for engineers
 * and admins except `notices` (what a customer is told) and `details` (the major
 * section of the incident page, trimmed for customers). See docs/INCIDENT-MANAGEMENT.md.
 */
@Injectable()
export class IncidentMajorService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notify: IncidentNotifier,
    private readonly events: AgentEventsService,
  ) {}

  private assertEnabled(t: TenantContext) {
    if (!t.managedServices) throw new ForbiddenException('Managed Services is not switched on for this customer.');
  }

  private async load(t: TenantContext, id: string) {
    const row = await tenantDb(this.db, t.schema).selectFrom('incidents').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('incident not found');
    if (isSiteScoped(t)) assertSiteInScope(t, row.site_id);
    return row;
  }

  private async names(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    if (unique.length === 0) return new Map<string, string>();
    const rows = await platformDb(this.db).selectFrom('users').select(['id', 'display_name']).where('id', 'in', unique).execute();
    return new Map(rows.map((r) => [r.id, r.display_name]));
  }

  private async siteLabel(t: TenantContext, siteId: string | null) {
    if (!siteId) return null;
    const s = await tenantDb(this.db, t.schema).selectFrom('discovery_sites').select(['sitecode', 'name']).where('id', '=', siteId).executeTakeFirst();
    return s ? (s.name ? `${s.sitecode} — ${s.name}` : s.sitecode) : null;
  }

  /** The lead and comms owner must be engineers on this customer (or Super Admins). */
  private async requireStaff(t: TenantContext, ids: string[]) {
    const staff = await this.notify.staff(t);
    for (const id of ids) if (!staff.some((m) => m.id === id)) throw new BadRequestException('The lead and the comms owner must be an engineer on this customer, or a Super Admin.');
  }

  /* ------------------------------ declare, update, roles ------------------------------ */

  async declare(t: TenantContext, user: AuthedUser, id: string, input: DeclareMajorInput) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    if (!INC_OPEN_STATUSES.includes(row.status)) throw new BadRequestException('Only an open incident can be a major incident.');
    if (incMajorActive(row)) throw new ConflictException('This is already a major incident.');
    if (row.parent_id) throw new BadRequestException("This incident is linked under another major incident. Unlink it first if it's a major incident in its own right.");
    const commsId = input.commsId ?? input.leadId;
    await this.requireStaff(t, [input.leadId, commsId]);
    const interval = input.intervalMinutes ?? INC_MAJOR_DEFAULT_INTERVAL[row.priority];
    const now = new Date();
    const next = new Date(now.getTime() + interval * 60_000);
    const updated = await tenantDb(this.db, t.schema)
      .updateTable('incidents')
      .set({
        major: true,
        major_declared_at: now.toISOString(),
        major_declared_by: user.id,
        major_ended_at: null,
        lead_id: input.leadId,
        comms_id: commsId,
        update_interval_minutes: interval,
        next_update_due_at: next.toISOString(),
        update_reminded_at: null,
        update_escalated_at: null,
        // The lead owns it, unless somebody (or an agent) already does.
        ...(row.assigned_to || row.assigned_agent_id ? {} : { assigned_to: input.leadId }),
        ...(row.acknowledged_at ? {} : { acknowledged_at: now.toISOString() }),
        updated_at: now.toISOString(),
        version: row.version + 1,
      })
      .where('id', '=', id)
      .where('version', '=', row.version)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new ConflictException('This incident was just updated by someone else. Refresh and try again.');
    await tenantDb(this.db, t.schema)
      .insertInto('incident_events')
      .values({ incident_id: id, kind: 'major_declared', body: input.summary, author_id: user.id, meta: JSON.stringify({ leadId: input.leadId, commsId, intervalMinutes: interval }) })
      .execute();
    await this.audit.tenant(t.schema, 'incident.major_declared', {
      actor: { id: user.id, email: user.email },
      targetType: 'incident',
      targetId: id,
      detail: { reference: incReference(row.number), leadId: input.leadId, commsId, intervalMinutes: interval },
    });
    const names = await this.names([input.leadId, commsId]);
    await this.events.emit(t.id, updated, 'incident.major_declared', { lead: input.leadId });
    await this.notify.majorDeclared(t, user, updated, { siteLabel: await this.siteLabel(t, row.site_id), lead: names.get(input.leadId) ?? 'An engineer', summary: input.summary, nextUpdateAt: next });
    await this.notify.majorRoleAssigned(t, user, updated, [input.leadId], 'the lead');
    if (commsId !== input.leadId) await this.notify.majorRoleAssigned(t, user, updated, [commsId], 'the comms owner');
    return { ...updated, reference: incReference(row.number) };
  }

  /** A customer update on a live major incident: resets the clock for the next one. */
  async postUpdate(t: TenantContext, user: AuthedUser, id: string, input: MajorUpdateInput) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    if (!incMajorActive(row)) throw new BadRequestException('This is not a live major incident.');
    const interval = input.intervalMinutes ?? row.update_interval_minutes ?? INC_MAJOR_DEFAULT_INTERVAL[row.priority];
    const now = new Date();
    const next = new Date(now.getTime() + interval * 60_000);
    const updated = await tenantDb(this.db, t.schema)
      .updateTable('incidents')
      .set({ update_interval_minutes: interval, next_update_due_at: next.toISOString(), update_reminded_at: null, update_escalated_at: null, updated_at: now.toISOString(), version: row.version + 1 })
      .where('id', '=', id)
      .where('version', '=', row.version)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new ConflictException('This incident was just updated by someone else. Refresh and try again.');
    await tenantDb(this.db, t.schema).insertInto('incident_events').values({ incident_id: id, kind: 'major_update', body: input.body, author_id: user.id, meta: JSON.stringify({ intervalMinutes: interval }) }).execute();
    await this.audit.tenant(t.schema, 'incident.major_update', {
      actor: { id: user.id, email: user.email },
      targetType: 'incident',
      targetId: id,
      detail: { reference: incReference(row.number), intervalMinutes: interval },
    });
    const names = await this.names([row.lead_id]);
    await this.notify.majorUpdated(t, user, updated, { siteLabel: await this.siteLabel(t, row.site_id), lead: names.get(row.lead_id ?? '') ?? 'The team', body: input.body, nextUpdateAt: next });
    return { ...updated, reference: incReference(row.number) };
  }

  async setRoles(t: TenantContext, user: AuthedUser, id: string, input: MajorRolesInput) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    if (!incMajorActive(row)) throw new BadRequestException('This is not a live major incident.');
    const leadId = input.leadId ?? row.lead_id!;
    const commsId = input.commsId ?? row.comms_id!;
    await this.requireStaff(t, [leadId, commsId]);
    const now = new Date().toISOString();
    const updated = await tenantDb(this.db, t.schema)
      .updateTable('incidents')
      .set({ lead_id: leadId, comms_id: commsId, updated_at: now, version: row.version + 1 })
      .where('id', '=', id)
      .where('version', '=', row.version)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new ConflictException('This incident was just updated by someone else. Refresh and try again.');
    const names = await this.names([leadId, commsId]);
    await tenantDb(this.db, t.schema)
      .insertInto('incident_events')
      .values({ incident_id: id, kind: 'assigned', body: `Major incident lead: ${names.get(leadId)}. Comms owner: ${names.get(commsId)}.`, internal: true, author_id: user.id, meta: JSON.stringify({ leadId, commsId }) })
      .execute();
    await this.notify.majorRoleAssigned(t, user, updated, leadId !== row.lead_id ? [leadId] : [], 'the lead');
    await this.notify.majorRoleAssigned(t, user, updated, commsId !== row.comms_id && commsId !== leadId ? [commsId] : [], 'the comms owner');
    return { ...updated, reference: incReference(row.number) };
  }

  /**
   * Called when a major incident reaches a finished state: it stops being live, the
   * clock for updates stops, and - when it was resolved - the customer side is told.
   */
  async end(t: TenantContext, user: AuthedUser, row: { id: string; number: number; title: string; category: string; subcategory: string | null; priority: import('@tvmf/shared').IncPriority; assigned_to: string | null; reporter_id: string; site_id: string | null; lead_id: string | null; version: number }, kind: 'resolve' | 'cancel' | 'duplicate', note: string | null) {
    const now = new Date().toISOString();
    await tenantDb(this.db, t.schema)
      .updateTable('incidents')
      .set({ major_ended_at: now, next_update_due_at: null, update_reminded_at: null, update_escalated_at: null })
      .where('id', '=', row.id)
      .execute();
    await tenantDb(this.db, t.schema)
      .insertInto('incident_events')
      .values({ incident_id: row.id, kind: 'major_ended', body: note, author_id: user.id, meta: JSON.stringify({ kind }) })
      .execute();
    if (kind === 'resolve') {
      const names = await this.names([row.lead_id]);
      await this.notify.majorResolved(t, user, row, { siteLabel: await this.siteLabel(t, row.site_id), lead: names.get(row.lead_id ?? '') ?? 'The team', body: note ?? 'The problem has been fixed.' });
    }
  }

  /* ------------------------------ children ------------------------------ */

  /** The live child incidents of a major incident. */
  async liveChildren(t: TenantContext, parentId: string) {
    return tenantDb(this.db, t.schema).selectFrom('incidents').select(['id', 'number']).where('parent_id', '=', parentId).where('status', 'in', [...INC_OPEN_STATUSES]).execute();
  }

  async linkChildren(t: TenantContext, user: AuthedUser, id: string, input: LinkChildrenInput) {
    this.assertEnabled(t);
    const parent = await this.load(t, id);
    if (!incMajorActive(parent)) throw new BadRequestException('Incidents can only be linked under a live major incident.');
    const s = tenantDb(this.db, t.schema);
    const ids = [...new Set(input.childIds)];
    if (ids.includes(id)) throw new BadRequestException("An incident can't be linked under itself.");
    const kids = await s.selectFrom('incidents').select(['id', 'number', 'status', 'major', 'parent_id']).where('id', 'in', ids).execute();
    if (kids.length !== ids.length) throw new BadRequestException('One of those incidents does not exist for this customer.');
    const hasChildren = await s.selectFrom('incidents').select('parent_id').where('parent_id', 'in', ids).execute();
    for (const k of kids) {
      const ref = incReference(k.number);
      if (!INC_OPEN_STATUSES.includes(k.status)) throw new BadRequestException(`${ref} is already finished, so it can't be linked.`);
      if (k.major) throw new BadRequestException(`${ref} is a major incident itself.`);
      if (hasChildren.some((h) => h.parent_id === k.id)) throw new BadRequestException(`${ref} has incidents linked under it.`);
    }
    const now = new Date().toISOString();
    for (const k of kids) {
      if (k.parent_id === id) continue;
      await s.updateTable('incidents').set({ parent_id: id, updated_at: now, version: sqlBump }).where('id', '=', k.id).execute();
      await s.insertInto('incident_events').values({ incident_id: k.id, kind: 'child_linked', body: `Part of major incident ${incReference(parent.number)}: ${parent.title}`, author_id: user.id, meta: JSON.stringify({ parentId: id }) }).execute();
      await s.insertInto('incident_events').values({ incident_id: id, kind: 'child_linked', body: `Linked ${incReference(k.number)}`, internal: true, author_id: user.id, meta: JSON.stringify({ childId: k.id }) }).execute();
    }
    await this.audit.tenant(t.schema, 'incident.children_linked', {
      actor: { id: user.id, email: user.email },
      targetType: 'incident',
      targetId: id,
      detail: { reference: incReference(parent.number), children: kids.map((k) => incReference(k.number)) },
    });
    return this.childrenOf(t, id);
  }

  async unlinkChild(t: TenantContext, user: AuthedUser, id: string, childId: string) {
    this.assertEnabled(t);
    const parent = await this.load(t, id);
    const s = tenantDb(this.db, t.schema);
    const child = await s.selectFrom('incidents').select(['id', 'number']).where('id', '=', childId).where('parent_id', '=', id).executeTakeFirst();
    if (!child) throw new NotFoundException('That incident is not linked under this one.');
    await s.updateTable('incidents').set({ parent_id: null, updated_at: new Date().toISOString(), version: sqlBump }).where('id', '=', childId).execute();
    await s.insertInto('incident_events').values({ incident_id: childId, kind: 'child_unlinked', body: `No longer part of major incident ${incReference(parent.number)}`, author_id: user.id }).execute();
    await s.insertInto('incident_events').values({ incident_id: id, kind: 'child_unlinked', body: `Unlinked ${incReference(child.number)}`, internal: true, author_id: user.id }).execute();
    return this.childrenOf(t, id);
  }

  private async childrenOf(t: TenantContext, parentId: string) {
    const rows = await tenantDb(this.db, t.schema)
      .selectFrom('incidents as i')
      .leftJoin('discovery_sites as ds', 'ds.id', 'i.site_id')
      .select(['i.id as id', 'i.number as number', 'i.title as title', 'i.status as status', 'i.priority as priority', 'ds.sitecode as sitecode'])
      .where('i.parent_id', '=', parentId)
      .orderBy('i.number')
      .execute();
    return rows.map((r) => ({ ...r, reference: incReference(r.number) }));
  }

  /* ------------------------------ what a page shows ------------------------------ */

  /** The major, parent/child, problem and review parts of an incident page. Customers see less. */
  async details(
    t: TenantContext,
    row: { id: string; major: boolean; major_ended_at: string | null; major_declared_at: string | null; status: import('@tvmf/shared').IncStatus; lead_id: string | null; comms_id: string | null; update_interval_minutes: number | null; next_update_due_at: string | null; parent_id: string | null; problem_id: string | null },
    canManage: boolean,
  ) {
    const s = tenantDb(this.db, t.schema);
    const [children, parent, problem, review, names] = await Promise.all([
      this.childrenOf(t, row.id),
      row.parent_id
        ? s.selectFrom('incidents').select(['id', 'number', 'title', 'status', 'site_id']).where('id', '=', row.parent_id).executeTakeFirst()
        : undefined,
      canManage && row.problem_id
        ? s.selectFrom('problems').select(['id', 'number', 'title', 'status', 'root_cause', 'workaround']).where('id', '=', row.problem_id).executeTakeFirst()
        : undefined,
      s.selectFrom('incident_reviews').select(['status', 'shared_at', 'updated_at']).where('incident_id', '=', row.id).executeTakeFirst(),
      this.names([row.lead_id, row.comms_id]),
    ]);
    return {
      major: row.major
        ? {
            active: incMajorActive(row),
            declared_at: row.major_declared_at,
            ended_at: row.major_ended_at,
            lead_name: names.get(row.lead_id ?? '') ?? null,
            comms_name: names.get(row.comms_id ?? '') ?? null,
            lead_id: canManage ? row.lead_id : undefined,
            comms_id: canManage ? row.comms_id : undefined,
            interval_minutes: canManage ? row.update_interval_minutes : undefined,
            update_clock: incMajorUpdateClock(row),
          }
        : null,
      children,
      parent: parent ? { id: parent.id, reference: incReference(parent.number), title: parent.title, status: parent.status } : null,
      problem: problem ? { id: problem.id, reference: incProblemReference(problem.number), title: problem.title, status: problem.status, root_cause: problem.root_cause, workaround: problem.workaround } : null,
      // A draft review is for the team; customers know of it once it is shared.
      review: review && (canManage || review.status === 'shared') ? review : null,
    };
  }

  /* ------------------------------ customer notice ------------------------------ */

  /** Live major incidents, as a customer is told about them: what we know and when we'll next update. */
  async notices(t: TenantContext) {
    this.assertEnabled(t);
    const s = tenantDb(this.db, t.schema);
    let q = s
      .selectFrom('incidents as i')
      .leftJoin('discovery_sites as ds', 'ds.id', 'i.site_id')
      .select(['i.id as id', 'i.number as number', 'i.title as title', 'i.priority as priority', 'i.site_id as site_id', 'ds.sitecode as sitecode', 'i.major_declared_at as declared_at', 'i.next_update_due_at as next_update_due_at', 'i.lead_id as lead_id'])
      .where('i.major', '=', true)
      .where('i.major_ended_at', 'is', null)
      .where('i.status', 'in', [...INC_OPEN_STATUSES])
      .orderBy('i.major_declared_at', 'desc');
    // A site contact is told about their sites' incidents, and about customer-wide ones (which they can't open).
    if (isSiteScoped(t)) q = q.where((eb) => eb.or([eb('i.site_id', 'in', t.siteScope), eb('i.site_id', 'is', null)]));
    const rows = await q.execute();
    if (rows.length === 0) return [];
    const events = await s
      .selectFrom('incident_events')
      .select(['incident_id', 'body', 'created_at', 'kind'])
      .where('incident_id', 'in', rows.map((r) => r.id))
      .where('kind', 'in', ['major_declared', 'major_update'])
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((r) => {
      const latest = events.find((e) => e.incident_id === r.id);
      return {
        id: r.id,
        reference: incReference(r.number),
        title: r.title,
        sitecode: r.sitecode,
        declared_at: r.declared_at,
        next_update_due_at: r.next_update_due_at,
        latest_update: latest ? { body: latest.body, at: latest.created_at } : null,
        can_open: !isSiteScoped(t) || (!!r.site_id && t.siteScope.includes(r.site_id)),
      };
    });
  }
}
