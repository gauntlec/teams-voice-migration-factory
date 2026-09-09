import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'kysely';
import { platformDb, tenantDb } from '@tvmf/db';
import type {
  DiscoveryFlowInput,
  DiscoveryListQuery,
  DiscoveryNetworkInput,
  DiscoverySiteInput,
  DiscoverySiteOverview,
  DiscoverySiteOverviewInput,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { assertCustomerWide, assertSiteInScope } from './site-scope';

type Actor = Pick<AuthedUser, 'id' | 'email'>;
const actorOf = (u: AuthedUser): Actor => ({ id: u.id, email: u.email });

@Injectable()
export class DataCollectionService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private scoped(t: TenantContext) {
    return tenantDb(this.db, t.schema);
  }

  private async discoveryRow(t: TenantContext) {
    const row = await this.scoped(t).selectFrom('discovery').selectAll().executeTakeFirst();
    if (!row) {
      // Should exist (seeded in tenant migration 0001); create defensively.
      return this.scoped(t)
        .insertInto('discovery')
        .values({ status: 'draft', general: {} })
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    return row;
  }

  /** Guards every mutation: draft is open, submitted needs review rights, accepted is locked. */
  async assertEditable(t: TenantContext, canReview: boolean) {
    const { status } = await this.discoveryRow(t);
    if (status === 'accepted') {
      throw new ConflictException('Discovery is accepted and locked. Reopen it to make changes.');
    }
    if (status === 'submitted' && !canReview) {
      throw new ForbiddenException(
        'Discovery has been submitted for review. Ask an engineer to reopen it.',
      );
    }
  }

  /**
   * Landing payload for the Data Collection module: the discovery row, the
   * customer-wide calling policies, and every site the caller may see with a
   * per-site rollup of how much has been captured. Per-entity lists (users,
   * numbers, …) are fetched separately, one site at a time, paginated.
   */
  async get(t: TenantContext) {
    const s = this.scoped(t);
    const scope = t.siteScope;
    let sitesQ = s.selectFrom('discovery_sites').selectAll().orderBy('sitecode');
    if (scope) sitesQ = sitesQ.where('id', 'in', scope);

    const [discovery, sites, callingPolicies] = await Promise.all([
      this.discoveryRow(t),
      sitesQ.execute(),
      s.selectFrom('discovery_calling_policies').selectAll().orderBy('name').execute(),
    ]);

    const counts = sites.length
      ? await this.siteCounts(
          t,
          sites.map((x) => x.id),
          sites.map((x) => x.sitecode),
        )
      : {};
    const empty = { users: 0, caps: 0, resourceAccounts: 0, network: 0, flows: 0, ranges: 0, numbers: 0, numbersAssigned: 0 };
    return {
      discovery,
      callingPolicies,
      siteScope: scope,
      sites: sites.map((x) => ({ ...x, counts: counts[x.id] ?? empty })),
    };
  }

  /** Per-site rollup counts, assembled from a handful of GROUP BY queries. */
  private async siteCounts(t: TenantContext, siteIds: string[], sitecodes: string[]) {
    const s = this.scoped(t);
    const codeToId = new Map(sitecodes.map((c, i) => [c, siteIds[i]]));
    const bySite = (tbl: 'discovery_users' | 'discovery_caps' | 'discovery_resource_accounts' | 'discovery_network' | 'discovery_flows') =>
      s
        .selectFrom(tbl)
        .select('site_id')
        .select(sql<string>`count(*)`.as('n'))
        .where('site_id', 'in', siteIds)
        .groupBy('site_id')
        .execute();

    const [u, c, ra, net, fl, rg, nums] = await Promise.all([
      bySite('discovery_users'),
      bySite('discovery_caps'),
      bySite('discovery_resource_accounts'),
      bySite('discovery_network'),
      bySite('discovery_flows'),
      s
        .selectFrom('discovery_number_ranges')
        .select('sitecode')
        .select(sql<string>`count(*)`.as('n'))
        .where('sitecode', 'in', sitecodes)
        .groupBy('sitecode')
        .execute(),
      s
        .selectFrom('phone_numbers as n')
        .innerJoin('discovery_number_ranges as r', 'r.id', 'n.range_id')
        .select('r.sitecode as sitecode')
        .select(sql<string>`count(*)`.as('total'))
        .select(sql<string>`count(*) filter (where n.status = 'assigned')`.as('assigned'))
        .where('r.sitecode', 'in', sitecodes)
        .groupBy('r.sitecode')
        .execute(),
    ]);

    const out: Record<string, { users: number; caps: number; resourceAccounts: number; network: number; flows: number; ranges: number; numbers: number; numbersAssigned: number }> = {};
    const slot = (id: string) =>
      (out[id] ??= { users: 0, caps: 0, resourceAccounts: 0, network: 0, flows: 0, ranges: 0, numbers: 0, numbersAssigned: 0 });
    for (const r of u) if (r.site_id) slot(r.site_id).users = Number(r.n);
    for (const r of c) if (r.site_id) slot(r.site_id).caps = Number(r.n);
    for (const r of ra) if (r.site_id) slot(r.site_id).resourceAccounts = Number(r.n);
    for (const r of net) if (r.site_id) slot(r.site_id).network = Number(r.n);
    for (const r of fl) if (r.site_id) slot(r.site_id).flows = Number(r.n);
    for (const r of rg) {
      const id = codeToId.get(r.sitecode as string);
      if (id) slot(id).ranges = Number(r.n);
    }
    for (const r of nums) {
      const id = codeToId.get(r.sitecode as string);
      if (id) {
        slot(id).numbers = Number(r.total);
        slot(id).numbersAssigned = Number(r.assigned);
      }
    }
    return out;
  }

  /** Header payload for a single site's workspace. */
  async siteSummary(t: TenantContext, siteId: string) {
    assertSiteInScope(t, siteId);
    const s = this.scoped(t);
    const site = await s.selectFrom('discovery_sites').selectAll().where('id', '=', siteId).executeTakeFirst();
    if (!site) throw new NotFoundException('site not found');
    const [discovery, callingPolicies, statusRows] = await Promise.all([
      this.discoveryRow(t),
      s.selectFrom('discovery_calling_policies').selectAll().orderBy('name').execute(),
      s
        .selectFrom('phone_numbers as n')
        .innerJoin('discovery_number_ranges as r', 'r.id', 'n.range_id')
        .select('n.status as status')
        .select(sql<string>`count(*)`.as('n'))
        .where('r.sitecode', '=', site.sitecode)
        .groupBy('n.status')
        .execute(),
    ]);
    const numberSummary = { total: 0, available: 0, reserved: 0, assigned: 0 };
    for (const r of statusRows) {
      const k = r.status as keyof typeof numberSummary;
      numberSummary[k] = Number(r.n);
      numberSummary.total += Number(r.n);
    }

    const overview = (site.overview ?? {}) as DiscoverySiteOverview;
    const assignedStaff = await this.resolveStaff(overview.assignedUserIds ?? []);

    return { site, status: discovery.status, callingPolicies, numberSummary, overview, assignedStaff };
  }

  /** Resolve platform user ids to `{ id, displayName, role }` for display. */
  private async resolveStaff(ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await platformDb(this.db)
      .selectFrom('users')
      .select(['id', 'display_name', 'role'])
      .where('id', 'in', ids)
      .execute();
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, role: r.role }));
  }

  /** Active ENGINEER / PROJECT_MANAGER users, for the "assigned staff" picker. */
  async listStaff() {
    const rows = await platformDb(this.db)
      .selectFrom('users')
      .select(['id', 'display_name', 'role'])
      .where('role', 'in', ['ENGINEER', 'PROJECT_MANAGER'])
      .where('status', '=', 'active')
      .orderBy('display_name')
      .execute();
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, role: r.role }));
  }

  /**
   * Write a site's overview. `discovery:sites:manage` only (SUPER_ADMIN /
   * PROJECT_MANAGER / ENGINEER) - the controller enforces the permission, so no
   * CUSTOMER can reach this.
   */
  async updateSiteOverview(
    t: TenantContext,
    user: AuthedUser,
    siteId: string,
    patch: DiscoverySiteOverviewInput,
    canReview: boolean,
  ) {
    await this.assertEditable(t, canReview);
    const site = await this.scoped(t)
      .selectFrom('discovery_sites')
      .select(['id', 'overview'])
      .where('id', '=', siteId)
      .executeTakeFirst();
    if (!site) throw new NotFoundException('site not found');

    if (patch.assignedUserIds && patch.assignedUserIds.length) {
      const ids = [...new Set(patch.assignedUserIds)];
      const ok = await platformDb(this.db)
        .selectFrom('users')
        .select('id')
        .where('id', 'in', ids)
        .where('role', 'in', ['ENGINEER', 'PROJECT_MANAGER'])
        .where('status', '=', 'active')
        .execute();
      const found = new Set(ok.map((r) => r.id));
      const bad = ids.filter((id) => !found.has(id));
      if (bad.length) {
        throw new ConflictException('Assigned staff must be active engineers or project managers.');
      }
      patch = { ...patch, assignedUserIds: ids };
    }

    const next = { ...((site.overview ?? {}) as DiscoverySiteOverview), ...patch };
    const row = await this.scoped(t)
      .updateTable('discovery_sites')
      .set({ overview: next })
      .where('id', '=', siteId)
      .returning(['id', 'overview'])
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'discovery.site_overview_updated', {
      actor: actorOf(user),
      targetType: 'discovery_site',
      targetId: siteId,
      detail: { fields: Object.keys(patch) },
    });
    return {
      ...row,
      assignedStaff: await this.resolveStaff((row.overview as DiscoverySiteOverview).assignedUserIds ?? []),
    };
  }

  private pageOf(q: DiscoveryListQuery) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    return { page, limit, offset: (page - 1) * limit };
  }

  private siteIdFilter(t: TenantContext, siteId?: string): string[] | null {
    if (siteId) {
      assertSiteInScope(t, siteId);
      return [siteId];
    }
    return t.siteScope;
  }

  async listNetwork(t: TenantContext, q: DiscoveryListQuery) {
    const s = this.scoped(t);
    const sites = this.siteIdFilter(t, q.siteId);
    const { page, limit, offset } = this.pageOf(q);
    let b = s.selectFrom('discovery_network');
    if (sites) b = b.where('site_id', 'in', sites);
    if (q.q) {
      const like = `%${q.q}%`;
      b = b.where((eb) => eb.or([eb('subnet', 'ilike', like), eb('location', 'ilike', like)]));
    }
    const [items, cnt] = await Promise.all([
      b.selectAll().orderBy('scope').orderBy('subnet').limit(limit).offset(offset).execute(),
      b.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst(),
    ]);
    return { items, total: Number(cnt?.n ?? 0), page, limit };
  }

  async listFlows(t: TenantContext, q: DiscoveryListQuery) {
    const s = this.scoped(t);
    const sites = this.siteIdFilter(t, q.siteId);
    const { page, limit, offset } = this.pageOf(q);
    let b = s.selectFrom('discovery_flows');
    if (sites) b = b.where('site_id', 'in', sites);
    if (q.q) {
      const like = `%${q.q}%`;
      b = b.where((eb) => eb.or([eb('name', 'ilike', like), eb('description', 'ilike', like)]));
    }
    const [items, cnt] = await Promise.all([
      b.selectAll().orderBy('kind').orderBy('name').limit(limit).offset(offset).execute(),
      b.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst(),
    ]);
    return { items, total: Number(cnt?.n ?? 0), page, limit };
  }

  async submit(t: TenantContext, user: AuthedUser) {
    assertCustomerWide(t, 'Submitting the discovery for review');
    const current = await this.discoveryRow(t);
    if (current.status !== 'draft') {
      throw new ConflictException(`Cannot submit discovery from status "${current.status}".`);
    }
    const row = await this.scoped(t)
      .updateTable('discovery')
      .set({
        status: 'submitted',
        submitted_by: user.id,
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .returning(['id', 'status', 'submitted_at'])
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'discovery.submitted', { actor: actorOf(user) });
    await this.audit.platform('discovery.submitted', { actor: actorOf(user), tenantId: t.id });
    return row;
  }

  async accept(t: TenantContext, user: AuthedUser) {
    const current = await this.discoveryRow(t);
    if (current.status !== 'submitted') {
      throw new ConflictException(`Cannot accept discovery from status "${current.status}".`);
    }
    const row = await this.scoped(t)
      .updateTable('discovery')
      .set({
        status: 'accepted',
        accepted_by: user.id,
        accepted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .returning(['id', 'status', 'accepted_at'])
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'discovery.accepted', { actor: actorOf(user) });
    await this.audit.platform('discovery.accepted', { actor: actorOf(user), tenantId: t.id });
    return row;
  }

  async reopen(t: TenantContext, user: AuthedUser) {
    const current = await this.discoveryRow(t);
    if (current.status === 'draft') return { id: current.id, status: 'draft' as const };
    const row = await this.scoped(t)
      .updateTable('discovery')
      .set({
        status: 'draft',
        submitted_by: null,
        submitted_at: null,
        accepted_by: null,
        accepted_at: null,
        updated_at: new Date().toISOString(),
      })
      .returning(['id', 'status'])
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'discovery.reopened', { actor: actorOf(user) });
    return row;
  }

  /* -------------------------------- sites -------------------------------- */

  async addSite(t: TenantContext, user: AuthedUser, input: DiscoverySiteInput, canReview: boolean) {
    assertCustomerWide(t, 'Sites');
    await this.assertEditable(t, canReview);
    let row;
    try {
      row = await this.scoped(t)
        .insertInto('discovery_sites')
        .values({
          sitecode: input.sitecode,
          name: input.name || null,
          address: input.address || null,
          country: input.country || null,
          region: input.region || null,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          overview: {},
          paging: input.paging ?? {},
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (/duplicate key|unique/i.test((e as Error).message)) {
        throw new ConflictException(`A site with code "${input.sitecode}" already exists.`);
      }
      throw e;
    }
    await this.audit.tenant(t.schema, 'discovery.site_added', {
      actor: actorOf(user),
      targetType: 'discovery_site',
      targetId: row.id,
    });
    return row;
  }

  async updateSite(
    t: TenantContext,
    user: AuthedUser,
    id: string,
    patch: Partial<DiscoverySiteInput>,
    canReview: boolean,
  ) {
    assertCustomerWide(t, 'Sites');
    await this.assertEditable(t, canReview);
    const set = cleanPatch(patch);
    if ('sitecode' in set && set.sitecode == null) {
      throw new ConflictException('A site must have a site code.');
    }
    let row;
    try {
      row = await this.scoped(t)
        .updateTable('discovery_sites')
        .set(set)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
    } catch (e) {
      if (/duplicate key|unique/i.test((e as Error).message)) {
        throw new ConflictException(`A site with code "${patch.sitecode}" already exists.`);
      }
      throw e;
    }
    if (!row) throw new NotFoundException('site not found');
    await this.audit.tenant(t.schema, 'discovery.site_updated', {
      actor: actorOf(user),
      targetType: 'discovery_site',
      targetId: id,
    });
    return row;
  }

  async deleteSite(t: TenantContext, user: AuthedUser, id: string, canReview: boolean) {
    assertCustomerWide(t, 'Sites');
    await this.assertEditable(t, canReview);
    const res = await this.scoped(t).deleteFrom('discovery_sites').where('id', '=', id).executeTakeFirst();
    if (!res.numDeletedRows) throw new NotFoundException('site not found');
    await this.audit.tenant(t.schema, 'discovery.site_deleted', {
      actor: actorOf(user),
      targetType: 'discovery_site',
      targetId: id,
    });
    return { ok: true };
  }

  /* Number ranges, inventory, calling policies, users, CAPs and resource
   * accounts now live in TelephonyService (data-collection.telephony.service). */

  /**
   * For the site-linked discovery tables (network / flows): a site contact may
   * only touch a row whose `site_id` is one of theirs. No-op for whole-customer
   * callers.
   */
  private async assertRowSiteInScope(
    t: TenantContext,
    table: 'discovery_network' | 'discovery_flows',
    id: string,
    notFound: string,
  ) {
    if (!t.siteScope) return;
    const row = await this.scoped(t)
      .selectFrom(table)
      .select('site_id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException(notFound);
    assertSiteInScope(t, row.site_id);
  }

  /* ------------------------------- network ----------------------------- */

  async addNetwork(
    t: TenantContext,
    user: AuthedUser,
    input: DiscoveryNetworkInput,
    canReview: boolean,
  ) {
    await this.assertEditable(t, canReview);
    assertSiteInScope(t, input.site_id ?? null);
    const row = await this.scoped(t)
      .insertInto('discovery_network')
      .values({
        site_id: input.site_id ?? null,
        scope: input.scope,
        subnet: input.subnet,
        mask: input.mask ?? null,
        location: input.location || null,
        vlan_id: input.vlan_id ?? null,
        network_type: input.network_type ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'discovery.network_added', {
      actor: actorOf(user),
      targetType: 'discovery_network',
      targetId: row.id,
    });
    return row;
  }

  async updateNetwork(
    t: TenantContext,
    user: AuthedUser,
    id: string,
    patch: Partial<DiscoveryNetworkInput>,
    canReview: boolean,
  ) {
    await this.assertEditable(t, canReview);
    await this.assertRowSiteInScope(t, 'discovery_network', id, 'subnet not found');
    if ('site_id' in patch) assertSiteInScope(t, patch.site_id ?? null);
    const row = await this.scoped(t)
      .updateTable('discovery_network')
      .set(cleanPatch(patch))
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('subnet not found');
    await this.audit.tenant(t.schema, 'discovery.network_updated', {
      actor: actorOf(user),
      targetType: 'discovery_network',
      targetId: id,
    });
    return row;
  }

  async deleteNetwork(t: TenantContext, user: AuthedUser, id: string, canReview: boolean) {
    await this.assertEditable(t, canReview);
    await this.assertRowSiteInScope(t, 'discovery_network', id, 'subnet not found');
    const res = await this.scoped(t).deleteFrom('discovery_network').where('id', '=', id).executeTakeFirst();
    if (!res.numDeletedRows) throw new NotFoundException('subnet not found');
    await this.audit.tenant(t.schema, 'discovery.network_deleted', {
      actor: actorOf(user),
      targetType: 'discovery_network',
      targetId: id,
    });
    return { ok: true };
  }

  /* -------------------------------- flows ------------------------------- */

  async addFlow(t: TenantContext, user: AuthedUser, input: DiscoveryFlowInput, canReview: boolean) {
    await this.assertEditable(t, canReview);
    assertSiteInScope(t, input.site_id ?? null);
    const row = await this.scoped(t)
      .insertInto('discovery_flows')
      .values({
        site_id: input.site_id ?? null,
        kind: input.kind,
        name: input.name,
        description: input.description || null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'discovery.flow_added', {
      actor: actorOf(user),
      targetType: 'discovery_flow',
      targetId: row.id,
    });
    return row;
  }

  async updateFlow(
    t: TenantContext,
    user: AuthedUser,
    id: string,
    patch: Partial<DiscoveryFlowInput>,
    canReview: boolean,
  ) {
    await this.assertEditable(t, canReview);
    await this.assertRowSiteInScope(t, 'discovery_flows', id, 'flow not found');
    if ('site_id' in patch) assertSiteInScope(t, patch.site_id ?? null);
    const row = await this.scoped(t)
      .updateTable('discovery_flows')
      .set({ ...cleanPatch(patch), updated_at: new Date().toISOString() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('flow not found');
    await this.audit.tenant(t.schema, 'discovery.flow_updated', {
      actor: actorOf(user),
      targetType: 'discovery_flow',
      targetId: id,
    });
    return row;
  }

  async deleteFlow(t: TenantContext, user: AuthedUser, id: string, canReview: boolean) {
    await this.assertEditable(t, canReview);
    await this.assertRowSiteInScope(t, 'discovery_flows', id, 'flow not found');
    const res = await this.scoped(t).deleteFrom('discovery_flows').where('id', '=', id).executeTakeFirst();
    if (!res.numDeletedRows) throw new NotFoundException('flow not found');
    await this.audit.tenant(t.schema, 'discovery.flow_deleted', {
      actor: actorOf(user),
      targetType: 'discovery_flow',
      targetId: id,
    });
    return { ok: true };
  }
}

/** Drop undefined keys and normalise '' to null for a partial update. */
function cleanPatch<T extends Record<string, unknown>>(patch: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = v === '' ? null : v;
  }
  return out;
}
