import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { platformDb, tenantDb } from '@tvmf/db';
import {
  INC_ATTACHMENT_MAX_BYTES,
  INC_CATEGORY_BY_KEY,
  INC_LIVE_STATUSES,
  INC_NOTE_REQUIRED,
  INC_OPEN_STATUSES,
  INC_STATUS_LABELS,
  SITE_MODE_LABELS,
  SR_ATTACHMENT_TYPES,
  incCanReopen,
  incCleanAnswers,
  incEffectiveMatrix,
  incEffectiveTargets,
  incMoveKind,
  incNextClock,
  incPause,
  incPriority,
  incReference,
  incSla,
  incCategoryLabel,
  type CreateIncidentInput,
  type IncDetails,
  type IncHoldReason,
  type IncPriority,
  type IncSettings,
  type IncStatus,
  type IncidentAssignInput,
  type IncidentCommentInput,
  type IncidentPriorityInput,
  type IncidentSettingsInput,
  type IncidentStatusInput,
  type IncItemInput,
  type ListIncidentsQuery,
  type SimilarIncidentsQuery,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { assertSiteInScope, isSiteScoped } from '../data-collection/site-scope';
import { FilesService } from '../files/files.service';

interface StaffMember {
  id: string;
  email: string;
  display_name: string;
  role: string;
}

/**
 * Incident management: something that worked has stopped working, or is working
 * badly. Customers raise incidents; the engineers and admins on that customer
 * work them (New -> In progress -> Restored -> Resolved -> Closed). Every
 * endpoint needs Managed Services switched on for the customer.
 *
 * Visibility mirrors service requests: everyone with inc:read on the customer
 * sees its incidents except a site contact, who only sees (and can only raise)
 * incidents for their own sites. Internal notes are staff-only. See
 * docs/INCIDENT-MANAGEMENT.md.
 */
@Injectable()
export class IncidentsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  private assertEnabled(t: TenantContext) {
    if (!t.managedServices) throw new ForbiddenException('Managed Services is not switched on for this customer.');
  }

  private async names(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    if (unique.length === 0) return new Map<string, string>();
    const rows = await platformDb(this.db).selectFrom('users').select(['id', 'display_name']).where('id', 'in', unique).execute();
    return new Map(rows.map((r) => [r.id, r.display_name]));
  }

  /** The people who work this customer's incidents: its engineers and every Super Admin. */
  async staff(t: TenantContext): Promise<StaffMember[]> {
    this.assertEnabled(t);
    const p = platformDb(this.db);
    const [engineers, admins] = await Promise.all([
      p
        .selectFrom('tenant_memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select(['u.id as id', 'u.email as email', 'u.display_name as display_name', 'u.role as role'])
        .where('m.tenant_id', '=', t.id)
        .where('u.role', '=', 'ENGINEER')
        .where('u.status', '=', 'active')
        .execute(),
      p.selectFrom('users').select(['id', 'email', 'display_name', 'role']).where('role', '=', 'SUPER_ADMIN').where('status', '=', 'active').execute(),
    ]);
    const byId = new Map<string, StaffMember>();
    for (const u of [...engineers, ...admins]) byId.set(u.id, u);
    return [...byId.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  private async load(t: TenantContext, id: string) {
    const row = await tenantDb(this.db, t.schema).selectFrom('incidents').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('incident not found');
    // A site contact sees only their own sites' incidents; a customer-wide one is outside their access.
    if (isSiteScoped(t)) assertSiteInScope(t, row.site_id);
    return row;
  }

  private async isWatcher(t: TenantContext, incidentId: string, userId: string) {
    const w = await tenantDb(this.db, t.schema)
      .selectFrom('incident_watchers')
      .select('user_id')
      .where('incident_id', '=', incidentId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return !!w;
  }

  /* ------------------------------ settings ------------------------------ */

  private async settingsRaw(t: TenantContext): Promise<IncSettings> {
    const row = await platformDb(this.db).selectFrom('tenants').select('inc_settings').where('id', '=', t.id).executeTakeFirst();
    return (row?.inc_settings ?? {}) as IncSettings;
  }

  /** Targets and the priority matrix, with defaults filled in. Everyone on the customer can read them. */
  async settings(t: TenantContext) {
    this.assertEnabled(t);
    const raw = await this.settingsRaw(t);
    return { targets: incEffectiveTargets(raw), matrix: incEffectiveMatrix(raw), customTargets: Object.keys(raw.targets ?? {}), customMatrix: !!raw.matrix };
  }

  /** Super Admins only: targets and matrix are part of the customer's service terms. */
  async updateSettings(t: TenantContext, user: AuthedUser, input: IncidentSettingsInput) {
    this.assertEnabled(t);
    if (user.role !== 'SUPER_ADMIN') throw new ForbiddenException('Only a Super Admin can change incident settings.');
    const current = await this.settingsRaw(t);
    const next: IncSettings = { ...current };
    if (input.targets !== undefined) next.targets = input.targets as IncSettings['targets'];
    if (input.matrix !== undefined) next.matrix = input.matrix as IncSettings['matrix'];
    await platformDb(this.db).updateTable('tenants').set({ inc_settings: JSON.stringify(next) }).where('id', '=', t.id).execute();
    await this.audit.tenant(t.schema, 'incident.settings_changed', {
      actor: { id: user.id, email: user.email },
      targetType: 'tenant',
      targetId: t.id,
      detail: next as unknown as Record<string, unknown>,
    });
    return this.settings(t);
  }

  /* ------------------------------ lookups ------------------------------ */

  /** Sites an incident can be raised for: operations-mode sites (a site contact: their own). */
  async sites(t: TenantContext) {
    this.assertEnabled(t);
    let q = tenantDb(this.db, t.schema).selectFrom('discovery_sites').select(['id', 'sitecode', 'name', 'mode']).orderBy('sitecode');
    if (isSiteScoped(t)) q = q.where('id', 'in', t.siteScope);
    return q.execute();
  }

  private async loadSite(t: TenantContext, siteId: string) {
    const site = await tenantDb(this.db, t.schema).selectFrom('discovery_sites').select(['id', 'sitecode', 'name', 'mode']).where('id', '=', siteId).executeTakeFirst();
    if (!site) throw new BadRequestException('That site does not exist for this customer.');
    if (isSiteScoped(t)) assertSiteInScope(t, siteId);
    return site;
  }

  /* ------------------------------ list / get ------------------------------ */

  async list(t: TenantContext, user: AuthedUser, q: ListIncidentsQuery) {
    this.assertEnabled(t);
    let query = tenantDb(this.db, t.schema)
      .selectFrom('incidents as i')
      .leftJoin('discovery_sites as ds', 'ds.id', 'i.site_id')
      .select([
        'i.id as id',
        'i.number as number',
        'i.title as title',
        'i.category as category',
        'i.subcategory as subcategory',
        'i.priority as priority',
        'i.status as status',
        'i.hold_reason as hold_reason',
        'i.impact as impact',
        'i.urgency as urgency',
        'i.site_id as site_id',
        'ds.sitecode as sitecode',
        'i.reporter_id as reporter_id',
        'i.assigned_to as assigned_to',
        'i.assigned_agent_id as assigned_agent_id',
        'i.created_at as created_at',
        'i.updated_at as updated_at',
        'i.acknowledged_at as acknowledged_at',
        'i.restored_at as restored_at',
        'i.resolved_at as resolved_at',
        'i.reopened_at as reopened_at',
        'i.paused_since as paused_since',
        'i.paused_seconds as paused_seconds',
      ])
      .orderBy('i.number', 'desc')
      .limit(q.limit);
    if (q.status === 'open') query = query.where('i.status', 'in', [...INC_LIVE_STATUSES]);
    else if (q.status !== 'all') query = query.where('i.status', '=', q.status as IncStatus);
    if (q.category) query = query.where('i.category', '=', q.category);
    if (q.priority) query = query.where('i.priority', '=', q.priority);
    if (q.siteId) query = query.where('i.site_id', '=', q.siteId);
    if (q.assigned === 'me') query = query.where('i.assigned_to', '=', user.id);
    if (q.assigned === 'none') query = query.where('i.assigned_to', 'is', null).where('i.assigned_agent_id', 'is', null);
    if (q.q) {
      const like = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      const num = /^(?:inc-?)?(\d{1,9})$/i.exec(q.q)?.[1];
      query = query.where((eb) => eb.or([eb('i.title', 'ilike', like), ...(num ? [eb('i.number', '=', Number(num))] : [])]));
    }
    if (isSiteScoped(t)) query = query.where('i.site_id', 'in', t.siteScope);
    const rows = await query.execute();
    const names = await this.names(rows.flatMap((r) => [r.reporter_id, r.assigned_to]));
    const targets = incEffectiveTargets(await this.settingsRaw(t));
    const now = Date.now();
    return rows.map((r) => ({
      ...r,
      sla: incNextClock(incSla(r, targets, now)),
      reference: incReference(r.number),
      category_label: incCategoryLabel(r.category, r.subcategory),
      reporter_name: names.get(r.reporter_id) ?? null,
      assigned_to_name: r.assigned_to ? (names.get(r.assigned_to) ?? null) : null,
    }));
  }

  /**
   * Open incidents of the same category at the same site (or customer-wide), so
   * someone about to raise one can follow what the team is already working on.
   */
  async similar(t: TenantContext, user: AuthedUser, q: SimilarIncidentsQuery) {
    this.assertEnabled(t);
    let query = tenantDb(this.db, t.schema)
      .selectFrom('incidents as i')
      .leftJoin('discovery_sites as ds', 'ds.id', 'i.site_id')
      .select(['i.id as id', 'i.number as number', 'i.title as title', 'i.status as status', 'i.priority as priority', 'i.created_at as created_at', 'ds.sitecode as sitecode', 'i.reporter_id as reporter_id'])
      .where('i.category', '=', q.category)
      .where('i.status', 'in', [...INC_OPEN_STATUSES])
      .orderBy('i.number', 'desc')
      .limit(5);
    if (q.siteId) query = query.where((eb) => eb.or([eb('i.site_id', '=', q.siteId!), eb('i.site_id', 'is', null)]));
    if (isSiteScoped(t)) query = query.where('i.site_id', 'in', t.siteScope);
    const rows = await query.execute();
    const watching = rows.length
      ? new Set(
          (
            await tenantDb(this.db, t.schema)
              .selectFrom('incident_watchers')
              .select('incident_id')
              .where('user_id', '=', user.id)
              .where('incident_id', 'in', rows.map((r) => r.id))
              .execute()
          ).map((w) => w.incident_id),
        )
      : new Set<string>();
    return rows.map(({ reporter_id, ...r }) => ({ ...r, reference: incReference(r.number), following: reporter_id === user.id || watching.has(r.id) }));
  }

  async get(t: TenantContext, id: string, canManage: boolean, viewerId: string) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    const s = tenantDb(this.db, t.schema);
    const [site, events, items, watchers] = await Promise.all([
      row.site_id ? s.selectFrom('discovery_sites').select(['id', 'sitecode', 'name']).where('id', '=', row.site_id).executeTakeFirst() : null,
      s.selectFrom('incident_events').selectAll().where('incident_id', '=', id).$if(!canManage, (qb) => qb.where('internal', '=', false)).orderBy('created_at').execute(),
      s.selectFrom('incident_items').selectAll().where('incident_id', '=', id).orderBy('created_at').execute(),
      s.selectFrom('incident_watchers').select('user_id').where('incident_id', '=', id).execute(),
    ]);
    const watcherIds = watchers.map((w) => w.user_id);
    const names = await this.names([row.reporter_id, row.assigned_to, ...events.map((e) => e.author_id), ...(canManage ? watcherIds : [])]);
    const settings = await this.settingsRaw(t);
    const targets = incEffectiveTargets(settings);
    const own = row.reporter_id === viewerId;
    const watching = watcherIds.includes(viewerId);
    const { dedup_key: _dedup, sla_notified: _notified, assigned_agent_id: _agent, ...visible } = row;
    return {
      incident: {
        ...(canManage ? row : visible),
        reference: incReference(row.number),
        category_label: incCategoryLabel(row.category, row.subcategory),
        sitecode: site?.sitecode ?? null,
        site_name: site?.name ?? null,
        reporter_name: names.get(row.reporter_id) ?? null,
        assigned_to_name: row.assigned_to ? (names.get(row.assigned_to) ?? null) : null,
      },
      sla: { ...incSla(row, targets), target: targets[row.priority] },
      // What the viewer may do next, so the page does not have to re-derive the rules.
      can: {
        confirmFixed: !canManage && row.status === 'resolved' && (own || watching),
        reopen: (canManage || own || watching) && incCanReopen(row.status, row.resolved_at),
        cancel: !canManage && own && row.status === 'new',
      },
      watching,
      watchers: canManage ? watcherIds.map((uid) => ({ id: uid, display_name: names.get(uid) ?? 'Unknown user' })) : undefined,
      items,
      // The reason for a priority change stays with the team.
      events: events.map((e) => ({
        ...e,
        body: !canManage && e.kind === 'priority_changed' ? null : e.body,
        author_name: names.get(e.author_id ?? '') ?? null,
      })),
    };
  }

  /* ------------------------------ raise ------------------------------ */

  async create(t: TenantContext, user: AuthedUser, input: CreateIncidentInput, canManage: boolean) {
    this.assertEnabled(t);
    const def = INC_CATEGORY_BY_KEY[input.category]!;
    if (input.priority && !canManage) throw new ForbiddenException('Priority is worked out from the impact and urgency. The team can change it once the incident is raised.');
    const siteId = input.siteId ?? null;
    const site = siteId ? await this.loadSite(t, siteId) : undefined;
    if (site && site.mode !== 'operations') {
      throw new BadRequestException(`${site.sitecode} is still in ${SITE_MODE_LABELS[site.mode].toLowerCase()} mode. Incidents open for a site once it moves to operations.`);
    }
    if (isSiteScoped(t) && !siteId) throw new ForbiddenException('You can only raise incidents for your own sites.');
    const cleaned = incCleanAnswers(input.category, input.answers);
    if (!cleaned.ok) throw new BadRequestException(cleaned.errors.join('. '));

    const calc = incPriority(input.impact, input.urgency, input.category, incEffectiveMatrix(await this.settingsRaw(t)));
    const priority: IncPriority = input.priority ?? calc.priority;
    const details: IncDetails = {
      answers: cleaned.answers,
      example_calls: input.exampleCalls,
      ...(input.contactPhone ? { contact_phone: input.contactPhone } : {}),
    };

    const row = await this.db.transaction().execute(async (trx) => {
      const s = tenantDb(trx, t.schema);
      const created = await s
        .insertInto('incidents')
        .values({
          title: input.title,
          description: input.description,
          category: input.category,
          subcategory: input.subcategory ?? null,
          site_id: siteId,
          impact: input.impact,
          urgency: input.urgency,
          priority,
          priority_overridden: priority !== calc.priority,
          source: canManage ? 'staff' : 'customer',
          details: JSON.stringify(details),
          reporter_id: user.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await s.insertInto('incident_events').values({ incident_id: created.id, kind: 'created', to_status: 'new', author_id: user.id }).execute();
      if (input.items.length) {
        await s
          .insertInto('incident_items')
          .values(input.items.map((i) => ({ incident_id: created.id, kind: i.kind, ref: i.ref, label: i.label ?? null, created_by: user.id })))
          .onConflict((oc) => oc.columns(['incident_id', 'kind', 'ref']).doNothing())
          .execute();
      }
      return created;
    });

    const reference = incReference(row.number);
    await this.audit.tenant(t.schema, 'incident.created', {
      actor: { id: user.id, email: user.email },
      targetType: 'incident',
      targetId: row.id,
      detail: { reference, category: row.category, priority: row.priority, site: site?.sitecode ?? null, def: def.skill },
    });
    return { ...row, reference };
  }

  /* ------------------------------ workflow ------------------------------ */

  /**
   * Moves an incident (see incMoveKind). Engineers and admins make every move.
   * The person who raised it (or watches it) can cancel it while it is New,
   * confirm a resolution (closing it) and reopen it within INC_REOPEN_DAYS.
   */
  async move(t: TenantContext, user: AuthedUser, id: string, input: IncidentStatusInput, canManage: boolean) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    const from = row.status;
    const to = input.to;
    const kind = incMoveKind(from, to);
    if (!kind) throw new BadRequestException(`A ${INC_STATUS_LABELS[from].toLowerCase()} incident can't be moved to ${INC_STATUS_LABELS[to].toLowerCase()}.`);
    const own = row.reporter_id === user.id;
    if (!canManage) {
      const involved = own || (await this.isWatcher(t, id, user.id));
      const allowed = (kind === 'cancel' && from === 'new' && own) || ((kind === 'close' || kind === 'reopen') && involved);
      if (!allowed) {
        throw new ForbiddenException(
          'Only the engineers on this customer can move an incident on. You can cancel your own incident while it is still New, confirm it is fixed, or say it is still broken.',
        );
      }
    }
    if (kind === 'reopen' && !incCanReopen(from, row.resolved_at)) {
      throw new BadRequestException('An incident can only be reopened within 7 days of being resolved. Raise a new incident instead.');
    }
    const note = input.note?.trim() || null;
    if (INC_NOTE_REQUIRED.includes(kind) && !note && !(kind === 'cancel' && !canManage)) {
      throw new BadRequestException(
        kind === 'restore' ? 'Say how service was restored.' : kind === 'resolve' ? 'Say what fixed it.' : kind === 'reopen' ? 'Say what is still wrong.' : kind === 'duplicate' ? 'Say which incident this repeats.' : 'Say why.',
      );
    }
    if (kind === 'hold' && !input.holdReason) throw new BadRequestException('Say what the incident is waiting on.');
    let duplicateOf: string | null = null;
    if (kind === 'duplicate') {
      if (!input.duplicateOf) throw new BadRequestException('Choose the incident this repeats.');
      if (input.duplicateOf === id) throw new BadRequestException("An incident can't be a duplicate of itself.");
      const original = await tenantDb(this.db, t.schema).selectFrom('incidents').select('id').where('id', '=', input.duplicateOf).executeTakeFirst();
      if (!original) throw new BadRequestException('That incident does not exist for this customer.');
      duplicateOf = original.id;
    }

    const now = new Date().toISOString();
    const holdReason: IncHoldReason | null = to === 'on_hold' ? (input.holdReason ?? null) : null;
    const set: Record<string, unknown> = {
      status: to,
      hold_reason: holdReason,
      updated_at: now,
      version: row.version + 1,
      // Any change of state ends the "waiting" reminders.
      waiting_reminded_at: null,
      waiting_reminders: 0,
      ...incPause(row, { priority: row.priority, status: to, hold_reason: holdReason }, now),
    };
    // The team's first move is the acknowledgement the response target is measured to.
    if (canManage && !row.acknowledged_at) set.acknowledged_at = now;
    if (kind === 'acknowledge' && !row.assigned_to && !row.assigned_agent_id) set.assigned_to = user.id;
    if (kind === 'restore') set.restored_at = now;
    if (kind === 'resolve') set.resolved_at = now;
    if (kind === 'close') set.closed_at = now;
    if (kind === 'cancel' || kind === 'duplicate') set.cancelled_at = now;
    if (kind === 'duplicate') set.duplicate_of = duplicateOf;
    if (kind === 'reopen') {
      // A reopen starts the restoration and resolution clocks again (and their emails).
      const notified = { ...((row.sla_notified ?? {}) as Record<string, string>) };
      for (const k of Object.keys(notified)) if (k.startsWith('restoration_') || k.startsWith('resolution_')) delete notified[k];
      Object.assign(set, { reopened_at: now, restored_at: null, resolved_at: null, closed_at: null, paused_seconds: 0, sla_notified: JSON.stringify(notified) });
    }
    const updated = await tenantDb(this.db, t.schema)
      .updateTable('incidents')
      .set(set)
      .where('id', '=', id)
      .where('version', '=', row.version) // someone else changing it at the same moment loses, not both
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new ConflictException('This incident was just updated by someone else. Refresh and try again.');

    await tenantDb(this.db, t.schema)
      .insertInto('incident_events')
      .values({
        incident_id: id,
        kind: 'status_changed',
        from_status: from,
        to_status: to,
        body: note,
        author_id: user.id,
        meta: JSON.stringify({ kind, ...(holdReason ? { holdReason } : {}), ...(duplicateOf ? { duplicateOf } : {}) }),
      })
      .execute();
    await this.audit.tenant(t.schema, 'incident.status_changed', {
      actor: { id: user.id, email: user.email },
      targetType: 'incident',
      targetId: id,
      detail: { reference: incReference(row.number), from, to, kind, holdReason },
    });
    return { ...updated, reference: incReference(row.number) };
  }

  async assign(t: TenantContext, user: AuthedUser, id: string, input: IncidentAssignInput) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    let assigneeName = 'Unassigned';
    if (input.userId) {
      const member = (await this.staff(t)).find((m) => m.id === input.userId);
      if (!member) throw new BadRequestException('Incidents can only be assigned to an engineer on this customer, or a Super Admin.');
      assigneeName = member.display_name;
    }
    const updated = await tenantDb(this.db, t.schema)
      .updateTable('incidents')
      .set({ assigned_to: input.userId, assigned_agent_id: null, updated_at: new Date().toISOString(), version: row.version + 1 })
      .where('id', '=', id)
      .where('version', '=', row.version)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new ConflictException('This incident was just updated by someone else. Refresh and try again.');
    await tenantDb(this.db, t.schema)
      .insertInto('incident_events')
      .values({ incident_id: id, kind: 'assigned', body: assigneeName, author_id: user.id, meta: JSON.stringify({ userId: input.userId }) })
      .execute();
    await this.audit.tenant(t.schema, 'incident.assigned', {
      actor: { id: user.id, email: user.email },
      targetType: 'incident',
      targetId: id,
      detail: { reference: incReference(row.number), assigneeId: input.userId },
    });
    return { ...updated, reference: incReference(row.number) };
  }

  /** Staff change the priority (with a reason); the customer sees that it changed, not why. */
  async setPriority(t: TenantContext, user: AuthedUser, id: string, input: IncidentPriorityInput) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    if (!INC_LIVE_STATUSES.includes(row.status)) throw new BadRequestException("A finished incident's priority can't be changed.");
    if (input.priority === row.priority) throw new BadRequestException(`It is already ${input.priority.toUpperCase()}.`);
    const now = new Date().toISOString();
    const calc = incPriority(row.impact, row.urgency, row.category, incEffectiveMatrix(await this.settingsRaw(t)));
    const updated = await tenantDb(this.db, t.schema)
      .updateTable('incidents')
      .set({
        priority: input.priority,
        priority_overridden: input.priority !== calc.priority,
        updated_at: now,
        version: row.version + 1,
        ...incPause(row, { priority: input.priority, status: row.status, hold_reason: row.hold_reason }, now),
      })
      .where('id', '=', id)
      .where('version', '=', row.version)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new ConflictException('This incident was just updated by someone else. Refresh and try again.');
    await tenantDb(this.db, t.schema)
      .insertInto('incident_events')
      .values({ incident_id: id, kind: 'priority_changed', from_status: row.priority, to_status: input.priority, body: input.reason, author_id: user.id, meta: JSON.stringify({ from: row.priority, to: input.priority }) })
      .execute();
    await this.audit.tenant(t.schema, 'incident.priority_changed', {
      actor: { id: user.id, email: user.email },
      targetType: 'incident',
      targetId: id,
      detail: { reference: incReference(row.number), from: row.priority, to: input.priority, reason: input.reason },
    });
    return { ...updated, reference: incReference(row.number) };
  }

  /**
   * A comment on the incident.
   * - Team, public: the customer sees it. With waitForReply it is a question:
   *   the incident goes on hold, waiting on the customer (the clocks pause)
   *   until they reply.
   * - Team, internal: never shown to the customer.
   * - Customer: if the team was waiting on them, that ends the hold.
   */
  async comment(t: TenantContext, user: AuthedUser, id: string, input: IncidentCommentInput, canManage: boolean) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    if (input.internal && !canManage) throw new ForbiddenException('Only engineers and admins can add internal notes.');
    if (input.waitForReply && (!canManage || input.internal)) throw new BadRequestException('Only a public comment from the team can wait for the customer.');
    if (input.waitForReply && !['new', 'in_progress', 'restored', 'on_hold'].includes(row.status)) {
      throw new BadRequestException('Only an open incident can wait on the customer.');
    }
    if (!canManage && !INC_LIVE_STATUSES.includes(row.status)) {
      throw new BadRequestException(row.status === 'closed' ? 'This incident is closed. Say it is still broken to reopen it, or raise a new incident.' : 'This incident is finished.');
    }
    const s = tenantDb(this.db, t.schema);
    const now = new Date().toISOString();
    const question = !!input.waitForReply;
    const event = await s
      .insertInto('incident_events')
      .values({ incident_id: id, kind: question ? 'waiting' : 'comment', body: input.body, internal: !!input.internal, author_id: user.id })
      .returningAll()
      .executeTakeFirstOrThrow();

    const set: Record<string, unknown> = { updated_at: now, version: row.version + 1 };
    if (canManage && !input.internal && !row.acknowledged_at) set.acknowledged_at = now;
    let resumed = false;
    if (question && !(row.status === 'on_hold' && row.hold_reason === 'customer')) {
      Object.assign(set, { status: 'on_hold', hold_reason: 'customer', waiting_reminded_at: null, waiting_reminders: 0 }, incPause(row, { priority: row.priority, status: 'on_hold', hold_reason: 'customer' }, now));
    } else if (!canManage && row.status === 'on_hold' && row.hold_reason === 'customer') {
      resumed = true;
      Object.assign(set, { status: 'in_progress', hold_reason: null, waiting_reminded_at: null, waiting_reminders: 0 }, incPause(row, { priority: row.priority, status: 'in_progress', hold_reason: null }, now));
    }
    await s.updateTable('incidents').set(set).where('id', '=', id).execute();
    if (resumed) {
      await s.insertInto('incident_events').values({ incident_id: id, kind: 'resumed', from_status: 'on_hold', to_status: 'in_progress', author_id: user.id }).execute();
    }
    return event;
  }

  /* ------------------------------ watchers and items ------------------------------ */

  /** Follow an incident. Staff can add a customer user on this customer. */
  async watch(t: TenantContext, user: AuthedUser, id: string, targetUserId: string | undefined, canManage: boolean) {
    this.assertEnabled(t);
    await this.load(t, id);
    const who = targetUserId ?? user.id;
    if (who !== user.id) {
      if (!canManage) throw new ForbiddenException('You can only add yourself.');
      const member = await platformDb(this.db)
        .selectFrom('users as u')
        .innerJoin('tenant_memberships as m', 'm.user_id', 'u.id')
        .select('u.id')
        .where('m.tenant_id', '=', t.id)
        .where('u.id', '=', who)
        .where('u.status', '=', 'active')
        .executeTakeFirst();
      if (!member) throw new BadRequestException('That person is not a user on this customer.');
    }
    await tenantDb(this.db, t.schema)
      .insertInto('incident_watchers')
      .values({ incident_id: id, user_id: who, added_by: user.id })
      .onConflict((oc) => oc.columns(['incident_id', 'user_id']).doNothing())
      .execute();
    return { ok: true };
  }

  async unwatch(t: TenantContext, user: AuthedUser, id: string, targetUserId: string | undefined, canManage: boolean) {
    this.assertEnabled(t);
    await this.load(t, id);
    const who = targetUserId ?? user.id;
    if (who !== user.id && !canManage) throw new ForbiddenException('You can only remove yourself.');
    await tenantDb(this.db, t.schema).deleteFrom('incident_watchers').where('incident_id', '=', id).where('user_id', '=', who).execute();
    return { ok: true };
  }

  async addItem(t: TenantContext, user: AuthedUser, id: string, input: IncItemInput) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    const s = tenantDb(this.db, t.schema);
    const item = await s
      .insertInto('incident_items')
      .values({ incident_id: id, kind: input.kind, ref: input.ref, label: input.label ?? null, created_by: user.id })
      .onConflict((oc) => oc.columns(['incident_id', 'kind', 'ref']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (!item) return s.selectFrom('incident_items').selectAll().where('incident_id', '=', id).where('kind', '=', input.kind).where('ref', '=', input.ref).executeTakeFirstOrThrow();
    await s.insertInto('incident_events').values({ incident_id: id, kind: 'link', body: input.label ?? input.ref, internal: true, author_id: user.id, meta: JSON.stringify({ kind: input.kind, ref: input.ref }) }).execute();
    await this.audit.tenant(t.schema, 'incident.item_linked', {
      actor: { id: user.id, email: user.email },
      targetType: 'incident',
      targetId: id,
      detail: { reference: incReference(row.number), kind: input.kind, ref: input.ref },
    });
    return item;
  }

  async removeItem(t: TenantContext, user: AuthedUser, id: string, itemId: string) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    const removed = await tenantDb(this.db, t.schema).deleteFrom('incident_items').where('incident_id', '=', id).where('id', '=', itemId).returning(['kind', 'ref']).executeTakeFirst();
    if (!removed) throw new NotFoundException('item not found');
    await this.audit.tenant(t.schema, 'incident.item_unlinked', {
      actor: { id: user.id, email: user.email },
      targetType: 'incident',
      targetId: id,
      detail: { reference: incReference(row.number), kind: removed.kind, ref: removed.ref },
    });
    return { ok: true };
  }

  /* ------------------------------ attachments ------------------------------ */

  async attachments(t: TenantContext, id: string) {
    this.assertEnabled(t);
    await this.load(t, id);
    return this.files.list(t, { sourceType: 'incident', sourceId: id });
  }

  /** Anyone who can see the incident can attach a file (screenshots, call traces, logs). */
  async attach(t: TenantContext, user: AuthedUser, id: string, file: { originalname: string; mimetype: string; buffer: Buffer; size: number } | undefined) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    if (!file) throw new BadRequestException('Choose a file to attach.');
    if (file.size > INC_ATTACHMENT_MAX_BYTES) throw new BadRequestException('That file is too large (10 MB at most).');
    if (!SR_ATTACHMENT_TYPES.test(file.mimetype)) {
      throw new BadRequestException("That kind of file can't be attached. Use a picture, PDF, Word, Excel, CSV or text file.");
    }
    const stored = await this.files.store(t, {
      category: 'incident_attachment',
      sourceType: 'incident',
      sourceId: id,
      siteId: row.site_id,
      filename: file.originalname,
      contentType: file.mimetype,
      data: file.buffer,
      uploadedBy: user.id,
    });
    const s = tenantDb(this.db, t.schema);
    await s.insertInto('incident_events').values({ incident_id: id, kind: 'attachment', body: stored.filename, author_id: user.id }).execute();
    await s.updateTable('incidents').set({ updated_at: new Date().toISOString(), version: sql`version + 1` }).where('id', '=', id).execute();
    return stored;
  }

  /** The file, if it belongs to this incident. */
  async attachment(t: TenantContext, id: string, fileId: string) {
    this.assertEnabled(t);
    await this.load(t, id);
    const { row, data } = await this.files.readBytes(t, fileId);
    if (row.sourceType !== 'incident' || row.sourceId !== id) throw new NotFoundException('attachment not found');
    return { row, data };
  }
}
