import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { platformDb, tenantDb, tenantSchemaName } from '@tvmf/db';
import {
  INC_LIVE_STATUSES,
  INC_OPEN_STATUSES,
  can,
  incCategoryLabel,
  incMajorUpdateClock,
  incNextClock,
  incReference,
  incSlaFor,
  type IncidentAssignInput,
  type IncidentCommentInput,
  type IncidentStatusInput,
  type IncSettings,
  type IncStatus,
  type MspIncidentsQuery,
} from '@tvmf/shared';
import { resolveMspId } from '../../common/msp-resolution.util';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { IncidentsService } from './incidents.service';

/** Cap per customer, so one very busy customer can't make the queue unusable. */
const PER_CUSTOMER_LIMIT = 300;

/**
 * The MSP incident console: every incident across the customers an MSP looks after
 * (platform.tenants.msp_id), in one queue, plus the board of live major incidents.
 * Built the same way as the service-request queue:
 * - Engineers and project managers see the customers of their own MSP (worked out as for
 *   app branding: email domain, then the per-user override).
 * - Super Admins see every customer, and can filter by MSP.
 * Only customers with Managed Services on are included. People on a customer's team
 * (`can_open`) can acknowledge, assign and reply from the queue; everything else is done
 * inside the customer.
 */
@Injectable()
export class MspIncidentsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly incidents: IncidentsService,
  ) {}

  /** The customer context for acting on one of its incidents from the console: the same checks TenantGuard makes, plus Managed Services on and inc:manage. */
  private async contextFor(user: AuthedUser, tenantId: string): Promise<TenantContext> {
    if (!can(user.role, 'inc:manage')) throw new ForbiddenException('Only engineers and admins can work incidents.');
    const tenant = await platformDb(this.db)
      .selectFrom('tenants')
      .select(['id', 'slug', 'name', 'schema_name', 'status', 'teams_read_only', 'managed_services_enabled'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (!tenant || tenant.status !== 'active') throw new NotFoundException('customer not found');
    if (user.role !== 'SUPER_ADMIN') {
      const member = await platformDb(this.db).selectFrom('tenant_memberships').select('user_id').where('user_id', '=', user.id).where('tenant_id', '=', tenantId).executeTakeFirst();
      if (!member) throw new ForbiddenException("You're not on this customer's team.");
    }
    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      schema: tenant.schema_name || tenantSchemaName(tenant.id),
      siteScope: null,
      teamsReadOnly: tenant.teams_read_only,
      managedServices: tenant.managed_services_enabled,
    };
  }

  async assignees(user: AuthedUser, tenantId: string) {
    return this.incidents.staff(await this.contextFor(user, tenantId));
  }

  async assign(user: AuthedUser, tenantId: string, id: string, input: IncidentAssignInput) {
    return this.incidents.assign(await this.contextFor(user, tenantId), user, id, input);
  }

  async comment(user: AuthedUser, tenantId: string, id: string, input: IncidentCommentInput) {
    return this.incidents.comment(await this.contextFor(user, tenantId), user, id, input, true);
  }

  /** Acknowledge, hold, restore ... straight from the queue. */
  async move(user: AuthedUser, tenantId: string, id: string, input: IncidentStatusInput) {
    return this.incidents.move(await this.contextFor(user, tenantId), user, id, input, true);
  }

  async msps() {
    return platformDb(this.db).selectFrom('msps').select(['id', 'name']).orderBy('name').execute();
  }

  /** The customers this caller's queue covers, with whether they are on each team. */
  private async scope(user: AuthedUser, q: { mspId?: string }) {
    const p = platformDb(this.db);
    const superAdmin = user.role === 'SUPER_ADMIN';
    let mspId: string | null = null;
    if (!superAdmin) {
      const me = await p.selectFrom('users').select(['email', 'msp_id']).where('id', '=', user.id).executeTakeFirstOrThrow();
      mspId = await resolveMspId(this.db, me.email, me.msp_id);
      if (!mspId) return { mspId: null, tenants: [], memberOf: new Set<string>(), empty: true as const };
    }
    let tenantsQ = p
      .selectFrom('tenants as t')
      .leftJoin('msps as m', 'm.id', 't.msp_id')
      .select(['t.id as id', 't.name as name', 't.schema_name as schema', 't.msp_id as msp_id', 'm.name as msp_name', 't.inc_settings as inc_settings'])
      .where('t.status', '=', 'active')
      .where('t.managed_services_enabled', '=', true)
      .orderBy('t.name');
    if (!superAdmin) tenantsQ = tenantsQ.where('t.msp_id', '=', mspId!);
    else if (q.mspId === 'none') tenantsQ = tenantsQ.where('t.msp_id', 'is', null);
    else if (q.mspId) tenantsQ = tenantsQ.where('t.msp_id', '=', q.mspId);
    const tenants = await tenantsQ.execute();
    const memberOf = new Set(
      superAdmin ? tenants.map((t) => t.id) : (await p.selectFrom('tenant_memberships').select('tenant_id').where('user_id', '=', user.id).execute()).map((r) => r.tenant_id),
    );
    return { mspId, tenants, memberOf, empty: false as const };
  }

  private async names(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    return unique.length ? new Map((await platformDb(this.db).selectFrom('users').select(['id', 'display_name']).where('id', 'in', unique).execute()).map((u) => [u.id, u.display_name])) : new Map<string, string>();
  }

  async queue(user: AuthedUser, q: MspIncidentsQuery) {
    const sc = await this.scope(user, q);
    if (sc.empty) return { msp: null, customers: [], items: [] };
    const perTenant = await Promise.all(
      sc.tenants.map(async (t) => {
        let rq = tenantDb(this.db, t.schema)
          .selectFrom('incidents as i')
          .leftJoin('discovery_sites as ds', 'ds.id', 'i.site_id')
          .select([
            'i.id as id', 'i.number as number', 'i.title as title', 'i.category as category', 'i.subcategory as subcategory', 'i.priority as priority', 'i.status as status', 'i.hold_reason as hold_reason',
            'ds.sitecode as sitecode', 'i.reporter_id as reporter_id', 'i.assigned_to as assigned_to', 'i.assigned_agent_id as assigned_agent_id', 'i.created_at as created_at',
            'i.acknowledged_at as acknowledged_at', 'i.restored_at as restored_at', 'i.resolved_at as resolved_at', 'i.reopened_at as reopened_at', 'i.paused_since as paused_since',
            'i.paused_seconds as paused_seconds', 'i.pause_log as pause_log', 'i.major as major', 'i.major_ended_at as major_ended_at', 'i.next_update_due_at as next_update_due_at', 'i.parent_id as parent_id',
          ])
          .orderBy('i.number', 'desc')
          .limit(PER_CUSTOMER_LIMIT);
        if (q.status === 'open') rq = rq.where('i.status', 'in', [...INC_LIVE_STATUSES]);
        else if (q.status !== 'all') rq = rq.where('i.status', '=', q.status as IncStatus);
        if (q.mine === 'true') rq = rq.where('i.assigned_to', '=', user.id);
        if (q.priority) rq = rq.where('i.priority', '=', q.priority);
        const rows = await rq.execute();
        const settings = (t.inc_settings ?? {}) as IncSettings;
        const now = Date.now();
        return rows.map((r) => ({
          ...r,
          sla: incNextClock(incSlaFor(r, settings, now)),
          major_clock: incMajorUpdateClock(r, now),
          reference: incReference(r.number),
          category_label: incCategoryLabel(r.category, r.subcategory),
          tenant_id: t.id,
          tenant_name: t.name,
          msp_name: t.msp_name,
          can_open: sc.memberOf.has(t.id),
        }));
      }),
    );
    // The most urgent first: live majors, then priority, then the longest waiting.
    const items = perTenant.flat().sort((a, b) => Number(isLiveMajor(b)) - Number(isLiveMajor(a)) || a.priority.localeCompare(b.priority) || String(a.created_at).localeCompare(String(b.created_at)));
    const names = await this.names(items.flatMap((i) => [i.reporter_id, i.assigned_to]));
    const msp = sc.mspId ? await platformDb(this.db).selectFrom('msps').select(['id', 'name']).where('id', '=', sc.mspId).executeTakeFirst() : null;
    return {
      msp: msp ?? null,
      customers: sc.tenants.map((t) => ({ id: t.id, name: t.name, msp_name: t.msp_name, can_open: sc.memberOf.has(t.id) })),
      items: items.map(({ pause_log: _log, ...i }) => ({ ...i, reporter_name: names.get(i.reporter_id) ?? null, assigned_to_name: i.assigned_to ? (names.get(i.assigned_to) ?? null) : null })),
    };
  }

  /** Live major incidents across the MSP's customers, with the lead, comms owner, update clock and children. */
  async board(user: AuthedUser, q: { mspId?: string }) {
    const sc = await this.scope(user, q);
    if (sc.empty) return { msp: null, items: [] };
    const perTenant = await Promise.all(
      sc.tenants.map(async (t) => {
        const s = tenantDb(this.db, t.schema);
        const rows = await s
          .selectFrom('incidents as i')
          .leftJoin('discovery_sites as ds', 'ds.id', 'i.site_id')
          .select([
            'i.id as id', 'i.number as number', 'i.title as title', 'i.priority as priority', 'i.status as status', 'ds.sitecode as sitecode', 'i.lead_id as lead_id', 'i.comms_id as comms_id',
            'i.major as major', 'i.major_ended_at as major_ended_at', 'i.major_declared_at as major_declared_at', 'i.next_update_due_at as next_update_due_at', 'i.update_interval_minutes as update_interval_minutes',
          ])
          .where('i.major', '=', true)
          .where('i.major_ended_at', 'is', null)
          .where('i.status', 'in', [...INC_OPEN_STATUSES])
          .execute();
        if (rows.length === 0) return [];
        const ids = rows.map((r) => r.id);
        const [kids, updates] = await Promise.all([
          s.selectFrom('incidents').select(['parent_id', 'status']).where('parent_id', 'in', ids).execute(),
          s.selectFrom('incident_events').select(['incident_id', 'body', 'created_at']).where('incident_id', 'in', ids).where('kind', 'in', ['major_declared', 'major_update']).orderBy('created_at', 'desc').execute(),
        ]);
        const now = Date.now();
        return rows.map((r) => ({
          ...r,
          reference: incReference(r.number),
          tenant_id: t.id,
          tenant_name: t.name,
          can_open: sc.memberOf.has(t.id),
          update_clock: incMajorUpdateClock(r, now),
          children: kids.filter((k) => k.parent_id === r.id).length,
          open_children: kids.filter((k) => k.parent_id === r.id && INC_OPEN_STATUSES.includes(k.status)).length,
          latest_update: updates.find((u) => u.incident_id === r.id) ?? null,
        }));
      }),
    );
    const items = perTenant.flat().sort((a, b) => a.priority.localeCompare(b.priority) || String(a.major_declared_at).localeCompare(String(b.major_declared_at)));
    const names = await this.names(items.flatMap((i) => [i.lead_id, i.comms_id]));
    const msp = sc.mspId ? await platformDb(this.db).selectFrom('msps').select(['id', 'name']).where('id', '=', sc.mspId).executeTakeFirst() : null;
    return { msp: msp ?? null, items: items.map((i) => ({ ...i, lead_name: names.get(i.lead_id ?? '') ?? null, comms_name: names.get(i.comms_id ?? '') ?? null })) };
  }
}

const isLiveMajor = (i: { major: boolean; major_ended_at: string | null; status: IncStatus }) => i.major && !i.major_ended_at && INC_OPEN_STATUSES.includes(i.status);
