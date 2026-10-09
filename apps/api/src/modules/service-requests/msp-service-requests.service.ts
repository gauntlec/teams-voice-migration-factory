import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { platformDb, tenantDb, tenantSchemaName } from '@tvmf/db';
import {
  SR_OPEN_STATUSES,
  can,
  srEffectiveTargets,
  srNextClock,
  srReference,
  srSla,
  type MspServiceRequestsQuery,
  type ServiceRequestCommentInput,
  type SrSettings,
  type SrStatus,
} from '@tvmf/shared';
import { resolveMspId } from '../../common/msp-resolution.util';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { ServiceRequestsService } from './service-requests.service';

/** Cap per customer, so one very busy customer can't make the queue unusable. */
const PER_CUSTOMER_LIMIT = 300;

/**
 * The MSP service-request admin queue: every request across the customers an
 * MSP looks after (platform.tenants.msp_id), in one list.
 *
 * - Engineers and project managers see the customers of their own MSP (worked
 *   out exactly as for app branding - email domain, then the per-user override).
 * - Super Admins see every customer, and can filter by MSP.
 * Only customers with Managed Services switched on are included. Each item
 * carries its target status (response, then resolution). People on a
 * customer's team (`can_open`) can assign and reply from the queue itself;
 * everything else is done inside the customer.
 */
@Injectable()
export class MspServiceRequestsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly requests: ServiceRequestsService,
  ) {}

  /**
   * The customer context for acting on one of its requests from the queue -
   * the same checks TenantGuard makes, plus: Managed Services on, and the
   * caller can manage requests (a member engineer, or a Super Admin).
   */
  private async contextFor(user: AuthedUser, tenantId: string): Promise<TenantContext> {
    if (!can(user.role, 'sr:manage')) throw new ForbiddenException('Only engineers and admins can action requests.');
    const tenant = await platformDb(this.db)
      .selectFrom('tenants')
      .select(['id', 'slug', 'name', 'schema_name', 'status', 'teams_read_only', 'managed_services_enabled'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (!tenant || tenant.status !== 'active') throw new NotFoundException('customer not found');
    if (user.role !== 'SUPER_ADMIN') {
      const member = await platformDb(this.db)
        .selectFrom('tenant_memberships')
        .select('user_id')
        .where('user_id', '=', user.id)
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
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
    return this.requests.staff(await this.contextFor(user, tenantId));
  }

  async assign(user: AuthedUser, tenantId: string, id: string, assigneeId: string | null) {
    return this.requests.assign(await this.contextFor(user, tenantId), user, id, assigneeId);
  }

  async comment(user: AuthedUser, tenantId: string, id: string, input: ServiceRequestCommentInput) {
    return this.requests.comment(await this.contextFor(user, tenantId), user, id, input, true);
  }

  async msps() {
    return platformDb(this.db).selectFrom('msps').select(['id', 'name']).orderBy('name').execute();
  }

  async queue(user: AuthedUser, q: MspServiceRequestsQuery) {
    const p = platformDb(this.db);
    const superAdmin = user.role === 'SUPER_ADMIN';

    let mspId: string | null = null;
    if (!superAdmin) {
      const me = await p.selectFrom('users').select(['email', 'msp_id']).where('id', '=', user.id).executeTakeFirstOrThrow();
      mspId = await resolveMspId(this.db, me.email, me.msp_id);
      if (!mspId) return { msp: null, customers: [], items: [] };
    }

    let tenantsQ = p
      .selectFrom('tenants as t')
      .leftJoin('msps as m', 'm.id', 't.msp_id')
      .select(['t.id as id', 't.name as name', 't.schema_name as schema', 't.msp_id as msp_id', 'm.name as msp_name', 't.sr_settings as sr_settings'])
      .where('t.status', '=', 'active')
      .where('t.managed_services_enabled', '=', true)
      .orderBy('t.name');
    if (!superAdmin) tenantsQ = tenantsQ.where('t.msp_id', '=', mspId!);
    else if (q.mspId === 'none') tenantsQ = tenantsQ.where('t.msp_id', 'is', null);
    else if (q.mspId) tenantsQ = tenantsQ.where('t.msp_id', '=', q.mspId);
    const tenants = await tenantsQ.execute();

    const memberOf = new Set(
      superAdmin
        ? tenants.map((t) => t.id)
        : (await p.selectFrom('tenant_memberships').select('tenant_id').where('user_id', '=', user.id).execute()).map((r) => r.tenant_id),
    );

    const perTenant = await Promise.all(
      tenants.map(async (t) => {
        let rq = tenantDb(this.db, t.schema)
          .selectFrom('service_requests as sr')
          .leftJoin('discovery_sites as ds', 'ds.id', 'sr.site_id')
          .select([
            'sr.id as id',
            'sr.number as number',
            'sr.type as type',
            'sr.title as title',
            'sr.priority as priority',
            'sr.status as status',
            'ds.sitecode as sitecode',
            'sr.requested_by as requested_by',
            'sr.assigned_to as assigned_to',
            'sr.target_date as target_date',
            'sr.created_at as created_at',
            'sr.waiting_since as waiting_since',
            'sr.waiting_seconds as waiting_seconds',
            'sr.first_response_at as first_response_at',
            'sr.deployed_at as deployed_at',
            'sr.declined_at as declined_at',
            'sr.cancelled_at as cancelled_at',
            'sr.reopened_at as reopened_at',
          ])
          .orderBy('sr.number', 'desc')
          .limit(PER_CUSTOMER_LIMIT);
        if (q.status === 'open') rq = rq.where('sr.status', 'in', [...SR_OPEN_STATUSES]);
        else if (q.status !== 'all') rq = rq.where('sr.status', '=', q.status as SrStatus);
        if (q.mine === 'true') rq = rq.where('sr.assigned_to', '=', user.id);
        const rows = await rq.execute();
        const targets = srEffectiveTargets(t.sr_settings as SrSettings);
        const now = Date.now();
        return rows.map((r) => ({
          ...r,
          sla: srNextClock(srSla(r, targets, now)),
          reference: srReference(r.number),
          tenant_id: t.id,
          tenant_name: t.name,
          msp_name: t.msp_name,
          can_open: memberOf.has(t.id),
        }));
      }),
    );
    const items = perTenant.flat().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    const ids = [...new Set(items.flatMap((i) => [i.requested_by, i.assigned_to]).filter((v): v is string => !!v))];
    const names = ids.length ? new Map((await p.selectFrom('users').select(['id', 'display_name']).where('id', 'in', ids).execute()).map((u) => [u.id, u.display_name])) : new Map<string, string>();

    const msp = mspId ? await p.selectFrom('msps').select(['id', 'name']).where('id', '=', mspId).executeTakeFirst() : null;
    return {
      msp: msp ?? null,
      customers: tenants.map((t) => ({ id: t.id, name: t.name, msp_name: t.msp_name, can_open: memberOf.has(t.id) })),
      items: items.map((i) => ({
        ...i,
        requested_by_name: names.get(i.requested_by) ?? null,
        assigned_to_name: i.assigned_to ? (names.get(i.assigned_to) ?? null) : null,
      })),
    };
  }
}
