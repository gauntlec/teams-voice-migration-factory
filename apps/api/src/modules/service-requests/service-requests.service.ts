import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { platformDb, tenantDb } from '@tvmf/db';
import {
  NUMBER_NEED_KEEP,
  NUMBER_NEED_NEW,
  SITE_MODE_LABELS,
  SR_CUSTOMER_NOTIFY_STATUSES,
  SR_NEW_NUMBER_KEY,
  SR_OPEN_STATUSES,
  SR_STATUS_LABELS,
  SR_TYPE_DEFS,
  canMoveSr,
  srDetailLines,
  srReference,
  type CreateServiceRequestInput,
  type ListServiceRequestsQuery,
  type ServiceRequestCommentInput,
  type ServiceRequestCreatedContext,
  type ServiceRequestStatusChangedContext,
  type ServiceRequestStatusInput,
  type SiteMode,
  type SrMenuOption,
  type SrStatus,
  type SrTarget,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import { APP_CONFIG, type AppConfig } from '../../common/config';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { MailService } from '../../mail/mail.service';
import { assertSiteInScope, isSiteScoped } from '../data-collection/site-scope';

/** When each status was reached. */
const REACHED_AT: Partial<Record<SrStatus, 'planned_at' | 'built_at' | 'deployed_at' | 'cancelled_at'>> = {
  planned: 'planned_at',
  built: 'built_at',
  deployed: 'deployed_at',
  cancelled: 'cancelled_at',
};

interface StaffMember {
  id: string;
  email: string;
  display_name: string;
  role: string;
}

/**
 * Managed Services: customers raise service requests, and the engineers and
 * admins on that customer action them (New -> Planned -> Designed & built ->
 * Deployed). Every endpoint needs Managed Services switched on for the customer.
 *
 * Visibility: everyone with sr:read on the customer sees its requests, except a
 * site contact, who only sees (and can only raise) requests for their own sites.
 * Internal comments are only shown to people who can manage requests.
 */
@Injectable()
export class ServiceRequestsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private assertEnabled(t: TenantContext) {
    if (!t.managedServices) throw new ForbiddenException('Managed Services is not switched on for this customer.');
  }

  private url(id?: string) {
    const base = `${this.cfg.WEB_ORIGIN.replace(/\/+$/, '')}/service-requests`;
    return id ? `${base}?id=${id}` : base;
  }

  private async names(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    if (unique.length === 0) return new Map<string, string>();
    const rows = await platformDb(this.db).selectFrom('users').select(['id', 'display_name']).where('id', 'in', unique).execute();
    return new Map(rows.map((r) => [r.id, r.display_name]));
  }

  /**
   * The people who action this customer's requests: its engineers (customer
   * members with the ENGINEER role) and every Super Admin. Used for the
   * assignee list and for the "new request" email.
   */
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
      p
        .selectFrom('users')
        .select(['id', 'email', 'display_name', 'role'])
        .where('role', '=', 'SUPER_ADMIN')
        .where('status', '=', 'active')
        .execute(),
    ]);
    const byId = new Map<string, StaffMember>();
    for (const u of [...engineers, ...admins]) byId.set(u.id, u);
    return [...byId.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  private async load(t: TenantContext, id: string) {
    const row = await tenantDb(this.db, t.schema).selectFrom('service_requests').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('service request not found');
    // A site contact sees only their own sites' requests; a request with no
    // site is customer-wide and outside their access.
    if (isSiteScoped(t)) assertSiteInScope(t, row.site_id);
    return row;
  }

  async list(t: TenantContext, q: ListServiceRequestsQuery) {
    this.assertEnabled(t);
    let query = tenantDb(this.db, t.schema)
      .selectFrom('service_requests as sr')
      .leftJoin('discovery_sites as ds', 'ds.id', 'sr.site_id')
      .select([
        'sr.id as id',
        'sr.number as number',
        'sr.type as type',
        'sr.title as title',
        'sr.priority as priority',
        'sr.status as status',
        'sr.site_id as site_id',
        'ds.sitecode as sitecode',
        'sr.requested_by as requested_by',
        'sr.assigned_to as assigned_to',
        'sr.target_date as target_date',
        'sr.created_at as created_at',
        'sr.updated_at as updated_at',
      ])
      .orderBy('sr.number', 'desc');
    if (q.status === 'open') query = query.where('sr.status', 'in', [...SR_OPEN_STATUSES]);
    else if (q.status !== 'all') query = query.where('sr.status', '=', q.status as SrStatus);
    if (q.type) query = query.where('sr.type', '=', q.type);
    if (isSiteScoped(t)) query = query.where('sr.site_id', 'in', t.siteScope);
    const rows = await query.execute();
    const names = await this.names(rows.flatMap((r) => [r.requested_by, r.assigned_to]));
    return rows.map((r) => ({
      ...r,
      reference: srReference(r.number),
      requested_by_name: names.get(r.requested_by) ?? null,
      assigned_to_name: r.assigned_to ? (names.get(r.assigned_to) ?? null) : null,
    }));
  }

  async get(t: TenantContext, id: string, canManage: boolean) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    const s = tenantDb(this.db, t.schema);
    const [site, events] = await Promise.all([
      row.site_id ? s.selectFrom('discovery_sites').select(['id', 'sitecode', 'name']).where('id', '=', row.site_id).executeTakeFirst() : null,
      s
        .selectFrom('service_request_events')
        .selectAll()
        .where('request_id', '=', id)
        .$if(!canManage, (qb) => qb.where('internal', '=', false))
        .orderBy('created_at')
        .execute(),
    ]);
    const names = await this.names([row.requested_by, row.assigned_to, ...events.map((e) => e.author_id)]);
    return {
      request: {
        ...row,
        reference: srReference(row.number),
        sitecode: site?.sitecode ?? null,
        site_name: site?.name ?? null,
        requested_by_name: names.get(row.requested_by) ?? null,
        assigned_to_name: row.assigned_to ? (names.get(row.assigned_to) ?? null) : null,
      },
      events: events.map((e) => ({ ...e, author_name: names.get(e.author_id) ?? null })),
    };
  }

  /* ------------------------------ sites ------------------------------ */

  /** Sites with their mode. A site contact only sees their own sites. */
  async sites(t: TenantContext) {
    this.assertEnabled(t);
    let q = tenantDb(this.db, t.schema)
      .selectFrom('discovery_sites')
      .select(['id', 'sitecode', 'name', 'mode', 'mode_changed_at', 'mode_changed_by'])
      .orderBy('sitecode');
    if (isSiteScoped(t)) q = q.where('id', 'in', t.siteScope);
    const rows = await q.execute();
    const names = await this.names(rows.map((r) => r.mode_changed_by));
    return rows.map((r) => ({ ...r, mode_changed_by_name: r.mode_changed_by ? (names.get(r.mode_changed_by) ?? null) : null }));
  }

  /** Engineers and admins move a site between project and operations mode. */
  async setSiteMode(t: TenantContext, user: AuthedUser, siteId: string, mode: SiteMode) {
    this.assertEnabled(t);
    const row = await tenantDb(this.db, t.schema)
      .updateTable('discovery_sites')
      .set({ mode, mode_changed_at: new Date().toISOString(), mode_changed_by: user.id })
      .where('id', '=', siteId)
      .returning(['id', 'sitecode', 'name', 'mode', 'mode_changed_at'])
      .executeTakeFirst();
    if (!row) throw new NotFoundException('site not found');
    await this.audit.tenant(t.schema, 'site.mode_changed', {
      actor: { id: user.id, email: user.email },
      targetType: 'discovery_site',
      targetId: siteId,
      detail: { sitecode: row.sitecode, mode },
    });
    return row;
  }

  private async loadSite(t: TenantContext, siteId: string) {
    const site = await tenantDb(this.db, t.schema)
      .selectFrom('discovery_sites')
      .select(['id', 'sitecode', 'name', 'mode'])
      .where('id', '=', siteId)
      .executeTakeFirst();
    if (!site) throw new BadRequestException('That site does not exist for this customer.');
    if (isSiteScoped(t)) assertSiteInScope(t, siteId);
    return site;
  }

  /* ----------------------------- form data ----------------------------- */

  /** Numbers already promised to an open request, so two requests never take the same free number. */
  private async claimedNumbers(s: ReturnType<typeof tenantDb>) {
    const rows = await s
      .selectFrom('service_requests')
      .select(sql<string>`details->>${SR_NEW_NUMBER_KEY}`.as('n'))
      .where('status', 'in', [...SR_OPEN_STATUSES])
      .where(sql<boolean>`details ? ${SR_NEW_NUMBER_KEY}`)
      .execute();
    return new Set(rows.map((r) => r.n).filter(Boolean));
  }

  /**
   * What the request form offers for a site: its free numbers (first one is
   * picked automatically), all its numbers, its ranges, call queues and auto
   * attendants, and the phone models already in use.
   */
  async options(t: TenantContext, siteId: string | undefined) {
    this.assertEnabled(t);
    const s = tenantDb(this.db, t.schema);
    const deviceModels = await s
      .selectFrom('discovery_caps')
      .select('device_model as m')
      .where('device_model', 'is not', null)
      .union(s.selectFrom('build_caps').select('phone_model as m').where('phone_model', 'is not', null))
      .execute();
    const models = [...new Set(deviceModels.map((r) => (r.m ?? '').trim()).filter(Boolean))].sort();
    if (!siteId) return { deviceModels: models, availableNumbers: [], siteNumbers: [], ranges: [], callQueues: [], autoAttendants: [] };

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId)) throw new BadRequestException('Unknown site.');
    const site = await this.loadSite(t, siteId);
    const [claimed, numbers, ranges, callQueues, autoAttendants] = await Promise.all([
      this.claimedNumbers(s),
      s
        .selectFrom('phone_numbers as pn')
        .innerJoin('discovery_number_ranges as r', 'r.id', 'pn.range_id')
        .select(['pn.e164 as e164', 'pn.status as status'])
        .where('r.sitecode', '=', site.sitecode)
        .orderBy('pn.e164')
        .limit(2000)
        .execute(),
      s.selectFrom('discovery_number_ranges').select(['id', 'range_start', 'range_end', 'carrier']).where('sitecode', '=', site.sitecode).orderBy('range_start').execute(),
      s.selectFrom('build_call_queues').select(['id', 'name']).where('site_id', '=', site.id).orderBy('name').execute(),
      s.selectFrom('build_auto_attendants').select(['id', 'name']).where('site_id', '=', site.id).orderBy('name').execute(),
    ]);
    const unclaimed = numbers.filter((n) => !claimed.has(n.e164));
    return {
      deviceModels: models,
      availableNumbers: unclaimed.filter((n) => n.status === 'available').map((n) => n.e164),
      siteNumbers: unclaimed.map((n) => n.e164),
      ranges: ranges.map((r) => ({ id: r.id, label: `${r.range_start} – ${r.range_end}${r.carrier ? ` (${r.carrier})` : ''}` })),
      callQueues,
      autoAttendants,
    };
  }

  /** The customer's directory: synced users, then Data Collection users not yet synced. */
  async people(t: TenantContext, q: string) {
    this.assertEnabled(t);
    const term = q.trim();
    if (term.length < 2) return [];
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const s = tenantDb(this.db, t.schema);
    const [live, collected] = await Promise.all([
      s
        .selectFrom('tenant_users')
        .select(['upn', 'display_name'])
        .where((eb) => eb.or([eb('upn', 'ilike', like), eb('display_name', 'ilike', like)]))
        .where((eb) => eb.or([eb('account_enabled', 'is', null), eb('account_enabled', '=', true)]))
        .orderBy('display_name')
        .limit(20)
        .execute(),
      s
        .selectFrom('discovery_users')
        .select(['upn', 'display_name'])
        .where((eb) => eb.or([eb('upn', 'ilike', like), eb('display_name', 'ilike', like)]))
        .orderBy('display_name')
        .limit(20)
        .execute(),
    ]);
    const seen = new Set<string>();
    const out: { upn: string; name: string; synced: boolean }[] = [];
    for (const [rows, synced] of [[live, true], [collected, false]] as const) {
      for (const r of rows) {
        const key = r.upn.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ upn: r.upn, name: r.display_name || r.upn, synced });
      }
    }
    return out.slice(0, 25);
  }

  /* ------------------------------ requests ------------------------------ */

  async create(t: TenantContext, user: AuthedUser, input: CreateServiceRequestInput) {
    this.assertEnabled(t);
    const def = SR_TYPE_DEFS[input.type];
    // A new site has no site yet, whatever the form sent.
    const siteId = def.needsSite || input.type === 'other' ? (input.siteId ?? null) : null;
    const site = siteId ? await this.loadSite(t, siteId) : undefined;
    if (site && site.mode !== 'operations') {
      throw new BadRequestException(
        `${site.sitecode} is still in ${SITE_MODE_LABELS[site.mode].toLowerCase()} mode. Service requests open for a site once it moves to operations.`,
      );
    }
    if (isSiteScoped(t) && !siteId) {
      throw new ForbiddenException('You can only raise requests for your own sites. Ask your main contact to request a new site.');
    }
    const details = input.details;

    const row = await this.db.transaction().execute(async (trx) => {
      const s = tenantDb(trx, t.schema);
      // Serialise requests that take a free number, so two can't take the same one.
      if (details[SR_NEW_NUMBER_KEY]) await sql`select pg_advisory_xact_lock(hashtext(${t.schema} || ':sr_number'))`.execute(trx);
      await this.checkAgainstData(s, input.type, details, site);
      const created = await s
        .insertInto('service_requests')
        .values({
          type: input.type,
          title: input.title,
          site_id: siteId,
          details,
          priority: input.priority,
          target_date: input.targetDate ?? null,
          requested_by: user.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await s.insertInto('service_request_events').values({ request_id: created.id, kind: 'created', to_status: 'new', author_id: user.id }).execute();
      return created;
    });

    const reference = srReference(row.number);
    await this.audit.tenant(t.schema, 'service_request.created', {
      actor: { id: user.id, email: user.email },
      targetType: 'service_request',
      targetId: row.id,
      detail: { reference, type: row.type },
    });

    const context: ServiceRequestCreatedContext = {
      customerName: t.name,
      reference,
      title: row.title,
      typeLabel: def.label,
      siteLabel: site ? (site.name ? `${site.sitecode} — ${site.name}` : site.sitecode) : null,
      priority: row.priority,
      requestedBy: user.displayName,
      lines: srDetailLines(row.type, details),
      runUrl: this.url(row.id),
    };
    const recipients = (await this.staff(t)).filter((m) => m.id !== user.id);
    for (const m of recipients) {
      await this.mail.enqueue({
        template: 'service_request_created',
        to: { email: m.email, name: m.display_name },
        context: context as unknown as Record<string, unknown>,
        related: { type: 'service_request', id: row.id },
        createdBy: user.id,
        tenantId: t.id,
      });
    }
    return { ...row, reference };
  }

  /**
   * The form only offers real data, but the API is checked too: the new number
   * must be free at the site and not promised to another open request, a number
   * to keep must belong to the site, a new site code must be unused, and any
   * queue or auto attendant chosen must exist at the site.
   */
  private async checkAgainstData(
    s: ReturnType<typeof tenantDb>,
    type: CreateServiceRequestInput['type'],
    details: Record<string, unknown>,
    site: { id: string; sitecode: string } | undefined,
  ) {
    const siteNumber = async (e164: string) =>
      s
        .selectFrom('phone_numbers as pn')
        .innerJoin('discovery_number_ranges as r', 'r.id', 'pn.range_id')
        .select(['pn.status as status'])
        .where('pn.e164', '=', e164)
        .where('r.sitecode', '=', site?.sitecode ?? '')
        .executeTakeFirst();

    if (details.number === NUMBER_NEED_NEW && typeof details[SR_NEW_NUMBER_KEY] === 'string') {
      const e164 = details[SR_NEW_NUMBER_KEY] as string;
      const n = await siteNumber(e164);
      if (!n || n.status !== 'available') throw new BadRequestException(`${e164} isn't a free number at this site. Choose another.`);
      if ((await this.claimedNumbers(s)).has(e164)) throw new ConflictException(`${e164} has just been taken by another request. Choose another.`);
    }
    if (details.number === NUMBER_NEED_KEEP && typeof details.existing_number === 'string') {
      if (!(await siteNumber(details.existing_number))) throw new BadRequestException(`${details.existing_number} isn't one of this site's numbers.`);
    }
    if (type === 'new_site' && typeof details.sitecode === 'string') {
      const clash = await s.selectFrom('discovery_sites').select('id').where(sql<boolean>`lower(sitecode) = lower(${details.sitecode})`).executeTakeFirst();
      if (clash) throw new BadRequestException(`There is already a site with code ${details.sitecode}.`);
    }
    const targets: SrTarget[] = [];
    for (const key of ['unanswered', 'after_hours']) if (details[key]) targets.push(details[key] as SrTarget);
    if (Array.isArray(details.menu)) for (const o of details.menu as SrMenuOption[]) targets.push(o.target);
    for (const target of targets) {
      if (target.kind !== 'call_queue' && target.kind !== 'auto_attendant') continue;
      const table = target.kind === 'call_queue' ? 'build_call_queues' : 'build_auto_attendants';
      const hit = await s.selectFrom(table).select('id').where('id', '=', target.id!).where('site_id', '=', site?.id ?? '').executeTakeFirst();
      if (!hit) throw new BadRequestException(`${target.label} isn't a ${target.kind === 'call_queue' ? 'call queue' : 'auto attendant'} at this site.`);
    }
  }

  /**
   * Moves a request one step on (or cancels it). Only people who can manage
   * requests move them; the person who raised one may cancel it while it is
   * still New. The customer is emailed at Planned, Built, Deployed and Cancelled.
   */
  async move(t: TenantContext, user: AuthedUser, id: string, input: ServiceRequestStatusInput, canManage: boolean) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    const from = row.status;
    const to = input.to;
    if (!canManage) {
      const ownCancel = to === 'cancelled' && from === 'new' && row.requested_by === user.id;
      if (!ownCancel) throw new ForbiddenException('Only the engineers on this customer can move a request on. You can cancel your own request while it is still New.');
    }
    if (!canMoveSr(from, to)) {
      throw new BadRequestException(`A ${SR_STATUS_LABELS[from]} request can't be moved to ${SR_STATUS_LABELS[to]}.`);
    }
    const now = new Date().toISOString();
    const reachedAt = REACHED_AT[to];
    const updated = await tenantDb(this.db, t.schema)
      .updateTable('service_requests')
      .set({ status: to, updated_at: now, ...(reachedAt ? { [reachedAt]: now } : {}) })
      .where('id', '=', id)
      .where('status', '=', from) // someone else moving it at the same moment loses, not both
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new ConflictException('This request was just updated by someone else. Refresh and try again.');

    await tenantDb(this.db, t.schema)
      .insertInto('service_request_events')
      .values({ request_id: id, kind: 'status_changed', from_status: from, to_status: to, body: input.note || null, author_id: user.id })
      .execute();
    const reference = srReference(row.number);
    await this.audit.tenant(t.schema, 'service_request.status_changed', {
      actor: { id: user.id, email: user.email },
      targetType: 'service_request',
      targetId: id,
      detail: { reference, from, to },
    });

    if (SR_CUSTOMER_NOTIFY_STATUSES.includes(to) && row.requested_by !== user.id) {
      const requester = await platformDb(this.db)
        .selectFrom('users')
        .select(['email', 'display_name', 'status'])
        .where('id', '=', row.requested_by)
        .executeTakeFirst();
      if (requester && requester.status === 'active') {
        const context: ServiceRequestStatusChangedContext = {
          customerName: t.name,
          reference,
          title: row.title,
          typeLabel: SR_TYPE_DEFS[row.type].label,
          fromStatus: from,
          toStatus: to,
          note: input.note || null,
          runUrl: this.url(id),
        };
        await this.mail.enqueue({
          template: 'service_request_status_changed',
          to: { email: requester.email, name: requester.display_name },
          context: context as unknown as Record<string, unknown>,
          related: { type: 'service_request', id },
          createdBy: user.id,
          tenantId: t.id,
        });
      }
    }
    return { ...updated, reference };
  }

  async assign(t: TenantContext, user: AuthedUser, id: string, assigneeId: string | null) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    let assigneeName = 'Unassigned';
    if (assigneeId) {
      const member = (await this.staff(t)).find((m) => m.id === assigneeId);
      if (!member) throw new BadRequestException('Requests can only be assigned to an engineer on this customer, or a Super Admin.');
      assigneeName = member.display_name;
    }
    const s = tenantDb(this.db, t.schema);
    const updated = await s
      .updateTable('service_requests')
      .set({ assigned_to: assigneeId, updated_at: new Date().toISOString() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await s.insertInto('service_request_events').values({ request_id: id, kind: 'assigned', body: assigneeName, author_id: user.id }).execute();
    await this.audit.tenant(t.schema, 'service_request.assigned', {
      actor: { id: user.id, email: user.email },
      targetType: 'service_request',
      targetId: id,
      detail: { reference: srReference(row.number), assigneeId },
    });
    return { ...updated, reference: srReference(row.number) };
  }

  async comment(t: TenantContext, user: AuthedUser, id: string, input: ServiceRequestCommentInput, canManage: boolean) {
    this.assertEnabled(t);
    await this.load(t, id);
    if (input.internal && !canManage) throw new ForbiddenException('Only engineers and admins can add internal notes.');
    const event = await tenantDb(this.db, t.schema)
      .insertInto('service_request_events')
      .values({ request_id: id, kind: 'comment', body: input.body, internal: !!input.internal, author_id: user.id })
      .returningAll()
      .executeTakeFirstOrThrow();
    await tenantDb(this.db, t.schema).updateTable('service_requests').set({ updated_at: new Date().toISOString() }).where('id', '=', id).execute();
    return event;
  }
}
