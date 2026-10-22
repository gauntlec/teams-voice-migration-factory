import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'kysely';
import { platformDb, tenantDb } from '@tvmf/db';
import { asSiteRegion, contactUserIds, type SiteContact, type SiteContacts } from '@tvmf/shared';
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

    // Region lives on the site row (the same value the site creation form sets); the overview shows it from there.
    // The people on the site, by role. The two fields they replaced are folded in for sites not saved since, and not sent on.
    const { assignedUserIds: _assigned, primaryContactEmail: _primary, ...stored } = (site.overview ?? {}) as DiscoverySiteOverview;
    const contacts = await this.effectiveContacts((site.overview ?? {}) as DiscoverySiteOverview);
    const overview = { ...stored, region: asSiteRegion(site.region), contacts };
    const contactUsers = await this.resolveContactUsers(contactUserIds(contacts));

    return { site, status: discovery.status, callingPolicies, numberSummary, overview, contactUsers };
  }

  /**
   * The site's people by role. Overviews saved before the roles existed hold `assignedUserIds` (engineers and project managers)
   * and `primaryContactEmail`: those become Provider PM / Provider Engineer by role, and one typed Site contact.
   */
  private async effectiveContacts(stored: DiscoverySiteOverview): Promise<SiteContacts> {
    if (stored.contacts) return stored.contacts;
    const out: SiteContacts = {};
    if (stored.primaryContactEmail) out.siteContacts = [{ email: stored.primaryContactEmail }];
    const ids = stored.assignedUserIds ?? [];
    if (ids.length) {
      const rows = await platformDb(this.db).selectFrom('users').select(['id', 'role']).where('id', 'in', ids).execute();
      const roleOf = new Map(rows.map((r) => [r.id, r.role]));
      for (const id of ids) {
        const key = roleOf.get(id) === 'PROJECT_MANAGER' ? 'providerPm' : 'providerEngineer';
        (out[key] ??= []).push({ userId: id });
      }
    }
    return out;
  }

  /** Platform users as `{ id, displayName, email, role }`, for showing who was picked. */
  private async resolveContactUsers(ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await platformDb(this.db)
      .selectFrom('users')
      .select(['id', 'display_name', 'email', 'role'])
      .where('id', 'in', ids)
      .execute();
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, email: r.email, role: r.role }));
  }

  /** Active users who can be picked for a site's roles: engineers and project managers, plus this customer's own users. */
  async listContactCandidates(t: TenantContext) {
    const rows = await platformDb(this.db)
      .selectFrom('users as u')
      .select(['u.id', 'u.display_name', 'u.email', 'u.role'])
      .where('u.status', '=', 'active')
      .where((eb) =>
        eb.or([
          eb('u.role', 'in', ['ENGINEER', 'PROJECT_MANAGER']),
          eb('u.id', 'in', eb.selectFrom('tenant_memberships').select('user_id').where('tenant_id', '=', t.id)),
        ]),
      )
      .orderBy('u.display_name')
      .execute();
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, email: r.email, role: r.role }));
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
      .select(['id', 'overview', 'region'])
      .where('id', '=', siteId)
      .executeTakeFirst();
    if (!site) throw new NotFoundException('site not found');

    // Region is stored on the site row, not in the overview JSON.
    // An older free-text value shows as not set here, so only write it when the choice actually changed.
    const { region: sentRegion, contacts: sentContacts, ...overviewPatch } = patch;
    const region = sentRegion !== undefined && sentRegion !== asSiteRegion(site.region) ? sentRegion : undefined;
    patch = overviewPatch;

    let contacts: SiteContacts | undefined;
    if (sentContacts) {
      contacts = {};
      for (const [role, list] of Object.entries(sentContacts) as [keyof SiteContacts, SiteContact[] | undefined][]) {
        const seen = new Set<string>();
        const clean: SiteContact[] = [];
        for (const c of list ?? []) {
          const entry: SiteContact = c.userId ? { userId: c.userId } : { name: c.name?.trim() || undefined, email: c.email?.trim() || undefined };
          const key = c.userId ?? `${(entry.name ?? '').toLowerCase()}|${(entry.email ?? '').toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          clean.push(entry);
        }
        contacts[role] = clean;
      }
      const picked = contactUserIds(contacts);
      if (picked.length) {
        const ok = new Set((await this.listContactCandidates(t)).map((u) => u.id));
        if (picked.some((id) => !ok.has(id))) {
          throw new ConflictException("Picked people must be active engineers, project managers or this customer's users.");
        }
      }
    }

    const next: DiscoverySiteOverview = { ...((site.overview ?? {}) as DiscoverySiteOverview), ...patch };
    if (contacts) {
      next.contacts = contacts;
      // The two older fields are now roles in `contacts`.
      delete next.assignedUserIds;
      delete next.primaryContactEmail;
    }
    const row = await this.scoped(t)
      .updateTable('discovery_sites')
      .set({ overview: next, ...(region !== undefined ? { region: region || null } : {}) })
      .where('id', '=', siteId)
      .returning(['id', 'overview', 'region'])
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'discovery.site_overview_updated', {
      actor: actorOf(user),
      targetType: 'discovery_site',
      targetId: siteId,
      detail: { fields: [...Object.keys(patch), ...(region !== undefined ? ['region'] : []), ...(contacts ? ['contacts'] : [])] },
    });
    const saved = row.overview as DiscoverySiteOverview;
    const savedContacts = await this.effectiveContacts(saved);
    return {
      ...row,
      overview: { ...saved, region: asSiteRegion(row.region), contacts: savedContacts },
      contactUsers: await this.resolveContactUsers(contactUserIds(savedContacts)),
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
    return this.insertSite(t, user, input);
  }

  /**
   * The insert behind addSite, without its Data Collection guards. Also used
   * by Managed Services' "Create in Design & Build" for a new-site request: a
   * site added after go-live is an operational change, so it mustn't need the
   * (accepted, locked) migration Data Collection reopened. Callers check
   * permissions and validate `input` with discoverySiteSchema first.
   */
  async insertSite(t: TenantContext, user: AuthedUser, input: DiscoverySiteInput) {
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
        // The AA/CQ creation wizard's own POST (wizard.ts) - a plain
        // "Add" from the Call flows tab never sends these, so they stay
        // null (Source: Manual in the UI).
        wizard_answers: input.wizard_answers ?? null,
        wizard_version: input.wizard_version ?? null,
        resource_account_id: input.resource_account_id ?? null,
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
