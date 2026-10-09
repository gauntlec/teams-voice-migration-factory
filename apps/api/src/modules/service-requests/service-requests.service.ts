import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { platformDb, tenantDb } from '@tvmf/db';
import type { ZodType, ZodTypeDef } from 'zod';
import {
  NUMBER_NEED_KEEP,
  NUMBER_NEED_NEW,
  SITE_MODE_LABELS,
  SR_BUILD_DRAFT_STATUSES,
  SR_BUILD_KIND,
  SR_BUILD_KIND_LABELS,
  SR_ITEM_SHEET,
  SR_CUSTOMER_NOTIFY_STATUSES,
  SR_NEW_NUMBER_KEY,
  SR_OPEN_STATUSES,
  SR_STATUS_LABELS,
  SR_TYPE_DEFS,
  SR_TYPES,
  SR_PRIORITIES,
  srEffectiveTargets,
  srNextClock,
  srSla,
  type ServiceRequestSettingsInput,
  type SrSettings,
  buildAutoAttendantCreateSchema,
  buildAutoAttendantPatchSchema,
  buildCallQueuePatchSchema,
  buildCapPatchSchema,
  buildIdentityPatchSchema,
  isSrChangeType,
  srChangePlan,
  type AutoAttendantCallFlow,
  type AutoAttendantHolidayCallFlow,
  type SrSiteObject,
  buildCallQueueCreateSchema,
  buildCapCreateSchema,
  buildIdentityCreateSchema,
  can,
  canDraftSrInBuild,
  SR_NOTE_REQUIRED,
  SR_REOPEN_DAYS,
  srCanReopen,
  srMoveKind,
  srBuiltBlockers,
  srDesignEditable,
  srHasDesign,
  srItemSheets,
  discoverySiteSchema,
  srAgentEntries,
  srBuildHref,
  srDetailLines,
  srReference,
  srToBuildDraft,
  suggestCapUpn,
  type CreateServiceRequestInput,
  type ServiceRequestBuildDraftInput,
  type SrBuildDraft,
  type SrBuildDraftResult,
  type SrBuildLink,
  type ServiceRequestDeployInput,
  type SrDeploymentRun,
  type SrDesignSummary,
  type SrItem,
  type SrItemKind,
  type ListServiceRequestsQuery,
  type ServiceRequestCommentInput,
  type ServiceRequestCreatedContext,
  type ServiceRequestStatusChangedContext,
  type ServiceRequestActivityContext,
  type ServiceRequestMessageContext,
  type SrType,
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
import { BuildService } from '../build/build.service';
import { DataCollectionService } from '../data-collection/data-collection.service';
import { DeploymentService } from '../deployment/deployment.service';
import { assertSiteInScope, isSiteScoped } from '../data-collection/site-scope';

/** When each status was reached. */
const REACHED_AT: Partial<Record<SrStatus, 'planned_at' | 'built_at' | 'deployed_at' | 'cancelled_at' | 'declined_at'>> = {
  planned: 'planned_at',
  built: 'built_at',
  deployed: 'deployed_at',
  cancelled: 'cancelled_at',
  declined: 'declined_at',
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
    private readonly build: BuildService,
    private readonly dataCollection: DataCollectionService,
    private readonly deployment: DeploymentService,
  ) {}

  private assertEnabled(t: TenantContext) {
    if (!t.managedServices) throw new ForbiddenException('Managed Services is not switched on for this customer.');
  }

  private url(id?: string) {
    const base = `${this.cfg.WEB_ORIGIN.replace(/\/+$/, '')}/service-requests`;
    return id ? `${base}/${id}` : base;
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
        'sr.waiting_since as waiting_since',
        'sr.waiting_seconds as waiting_seconds',
        'sr.first_response_at as first_response_at',
        'sr.deployed_at as deployed_at',
        'sr.declined_at as declined_at',
        'sr.cancelled_at as cancelled_at',
        'sr.reopened_at as reopened_at',
      ])
      .orderBy('sr.number', 'desc');
    if (q.status === 'open') query = query.where('sr.status', 'in', [...SR_OPEN_STATUSES]);
    else if (q.status !== 'all') query = query.where('sr.status', '=', q.status as SrStatus);
    if (q.type) query = query.where('sr.type', '=', q.type);
    if (isSiteScoped(t)) query = query.where('sr.site_id', 'in', t.siteScope);
    const rows = await query.execute();
    const names = await this.names(rows.flatMap((r) => [r.requested_by, r.assigned_to]));
    const targets = srEffectiveTargets(await this.settingsRaw(t));
    const now = Date.now();
    return rows.map((r) => ({
      ...r,
      // The target that matters now (response, then resolution) - see service-request-sla.ts.
      sla: srNextClock(srSla(r, targets, now)),
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
    // Staff only: whether "Create in Design & Build" applies, and a suggested
    // UPN for a common area phone (the customer isn't asked for one).
    const buildKind = SR_BUILD_KIND[row.type];
    const build = canManage
      ? {
          kind: buildKind,
          canDraft: canDraftSrInBuild(row.type, row.status),
          suggestedCapUpn:
            buildKind === 'cap' ? suggestCapUpn(String((row.details as Record<string, unknown>).display_name ?? ''), await this.mainDomain(t)) : null,
        }
      : null;
    const targets = srEffectiveTargets(await this.settingsRaw(t));
    return {
      build,
      sla: { ...srSla(row, targets), target: targets[row.priority] },
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

  /* ------------------------------ settings ------------------------------ */

  /** The customer's stored Managed Services settings (empty = defaults). */
  private async settingsRaw(t: TenantContext): Promise<SrSettings> {
    const row = await platformDb(this.db).selectFrom('tenants').select('sr_settings').where('id', '=', t.id).executeTakeFirst();
    return (row?.sr_settings ?? {}) as SrSettings;
  }

  /**
   * Targets (with defaults filled in), approvals and the change window.
   * Everyone on the customer can see them; approver ids come with names.
   */
  async settings(t: TenantContext) {
    this.assertEnabled(t);
    const raw = await this.settingsRaw(t);
    const approverIds = raw.approval?.approverIds ?? [];
    const names = await this.names(approverIds);
    return {
      targets: srEffectiveTargets(raw),
      customTargets: SR_PRIORITIES.filter((p) => !!raw.targets?.[p]),
      approval: {
        types: raw.approval?.types ?? [],
        approvers: approverIds.map((id) => ({ id, display_name: names.get(id) ?? 'Unknown user' })),
      },
      changeWindow: raw.changeWindow ?? null,
    };
  }

  /** Active customer users on this customer - who can be made an approver. */
  async customerUsers(t: TenantContext) {
    this.assertEnabled(t);
    return platformDb(this.db)
      .selectFrom('users as u')
      .innerJoin('tenant_memberships as m', 'm.user_id', 'u.id')
      .select(['u.id as id', 'u.display_name as display_name', 'u.email as email'])
      .where('m.tenant_id', '=', t.id)
      .where('u.role', '=', 'CUSTOMER')
      .where('u.status', '=', 'active')
      .orderBy('u.display_name')
      .execute();
  }

  /**
   * Changes the settings - Super Admins only (targets and approvals are part
   * of the customer's contract). Approvers must be active customer users on
   * this customer.
   */
  async updateSettings(t: TenantContext, user: AuthedUser, input: ServiceRequestSettingsInput) {
    this.assertEnabled(t);
    if (user.role !== 'SUPER_ADMIN') throw new ForbiddenException('Only a Super Admin can change Managed Services settings.');
    const current = await this.settingsRaw(t);
    const next: SrSettings = { ...current };
    if (input.targets !== undefined) next.targets = input.targets;
    if (input.changeWindow !== undefined) next.changeWindow = input.changeWindow;
    if (input.approval !== undefined) {
      const ids = [...new Set(input.approval.approverIds)];
      if (ids.length) {
        const ok = await platformDb(this.db)
          .selectFrom('users as u')
          .innerJoin('tenant_memberships as m', 'm.user_id', 'u.id')
          .select('u.id')
          .where('m.tenant_id', '=', t.id)
          .where('u.role', '=', 'CUSTOMER')
          .where('u.status', '=', 'active')
          .where('u.id', 'in', ids)
          .execute();
        if (ok.length !== ids.length) throw new BadRequestException("Approvers must be active customer users on this customer.");
      }
      next.approval = { types: [...new Set(input.approval.types)], approverIds: ids };
    }
    await platformDb(this.db).updateTable('tenants').set({ sr_settings: JSON.stringify(next) }).where('id', '=', t.id).execute();
    await this.audit.tenant(t.schema, 'service_request.settings_changed', {
      actor: { id: user.id, email: user.email },
      targetType: 'tenant',
      targetId: t.id,
      detail: next as unknown as Record<string, unknown>,
    });
    return this.settings(t);
  }

  /* ------------------------------ reporting ------------------------------ */

  /**
   * Requests raised in [from, to): counts by type and status, how many were
   * finished, median time to deploy (raised -> deployed, less waiting on the
   * customer), the share that met each target, and today's open backlog by
   * age. A site contact only counts their own sites.
   */
  async report(t: TenantContext, from: string, to: string) {
    this.assertEnabled(t);
    const start = new Date(from);
    const end = new Date(to);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new BadRequestException('Choose a valid date range.');
    const s = tenantDb(this.db, t.schema);
    let q = s
      .selectFrom('service_requests')
      .select(['id', 'type', 'status', 'priority', 'created_at', 'first_response_at', 'deployed_at', 'declined_at', 'cancelled_at', 'waiting_since', 'waiting_seconds', 'reopened_at', 'site_id'])
      .where('created_at', '>=', start.toISOString())
      .where('created_at', '<', end.toISOString());
    if (isSiteScoped(t)) q = q.where('site_id', 'in', t.siteScope);
    const rows = await q.execute();
    const targets = srEffectiveTargets(await this.settingsRaw(t));

    const byType = Object.fromEntries(SR_TYPES.map((k) => [k, 0])) as Record<string, number>;
    const byStatus: Record<string, number> = {};
    const deployHours: number[] = [];
    let responseMet = 0;
    let responseDone = 0;
    let resolutionMet = 0;
    let resolutionDone = 0;
    for (const r of rows) {
      byType[r.type] = (byType[r.type] ?? 0) + 1;
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      const sla = srSla(r, targets);
      if (sla.response.state === 'met' || sla.response.state === 'missed') {
        responseDone++;
        if (sla.response.state === 'met') responseMet++;
      }
      if (sla.resolution.state === 'met' || sla.resolution.state === 'missed') {
        resolutionDone++;
        if (sla.resolution.state === 'met') resolutionMet++;
      }
      if (r.status === 'deployed' && r.deployed_at) {
        const h = (new Date(r.deployed_at).getTime() - new Date(r.created_at).getTime() - r.waiting_seconds * 1000) / 3_600_000;
        deployHours.push(Math.max(0, h));
      }
    }
    deployHours.sort((a, b) => a - b);
    const median = deployHours.length
      ? deployHours.length % 2
        ? deployHours[(deployHours.length - 1) / 2]!
        : (deployHours[deployHours.length / 2 - 1]! + deployHours[deployHours.length / 2]!) / 2
      : null;

    // Today's open backlog, by age.
    let openQ = s.selectFrom('service_requests').select(['created_at']).where('status', 'in', [...SR_OPEN_STATUSES]);
    if (isSiteScoped(t)) openQ = openQ.where('site_id', 'in', t.siteScope);
    const open = await openQ.execute();
    const age = { under1d: 0, d1to3: 0, d3to7: 0, over7d: 0 };
    for (const o of open) {
      const days = (Date.now() - new Date(o.created_at).getTime()) / 86_400_000;
      if (days < 1) age.under1d++;
      else if (days < 3) age.d1to3++;
      else if (days < 7) age.d3to7++;
      else age.over7d++;
    }

    return {
      from: start.toISOString(),
      to: end.toISOString(),
      raised: rows.length,
      deployed: byStatus.deployed ?? 0,
      byType,
      byStatus,
      medianHoursToDeploy: median === null ? null : Math.round(median * 10) / 10,
      responseMetPct: responseDone ? Math.round((responseMet / responseDone) * 100) : null,
      resolutionMetPct: resolutionDone ? Math.round((resolutionMet / resolutionDone) * 100) : null,
      responseMeasured: responseDone,
      resolutionMeasured: resolutionDone,
      openBacklog: { total: open.length, ...age },
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
    if (!siteId) return { deviceModels: models, availableNumbers: [], siteNumbers: [], ranges: [], callQueues: [], autoAttendants: [], caps: [] };

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId)) throw new BadRequestException('Unknown site.');
    const site = await this.loadSite(t, siteId);
    const [claimed, numbers, ranges, callQueues, autoAttendants, caps] = await Promise.all([
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
      s.selectFrom('build_caps').select(['id', 'upn', 'display_name']).where('site_id', '=', site.id).where('hidden', '=', false).orderBy('upn').execute(),
    ]);
    const unclaimed = numbers.filter((n) => !claimed.has(n.e164));
    return {
      deviceModels: models,
      availableNumbers: unclaimed.filter((n) => n.status === 'available').map((n) => n.e164),
      siteNumbers: unclaimed.map((n) => n.e164),
      ranges: ranges.map((r) => ({ id: r.id, label: `${r.range_start} – ${r.range_end}${r.carrier ? ` (${r.carrier})` : ''}` })),
      callQueues,
      autoAttendants,
      caps: caps.map((c) => ({ id: c.id, name: c.display_name ? `${c.display_name} (${c.upn})` : c.upn })),
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

    // Any type with a picked new number (new user/phone/queue/AA, or a change of number).
    if (typeof details[SR_NEW_NUMBER_KEY] === 'string') {
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
    // A queue / auto attendant / common area phone picked to change or remove must be at the site.
    for (const f of SR_TYPE_DEFS[type].fields) {
      if (f.kind !== 'site_object' || !details[f.key]) continue;
      const picked = details[f.key] as SrSiteObject;
      const table = f.objectKind === 'call_queue' ? 'build_call_queues' : f.objectKind === 'auto_attendant' ? 'build_auto_attendants' : 'build_caps';
      const hit = await s.selectFrom(table).select('id').where('id', '=', picked.id).where('site_id', '=', site?.id ?? '').executeTakeFirst();
      if (!hit) throw new BadRequestException(`${picked.label} isn't at this site.`);
    }
    const targets: SrTarget[] = [];
    for (const key of ['unanswered', 'after_hours', 'forward_to']) if (details[key]) targets.push(details[key] as SrTarget);
    if (Array.isArray(details.menu)) for (const o of details.menu as SrMenuOption[]) targets.push(o.target);
    for (const target of targets) {
      if (target.kind !== 'call_queue' && target.kind !== 'auto_attendant') continue;
      const table = target.kind === 'call_queue' ? 'build_call_queues' : 'build_auto_attendants';
      const hit = await s.selectFrom(table).select('id').where('id', '=', target.id!).where('site_id', '=', site?.id ?? '').executeTakeFirst();
      if (!hit) throw new BadRequestException(`${target.label} isn't a ${target.kind === 'call_queue' ? 'call queue' : 'auto attendant'} at this site.`);
    }
  }

  /* ------------------------------ notifications ------------------------------ */

  /** The fields every service request email starts with. */
  private emailBase(t: TenantContext, row: { id: string; number: number; title: string; type: SrType }) {
    return { customerName: t.name, reference: srReference(row.number), title: row.title, typeLabel: SR_TYPE_DEFS[row.type].label, runUrl: this.url(row.id) };
  }

  /** Emails the person who raised the request - unless they did this themselves, or their account is no longer active. */
  private async emailRequester(
    t: TenantContext,
    row: { id: string; requested_by: string },
    authorId: string,
    template: 'service_request_status_changed' | 'service_request_message',
    context: ServiceRequestStatusChangedContext | ServiceRequestMessageContext,
  ) {
    if (row.requested_by === authorId) return;
    const requester = await platformDb(this.db)
      .selectFrom('users')
      .select(['email', 'display_name', 'status'])
      .where('id', '=', row.requested_by)
      .executeTakeFirst();
    if (!requester || requester.status !== 'active') return;
    await this.mail.enqueue({
      template,
      to: { email: requester.email, name: requester.display_name },
      context: context as unknown as Record<string, unknown>,
      related: { type: 'service_request', id: row.id },
      createdBy: authorId,
      tenantId: t.id,
    });
  }

  /**
   * Emails the team about a request: its assignee, or - when nobody is
   * assigned - every engineer and Super Admin on the customer. Never the
   * person who caused it.
   */
  private async emailTeam(
    t: TenantContext,
    row: { id: string; number: number; title: string; type: SrType; assigned_to: string | null },
    kind: ServiceRequestActivityContext['kind'],
    author: { id: string; displayName: string } | null,
    body: string | null,
    opts: { assigneeOnly?: boolean } = {},
  ) {
    const staff = await this.staff(t);
    const assignee = row.assigned_to ? staff.find((m) => m.id === row.assigned_to) : undefined;
    const to = assignee ? [assignee] : opts.assigneeOnly ? [] : staff;
    const context: ServiceRequestActivityContext = { ...this.emailBase(t, row), kind, author: author?.displayName ?? null, body };
    for (const m of to) {
      if (author && m.id === author.id) continue;
      await this.mail.enqueue({
        template: 'service_request_activity',
        to: { email: m.email, name: m.display_name },
        context: context as unknown as Record<string, unknown>,
        related: { type: 'service_request', id: row.id },
        createdBy: author?.id ?? null,
        tenantId: t.id,
      });
    }
  }

  /** Stops the "waiting on customer" clock, adding the time to waiting_seconds. Returns the columns to set. */
  private stopWaiting(row: { waiting_since: string | null; waiting_seconds: number }, now: string) {
    if (!row.waiting_since) return {};
    const waited = Math.max(0, Math.round((new Date(now).getTime() - new Date(row.waiting_since).getTime()) / 1000));
    return { waiting_since: null, waiting_seconds: row.waiting_seconds + waited, waiting_reminded_at: null, waiting_reminders: 0 };
  }

  /* ------------------------------ workflow ------------------------------ */

  /**
   * Moves a request (see srMoveKind). Engineers and admins can make every
   * move; the person who raised it can cancel it while it is New, and reopen
   * it within SR_REOPEN_DAYS of it being deployed. Declining, sending back
   * and reopening need a reason. Any move ends "waiting on customer".
   */
  async move(t: TenantContext, user: AuthedUser, id: string, input: ServiceRequestStatusInput, canManage: boolean) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    const from = row.status;
    const to = input.to;
    const kind = srMoveKind(from, to);
    if (!kind) throw new BadRequestException(`A ${SR_STATUS_LABELS[from]} request can't be moved to ${SR_STATUS_LABELS[to]}.`);
    const own = row.requested_by === user.id;
    if (!canManage) {
      const allowed = (kind === 'cancel' && from === 'new' && own) || (kind === 'reopen' && own);
      if (!allowed) {
        throw new ForbiddenException(
          'Only the engineers on this customer can move a request on. You can cancel your own request while it is still New, or reopen it shortly after it was completed.',
        );
      }
    }
    if (kind === 'reopen' && !srCanReopen(from, row.deployed_at)) {
      throw new BadRequestException(`A request can only be reopened within ${SR_REOPEN_DAYS} days of being completed. Raise a new request instead.`);
    }
    const note = input.note?.trim() || null;
    if (SR_NOTE_REQUIRED.includes(kind) && !note) {
      throw new BadRequestException(kind === 'decline' ? 'Say why the request is being declined.' : kind === 'send_back' ? 'Say why it is being sent back.' : 'Say what is wrong.');
    }
    if (kind === 'forward' && to === 'built') {
      const blockers = (await this.design(t, id)).builtBlockers;
      if (blockers.length) throw new BadRequestException(`Not ready to mark as designed & built: ${blockers.join(' ')}`);
    }

    const now = new Date().toISOString();
    const reachedAt = REACHED_AT[to];
    const set: Record<string, unknown> = { status: to, updated_at: now, ...(reachedAt ? { [reachedAt]: now } : {}), ...this.stopWaiting(row, now) };
    if (kind === 'send_back') set.built_at = null;
    // A reopen restarts the resolution clock (and its emails).
    if (kind === 'reopen') {
      const notified = { ...((row.sla_notified ?? {}) as Record<string, string>) };
      delete notified.resolution_warning;
      delete notified.resolution_breached;
      Object.assign(set, { reopened_at: now, deployed_at: null, built_at: null, sla_notified: JSON.stringify(notified) });
    }
    if (canManage && !row.first_response_at) set.first_response_at = now;
    const updated = await tenantDb(this.db, t.schema)
      .updateTable('service_requests')
      .set(set)
      .where('id', '=', id)
      .where('status', '=', from) // someone else moving it at the same moment loses, not both
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new ConflictException('This request was just updated by someone else. Refresh and try again.');

    await tenantDb(this.db, t.schema)
      .insertInto('service_request_events')
      .values({ request_id: id, kind: 'status_changed', from_status: from, to_status: to, body: note, author_id: user.id })
      .execute();
    const reference = srReference(row.number);
    await this.audit.tenant(t.schema, 'service_request.status_changed', {
      actor: { id: user.id, email: user.email },
      targetType: 'service_request',
      targetId: id,
      detail: { reference, from, to, kind },
    });

    // The customer hears about every move except an internal send-back.
    if (kind !== 'send_back' && SR_CUSTOMER_NOTIFY_STATUSES.includes(to)) {
      const context: ServiceRequestStatusChangedContext = { ...this.emailBase(t, row), fromStatus: from, toStatus: to, moveKind: kind, note };
      await this.emailRequester(t, row, user.id, 'service_request_status_changed', context);
    }
    // The team hears when the customer acts.
    if (!canManage && (kind === 'reopen' || kind === 'cancel')) {
      await this.emailTeam(t, row, kind === 'reopen' ? 'reopened' : 'cancelled', user, note);
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
    // Tell the new assignee (not when you pick yourself).
    if (assigneeId && assigneeId !== user.id && assigneeId !== row.assigned_to) {
      await this.emailTeam(t, { ...row, assigned_to: assigneeId }, 'assigned', user, null, { assigneeOnly: true });
    }
    return { ...updated, reference: srReference(row.number) };
  }

  /**
   * A comment on the request.
   * - Team, public: emailed to the requester. With waitForReply, it's a
   *   question: the request is "waiting on customer" (the clock stops) until
   *   the customer replies, and they're reminded every few days.
   * - Team, internal: never shown to the customer; emailed to the assignee.
   * - Customer: emailed to the assignee (or the whole team); if the team was
   *   waiting on them, that ends the wait.
   */
  async comment(t: TenantContext, user: AuthedUser, id: string, input: ServiceRequestCommentInput, canManage: boolean) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    if (input.internal && !canManage) throw new ForbiddenException('Only engineers and admins can add internal notes.');
    if (input.waitForReply && (!canManage || input.internal)) throw new BadRequestException('Only a public comment from the team can wait for the customer.');
    if (input.waitForReply && !SR_OPEN_STATUSES.includes(row.status)) throw new BadRequestException('Only an open request can wait on the customer.');
    const s = tenantDb(this.db, t.schema);
    const now = new Date().toISOString();
    const question = !!input.waitForReply;
    const event = await s
      .insertInto('service_request_events')
      .values({ request_id: id, kind: question ? 'waiting' : 'comment', body: input.body, internal: !!input.internal, author_id: user.id })
      .returningAll()
      .executeTakeFirstOrThrow();

    const set: Record<string, unknown> = { updated_at: now };
    const publicFromTeam = canManage && !input.internal;
    if (publicFromTeam && !row.first_response_at) set.first_response_at = now;
    if (question && !row.waiting_since) Object.assign(set, { waiting_since: now, waiting_reminded_at: null, waiting_reminders: 0 });
    // The customer answering ends the wait.
    const replied = !canManage && !!row.waiting_since;
    if (replied) Object.assign(set, this.stopWaiting(row, now));
    await s.updateTable('service_requests').set(set).where('id', '=', id).execute();
    if (replied) {
      await s.insertInto('service_request_events').values({ request_id: id, kind: 'resumed', author_id: user.id }).execute();
    }

    if (publicFromTeam) {
      const context: ServiceRequestMessageContext = { ...this.emailBase(t, row), kind: question ? 'question' : 'comment', author: user.displayName, body: input.body };
      await this.emailRequester(t, row, user.id, 'service_request_message', context);
    } else if (input.internal) {
      await this.emailTeam(t, row, 'internal_note', user, input.body, { assigneeOnly: true });
    } else {
      await this.emailTeam(t, row, replied ? 'replied' : 'comment', user, input.body);
    }
    return event;
  }

  /** The team stops waiting on the customer without a reply (e.g. they answered by phone). */
  async stopWaitingOnCustomer(t: TenantContext, user: AuthedUser, id: string) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    if (!row.waiting_since) return { ok: true };
    const s = tenantDb(this.db, t.schema);
    const now = new Date().toISOString();
    await s.updateTable('service_requests').set({ ...this.stopWaiting(row, now), updated_at: now }).where('id', '=', id).execute();
    await s.insertInto('service_request_events').values({ request_id: id, kind: 'resumed', author_id: user.id }).execute();
    return { ok: true };
  }

  /* ----------------------- Create in Design & Build ----------------------- */

  /**
   * Creates the draft Design & Build row a request asks for (a user, common
   * area phone, call queue, auto attendant, or a new site) from the customer's
   * answers, so the engineer doesn't retype them. See service-request-build.ts
   * for which answer goes where.
   *
   * - Only while the request is New or Planned, and only for those types.
   * - Goes through the normal Design & Build (or site) create validation and
   *   create path, so the row is exactly what adding it by hand would give.
   * - Never overwrites: if a row with the same UPN / name / site code already
   *   exists anywhere on this customer it is reported, not touched.
   * - The phone number is left for the engineer, and the request's status is
   *   unchanged - the engineer still marks it Designed & built.
   * - Records a staff-only timeline entry linking to what was created.
   */
  async draftInBuild(t: TenantContext, user: AuthedUser, id: string, input: ServiceRequestBuildDraftInput): Promise<SrBuildDraftResult> {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    const kind = SR_BUILD_KIND[row.type];
    if (!kind) throw new BadRequestException(`A ${SR_TYPE_DEFS[row.type].label.toLowerCase()} request has nothing to create in Design & Build.`);
    if (!SR_BUILD_DRAFT_STATUSES.includes(row.status)) {
      throw new BadRequestException(`Rows can only be created while a request is New or Planned. This one is ${SR_STATUS_LABELS[row.status]}.`);
    }
    // sr:manage got the caller here; the row itself needs the matching right.
    if (!can(user.role, kind === 'site' ? 'discovery:sites:manage' : 'build:write')) {
      throw new ForbiddenException('You do not have permission to add this to Design & Build.');
    }

    if (isSrChangeType(row.type)) return this.applyChange(t, user, row);

    const reference = srReference(row.number);
    const details = row.details as Record<string, unknown>;
    const warnings: string[] = [];
    let agentUpns: string[] | undefined;
    if (kind === 'call_queue') {
      const { upns, names } = srAgentEntries(details);
      const found = await this.resolveAgentNames(t, names);
      agentUpns = [...new Set([...upns, ...found.upns])];
      for (const n of found.missing) warnings.push(`Couldn't find a single person called "${n}" in the directory - add them to the queue's agents by hand.`);
    }

    const mapping = srToBuildDraft(row.type, details, { reference, siteId: row.site_id, capUpn: input.capUpn, agentUpns });
    if (!mapping.ok) throw new BadRequestException(mapping.error);
    const draft = mapping.draft;

    const already = await this.findBuildRow(t, draft);
    if (already) {
      await this.linkItem(t, user, id, draft.kind, already.id);
      return { created: [], existing: [already.link], warnings };
    }

    let createdId: string;
    let siteId: string;
    try {
      ({ id: createdId, siteId } = await this.createBuildRow(t, user, draft));
    } catch (e) {
      // Someone added the same row a moment ago - report it like any other duplicate.
      if (e instanceof ConflictException) {
        const now = await this.findBuildRow(t, draft);
        if (now) {
          await this.linkItem(t, user, id, draft.kind, now.id);
          return { created: [], existing: [now.link], warnings };
        }
      }
      throw e;
    }
    await this.linkItem(t, user, id, draft.kind, createdId);
    const created: SrBuildLink[] = [{ kind, label: draft.label, href: srBuildHref(kind, siteId) }];

    const s = tenantDb(this.db, t.schema);
    const body = [
      `Created draft rows in Design & Build: ${created.map((c) => `${SR_BUILD_KIND_LABELS[c.kind]} ${c.label}`).join(', ')}.`,
      ...warnings,
    ].join('\n');
    await s
      .insertInto('service_request_events')
      .values({ request_id: id, kind: 'build_drafted', body, internal: true, links: JSON.stringify(created), author_id: user.id })
      .execute();
    await s.updateTable('service_requests').set({ updated_at: new Date().toISOString() }).where('id', '=', id).execute();
    await this.audit.tenant(t.schema, 'service_request.build_drafted', {
      actor: { id: user.id, email: user.email },
      targetType: 'service_request',
      targetId: id,
      detail: { reference, kind, rowId: createdId, key: draft.key },
    });
    return { created, existing: [], warnings };
  }

  /** Validates the draft with the same schema as adding it by hand, then creates it through the owning service. */
  private async createBuildRow(t: TenantContext, user: AuthedUser, draft: SrBuildDraft): Promise<{ id: string; siteId: string }> {
    const valid = <T>(schema: ZodType<T, ZodTypeDef, unknown>, v: unknown): T => {
      const r = schema.safeParse(v);
      if (r.success) return r.data;
      const why = r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
      throw new BadRequestException(`The request's answers can't be used as they are (${why}). Fix the request or add the row by hand.`);
    };
    switch (draft.kind) {
      case 'site': {
        const site = await this.dataCollection.insertSite(t, user, valid(discoverySiteSchema, draft.input));
        return { id: site.id, siteId: site.id };
      }
      case 'user': {
        const r = await this.build.createUser(t, user, valid(buildIdentityCreateSchema, draft.input));
        return { id: r.id, siteId: r.site_id };
      }
      case 'cap': {
        const r = await this.build.createCap(t, user, valid(buildCapCreateSchema, draft.input));
        return { id: r.id, siteId: r.site_id };
      }
      case 'call_queue': {
        const r = await this.build.createCallQueue(t, user, valid(buildCallQueueCreateSchema, draft.input));
        return { id: r.id, siteId: r.site_id };
      }
      case 'auto_attendant': {
        const r = await this.build.createAutoAttendant(t, user, valid(buildAutoAttendantCreateSchema, draft.input));
        return { id: r.id, siteId: r.site_id };
      }
    }
  }

  /**
   * An existing row with the draft's natural key, anywhere on this customer.
   * Case-insensitive: UPNs and site codes are, and deployment matches call
   * queues and auto attendants to Teams by lower-cased name tenant-wide.
   */
  private async findBuildRow(t: TenantContext, draft: SrBuildDraft): Promise<{ id: string; link: SrBuildLink } | null> {
    const s = tenantDb(this.db, t.schema);
    const key = draft.key.toLowerCase();
    let hit: { id: string; site_id: string } | undefined;
    switch (draft.kind) {
      case 'site':
        hit = await s
          .selectFrom('discovery_sites')
          .select(['id', 'id as site_id'])
          .where(sql<string>`lower(sitecode)`, '=', key)
          .executeTakeFirst();
        break;
      case 'user':
      case 'cap':
        hit = await s
          .selectFrom(draft.kind === 'user' ? 'build_users' : 'build_caps')
          .select(['id', 'site_id'])
          .where(sql<string>`lower(upn)`, '=', key)
          .executeTakeFirst();
        break;
      case 'call_queue':
      case 'auto_attendant':
        hit = await s
          .selectFrom(draft.kind === 'call_queue' ? 'build_call_queues' : 'build_auto_attendants')
          .select(['id', 'site_id'])
          .where(sql<string>`lower(name)`, '=', key)
          .executeTakeFirst();
        break;
    }
    return hit ? { id: hit.id, link: { kind: draft.kind, label: draft.label, href: srBuildHref(draft.kind, hit.site_id) } } : null;
  }

  /* --------------------------- design and deploy --------------------------- */

  /** Links a row to the request (no-op if it already is). */
  private async linkItem(t: TenantContext, user: AuthedUser, requestId: string, kind: SrItemKind, rowId: string) {
    await tenantDb(this.db, t.schema)
      .insertInto('service_request_items')
      .values({ request_id: requestId, kind, row_id: rowId, created_by: user.id })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  /** The request's linked rows, with their current UPN / name (null once deleted from Design & Build). */
  private async items(t: TenantContext, requestId: string): Promise<SrItem[]> {
    const s = tenantDb(this.db, t.schema);
    const links = await s.selectFrom('service_request_items').selectAll().where('request_id', '=', requestId).orderBy('created_at').execute();
    const ids = (k: SrItemKind) => links.filter((l) => l.kind === k).map((l) => l.row_id);
    const found = new Map<string, { label: string; site_id: string }>();
    const add = (rows: { id: string; label: string | null; site_id: string }[]) => {
      for (const r of rows) found.set(r.id, { label: r.label ?? '', site_id: r.site_id });
    };
    const byUpn = async (table: 'build_users' | 'build_caps' | 'build_resource_accounts', k: SrItemKind) => {
      const list = ids(k);
      if (list.length) add(await s.selectFrom(table).select(['id', 'upn as label', 'site_id']).where('id', 'in', list).execute());
    };
    const byName = async (table: 'build_shared_calling_policies' | 'build_call_queues' | 'build_auto_attendants', k: SrItemKind) => {
      const list = ids(k);
      if (list.length) add(await s.selectFrom(table).select(['id', 'name as label', 'site_id']).where('id', 'in', list).execute());
    };
    await Promise.all([
      byUpn('build_users', 'user'),
      byUpn('build_caps', 'cap'),
      byUpn('build_resource_accounts', 'resource_account'),
      byName('build_shared_calling_policies', 'shared_calling_policy'),
      byName('build_call_queues', 'call_queue'),
      byName('build_auto_attendants', 'auto_attendant'),
      (async () => {
        const list = ids('site');
        if (list.length) add(await s.selectFrom('discovery_sites').select(['id', 'sitecode as label', 'id as site_id']).where('id', 'in', list).execute());
      })(),
    ]);
    return links.map((l) => {
      const hit = found.get(l.row_id);
      return { kind: l.kind, row_id: l.row_id, label: hit ? hit.label : null, site_id: hit?.site_id ?? null, created_at: l.created_at };
    });
  }

  /** The Design tab's summary: linked rows, and what stops "Mark as designed & built". */
  async design(t: TenantContext, id: string): Promise<SrDesignSummary> {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    const items = await this.items(t, id);
    const live = items.filter((i) => i.label !== null);
    const deployableCount = live.filter((i) => SR_ITEM_SHEET[i.kind] && i.site_id === row.site_id).length;
    const missingCount = items.length - live.length;
    return { items, deployableCount, builtBlockers: srBuiltBlockers(row.type, { siteId: row.site_id, deployableCount, missingCount }) };
  }

  /** Removes a row from the request. The row itself stays in Design & Build - delete it there if it isn't wanted at all. */
  async unlinkItem(t: TenantContext, user: AuthedUser, id: string, kind: SrItemKind, rowId: string) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    if (!srDesignEditable(row.status)) {
      throw new BadRequestException(`Rows can only be removed while the request is Planned. This one is ${SR_STATUS_LABELS[row.status]}.`);
    }
    const s = tenantDb(this.db, t.schema);
    const gone = await s
      .deleteFrom('service_request_items')
      .where('request_id', '=', id)
      .where('kind', '=', kind)
      .where('row_id', '=', rowId)
      .executeTakeFirst();
    if (!Number(gone.numDeletedRows)) throw new NotFoundException('That row is not on this request.');
    await s.updateTable('service_requests').set({ updated_at: new Date().toISOString() }).where('id', '=', id).execute();
    await this.audit.tenant(t.schema, 'service_request.item_removed', {
      actor: { id: user.id, email: user.email },
      targetType: 'service_request',
      targetId: id,
      detail: { reference: srReference(row.number), kind, rowId },
    });
    return { ok: true };
  }

  /**
   * What a deployment for this request acts on: its linked rows on the
   * request's site, plus the resource accounts its call queues and auto
   * attendants answer on (they have to exist for the queue / attendant to
   * work). Users that a queue or attendant routes to are added by the
   * deployment's own dependency expansion.
   */
  private async deployScope(t: TenantContext, row: { id: string; type: keyof typeof SR_TYPE_DEFS; site_id: string | null; number: number }) {
    if (!srHasDesign(row.type)) throw new BadRequestException(`A ${SR_TYPE_DEFS[row.type].label.toLowerCase()} request has nothing to deploy from here.`);
    if (!row.site_id) throw new BadRequestException('The request has no site.');
    const siteId = row.site_id;
    const items = (await this.items(t, row.id)).filter((i) => i.label !== null && SR_ITEM_SHEET[i.kind] && i.site_id === siteId);
    if (items.length === 0) throw new BadRequestException('Nothing has been designed for this request yet.');
    const s = tenantDb(this.db, t.schema);
    const flowIds = (k: SrItemKind) => items.filter((i) => i.kind === k).map((i) => i.row_id);
    const [cqs, aas] = await Promise.all([
      flowIds('call_queue').length ? s.selectFrom('build_call_queues').select('resource_accounts').where('id', 'in', flowIds('call_queue')).execute() : [],
      flowIds('auto_attendant').length ? s.selectFrom('build_auto_attendants').select('resource_accounts').where('id', 'in', flowIds('auto_attendant')).execute() : [],
    ]);
    const raIds = [...cqs, ...aas].flatMap((r) => (Array.isArray(r.resource_accounts) ? (r.resource_accounts as unknown[]).filter((v): v is string => typeof v === 'string') : []));
    const ras = raIds.length
      ? await s.selectFrom('build_resource_accounts').select('id').where('id', 'in', raIds).where('site_id', '=', siteId).execute()
      : [];
    const kinds = new Set<SrItemKind>(items.map((i) => i.kind));
    if (ras.length) kinds.add('resource_account');
    const rowIds = [...new Set([...items.map((i) => i.row_id), ...ras.map((r) => r.id)])];
    return { siteId, sheets: srItemSheets(kinds), rowIds };
  }

  /** What What-If / Deploy would do for this request right now (no connection needed). */
  async deployPreview(t: TenantContext, id: string) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    const scope = await this.deployScope(t, row);
    return this.deployment.previewChanges(t, scope);
  }

  /**
   * What-If or Deploy just this request's rows, on the caller's own tenant
   * connection - the normal deployment path, with all its checks (read-only
   * tenant, number mismatches, one live run per connection). What-If is open
   * while the request is Planned or Designed & built; a live deploy needs it
   * Designed & built, and a clean live run moves it to Deployed.
   */
  async deploy(t: TenantContext, user: AuthedUser, id: string, input: ServiceRequestDeployInput) {
    this.assertEnabled(t);
    const row = await this.load(t, id);
    const allowed: SrStatus[] = input.mode === 'execute' ? ['built'] : ['planned', 'built'];
    if (!allowed.includes(row.status)) {
      throw new BadRequestException(
        input.mode === 'execute'
          ? `Mark the request as designed & built before deploying it. It is ${SR_STATUS_LABELS[row.status]}.`
          : `What-If runs while a request is Planned or Designed & built. This one is ${SR_STATUS_LABELS[row.status]}.`,
      );
    }
    const scope = await this.deployScope(t, row);
    const dep = await this.deployment.createDeployment(
      t,
      user,
      { connectionId: input.connectionId, mode: input.mode, scope },
      (p) => can(user.role, p),
      { serviceRequestId: id },
    );
    await tenantDb(this.db, t.schema).updateTable('service_requests').set({ updated_at: new Date().toISOString() }).where('id', '=', id).execute();
    return dep;
  }

  /** Deployment runs started from this request, newest first. */
  async runs(t: TenantContext, id: string): Promise<SrDeploymentRun[]> {
    this.assertEnabled(t);
    await this.load(t, id);
    const rows = await tenantDb(this.db, t.schema)
      .selectFrom('deployments')
      .select(['id', 'mode', 'status', 'summary', 'created_at', 'finished_at'])
      .where(sql<boolean>`scope->>'serviceRequestId' = ${id}`)
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();
    return rows.map((r) => ({ ...r, mode: r.mode as SrDeploymentRun['mode'], summary: (r.summary ?? {}) as Record<string, number> }));
  }

  /**
   * "Prefill" for a change or removal (see service-request-change.ts): finds
   * the existing Design & Build row - a user not in Design & Build yet is
   * added to the request's site - links it to the request, and applies what
   * maps cleanly (new number, voicemail, revoke, queue agents and routing, AA
   * greeting and holiday) through the normal update path. Everything else
   * comes back as warnings: the engineer's to-do list.
   */
  private async applyChange(
    t: TenantContext,
    user: AuthedUser,
    row: { id: string; number: number; type: SrType; site_id: string | null; details: unknown },
  ): Promise<SrBuildDraftResult> {
    const mapped = srChangePlan(row.type, row.details as Record<string, unknown>);
    if (!mapped.ok) throw new BadRequestException(mapped.error);
    const plan = mapped.plan;
    if (!row.site_id) throw new BadRequestException("The request's site no longer exists.");
    const siteId = row.site_id;
    const reference = srReference(row.number);
    const s = tenantDb(this.db, t.schema);
    const valid = <T>(schema: ZodType<T, ZodTypeDef, unknown>, v: unknown): T => {
      const r = schema.safeParse(v);
      if (r.success) return r.data;
      throw new BadRequestException(`The change can't be applied as it is (${r.error.issues.map((i) => i.message).join('; ')}). Make it by hand on the Design tab.`);
    };

    // 1. Find (or, for a user, add) the row.
    let rowId: string;
    let created = false;
    if ('upn' in plan.find) {
      const found = await s.selectFrom('build_users').select(['id', 'site_id']).where(sql<string>`lower(upn)`, '=', plan.find.upn).executeTakeFirst();
      if (found && found.site_id !== siteId) {
        const other = await s.selectFrom('discovery_sites').select('sitecode').where('id', '=', found.site_id).executeTakeFirst();
        throw new BadRequestException(`${plan.find.upn} is on site ${other?.sitecode ?? 'another site'} in Design & Build, not this request's site. Change the request's site, or make the change there.`);
      }
      if (found) rowId = found.id;
      else {
        const r = await this.build.createUser(t, user, valid(buildIdentityCreateSchema, { site_id: siteId, upn: plan.find.upn, comments: `From ${reference}: ${plan.find.name}.` }));
        rowId = r.id;
        created = true;
      }
    } else {
      const table = plan.kind === 'cap' ? 'build_caps' : plan.kind === 'call_queue' ? 'build_call_queues' : 'build_auto_attendants';
      const found = await s.selectFrom(table).select(['id', 'site_id']).where('id', '=', plan.find.id).executeTakeFirst();
      if (!found || found.site_id !== siteId) throw new BadRequestException(`${plan.label} is no longer at this site in Design & Build.`);
      rowId = found.id;
    }
    await this.linkItem(t, user, row.id, plan.kind, rowId);

    // 2. Apply what maps cleanly.
    const applied: string[] = [];
    const a = plan.apply;
    if (plan.kind === 'user' || plan.kind === 'cap') {
      const patch: Record<string, unknown> = {};
      if (a.newNumber) {
        const n = await s.selectFrom('phone_numbers').select(['id', 'status']).where('e164', '=', a.newNumber).executeTakeFirst();
        if (n && n.status === 'available') {
          patch.phone_number_id = n.id;
          applied.push(`number ${a.newNumber}`);
        } else plan.todo.unshift(`${a.newNumber} is no longer free - pick another number for the row.`);
      }
      if (a.voicemail !== undefined) {
        patch.voicemail = { enabled: a.voicemail };
        applied.push(`voicemail ${a.voicemail ? 'on' : 'off'}`);
      }
      if (a.revoke) {
        patch.revoke_ev = true;
        applied.push('Revoke Enterprise Voice (removes the number and Teams calling when deployed)');
      }
      if (Object.keys(patch).length) {
        if (plan.kind === 'user') await this.build.updateUser(t, user, rowId, valid(buildIdentityPatchSchema, patch));
        else await this.build.updateCap(t, user, rowId, valid(buildCapPatchSchema, patch));
      }
    } else if (plan.kind === 'call_queue') {
      const cq = await s.selectFrom('build_call_queues').select(['agents', 'routing_method']).where('id', '=', rowId).executeTakeFirstOrThrow();
      const patch: Record<string, unknown> = {};
      if (a.addAgents?.length || a.removeAgents?.length) {
        const current = ((cq.agents as string[] | null) ?? []).map((u) => u.toLowerCase());
        const remove = new Set(a.removeAgents ?? []);
        const next = [...new Set([...current.filter((u) => !remove.has(u)), ...(a.addAgents ?? [])])];
        patch.agents = next;
        if (a.addAgents?.length) applied.push(`added ${a.addAgents.join(', ')}`);
        if (a.removeAgents?.length) applied.push(`removed ${a.removeAgents.join(', ')}`);
        const missing = (a.removeAgents ?? []).filter((u) => !current.includes(u));
        if (missing.length) plan.todo.unshift(`${missing.join(', ')} ${missing.length === 1 ? "wasn't" : "weren't"} in the queue already.`);
      }
      if (a.routing && a.routing !== cq.routing_method) {
        patch.routing_method = a.routing;
        applied.push(`routing ${a.routing}`);
      }
      if (Object.keys(patch).length) await this.build.updateCallQueue(t, user, rowId, valid(buildCallQueuePatchSchema, patch));
    } else {
      const aa = await s.selectFrom('build_auto_attendants').select(['default_call_flow', 'holiday_call_flows']).where('id', '=', rowId).executeTakeFirstOrThrow();
      const patch: Record<string, unknown> = {};
      if (a.greeting) {
        const flow = (aa.default_call_flow as AutoAttendantCallFlow | null) ?? { greetings: [], menu: { options: [] } };
        patch.default_call_flow = { ...flow, greetings: [{ type: 'Text', text: a.greeting }] };
        applied.push('new greeting');
      }
      if (a.holiday) {
        const holidays = ((aa.holiday_call_flows as AutoAttendantHolidayCallFlow[] | null) ?? []).filter((h) => h.name !== a.holiday!.name);
        patch.holiday_call_flows = [...holidays, a.holiday];
        applied.push(`holiday "${a.holiday.name}"`);
      }
      if (Object.keys(patch).length) await this.build.updateAutoAttendant(t, user, rowId, valid(buildAutoAttendantPatchSchema, patch));
    }

    const link: SrBuildLink = { kind: plan.kind, label: plan.label, href: srBuildHref(plan.kind, siteId) };
    const body = [
      `${created ? 'Added' : 'Linked'} ${SR_BUILD_KIND_LABELS[plan.kind].toLowerCase()} ${plan.label}${applied.length ? ` and applied: ${applied.join('; ')}` : ''}.`,
      ...plan.todo.map((x) => `To do: ${x}`),
    ].join('\n');
    await s
      .insertInto('service_request_events')
      .values({ request_id: row.id, kind: 'build_drafted', body, internal: true, links: JSON.stringify([link]), author_id: user.id })
      .execute();
    await s.updateTable('service_requests').set({ updated_at: new Date().toISOString() }).where('id', '=', row.id).execute();
    await this.audit.tenant(t.schema, 'service_request.change_applied', {
      actor: { id: user.id, email: user.email },
      targetType: 'service_request',
      targetId: row.id,
      detail: { reference, kind: plan.kind, rowId, applied },
    });
    return { created: created ? [link] : [], existing: created ? [] : [link], warnings: plan.todo, applied };
  }

  /**
   * Agents typed as names instead of sign-in addresses: a name that matches
   * exactly one person in the synced directory (or, failing that, Data
   * Collection's users) becomes their UPN. Anything else is left for the engineer.
   */
  private async resolveAgentNames(t: TenantContext, names: string[]): Promise<{ upns: string[]; missing: string[] }> {
    const upns: string[] = [];
    const missing: string[] = [];
    const s = tenantDb(this.db, t.schema);
    for (const name of names) {
      const lower = name.toLowerCase();
      let rows = await s
        .selectFrom('tenant_users')
        .select('upn')
        .where(sql<string>`lower(display_name)`, '=', lower)
        .where('removed_at', 'is', null)
        .execute();
      if (rows.length === 0) {
        rows = await s.selectFrom('discovery_users').select('upn').where(sql<string>`lower(display_name)`, '=', lower).execute();
      }
      const distinct = [...new Set(rows.map((r) => r.upn.toLowerCase()))];
      if (distinct.length === 1) upns.push(distinct[0]);
      else missing.push(name);
    }
    return { upns, missing };
  }

  /** The customer's most-used sign-in domain (for suggesting a common area phone UPN), or null if no users are known yet. */
  private async mainDomain(t: TenantContext): Promise<string | null> {
    const s = tenantDb(this.db, t.schema);
    for (const table of ['tenant_users', 'discovery_users'] as const) {
      const top = await s
        .selectFrom(table)
        .select([sql<string>`split_part(lower(upn), '@', 2)`.as('domain'), sql<number>`count(*)`.as('n')])
        .groupBy(sql`split_part(lower(upn), '@', 2)`)
        .orderBy(sql`count(*)`, 'desc')
        .limit(1)
        .executeTakeFirst();
      if (top?.domain) return top.domain;
    }
    return null;
  }
}
