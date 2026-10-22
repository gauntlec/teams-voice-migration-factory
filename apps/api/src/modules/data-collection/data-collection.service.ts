import {
  ConflictException,
  Injectable,
  Logger,
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
  private readonly log = new Logger(DataCollectionService.name);

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private scoped(t: TenantContext) {
    return tenantDb(this.db, t.schema);
  }

  /**
   * Records a change to a site that has already been submitted, so the engineer can see what is new since the submission.
   * Nothing is recorded while the site is still a draft, and nothing is ever locked. A failure to record never fails the
   * change itself.
   */
  async trackChange(
    t: TenantContext,
    user: AuthedUser,
    c: { siteId?: string | null; sitecode?: string | null; entity: string; action: 'added' | 'changed' | 'removed'; label?: string | null; detail?: string | null },
  ) {
    try {
      let q = this.scoped(t).selectFrom('discovery_sites').select(['id', 'review_status']);
      if (c.siteId) q = q.where('id', '=', c.siteId);
      else if (c.sitecode) q = q.where('sitecode', '=', c.sitecode);
      else return;
      const site = await q.executeTakeFirst();
      if (!site || site.review_status === 'draft') return;
      await this.scoped(t)
        .insertInto('discovery_site_changes')
        .values({
          site_id: site.id,
          actor_id: user.id,
          actor_name: user.displayName || user.email,
          entity: c.entity,
          entity_label: c.label ?? null,
          action: c.action,
          detail: c.detail ?? null,
        })
        .execute();
    } catch (e) {
      this.log.warn(`Could not record a ${c.entity} change: ${(e as Error).message}`);
    }
  }

  /**
   * Landing payload for the Data Collection module: the
   * customer-wide calling policies, and every site the caller may see with a
   * per-site rollup of how much has been captured. Per-entity lists (users,
   * numbers, …) are fetched separately, one site at a time, paginated.
   */
  async get(t: TenantContext) {
    const s = this.scoped(t);
    const scope = t.siteScope;
    let sitesQ = s.selectFrom('discovery_sites').selectAll().orderBy('sitecode');
    if (scope) sitesQ = sitesQ.where('id', 'in', scope);

    const [sites, callingPolicies] = await Promise.all([
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
    const pending = sites.length
      ? await this.scoped(t)
          .selectFrom('discovery_site_changes')
          .select('site_id')
          .select(sql<string>`count(*)`.as('n'))
          .where('site_id', 'in', sites.map((x) => x.id))
          .where('acknowledged_at', 'is', null)
          .groupBy('site_id')
          .execute()
      : [];
    const pendingBySite = new Map(pending.map((r) => [r.site_id, Number(r.n)]));
    return {
      callingPolicies,
      siteScope: scope,
      sites: sites.map((x) => ({ ...x, counts: counts[x.id] ?? empty, pendingChanges: pendingBySite.get(x.id) ?? 0 })),
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
    const [callingPolicies, statusRows, pendingChanges] = await Promise.all([
      s.selectFrom('discovery_calling_policies').selectAll().orderBy('name').execute(),
      s
        .selectFrom('phone_numbers as n')
        .innerJoin('discovery_number_ranges as r', 'r.id', 'n.range_id')
        .select('n.status as status')
        .select(sql<string>`count(*)`.as('n'))
        .where('r.sitecode', '=', site.sitecode)
        .groupBy('n.status')
        .execute(),
      s
        .selectFrom('discovery_site_changes')
        .select(sql<string>`count(*)`.as('n'))
        .where('site_id', '=', siteId)
        .where('acknowledged_at', 'is', null)
        .executeTakeFirst(),
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

    const review = {
      status: site.review_status,
      submitted_at: site.submitted_at,
      accepted_at: site.accepted_at,
    };
    return { site, review, pendingChanges: Number(pendingChanges?.n ?? 0), callingPolicies, numberSummary, overview, contactUsers };
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

  /** Active users who can be picked for a site's roles: all staff (super admins, engineers, project managers), plus this customer's own users. */
  async listContactCandidates(t: TenantContext) {
    const rows = await platformDb(this.db)
      .selectFrom('users as u')
      .select(['u.id', 'u.display_name', 'u.email', 'u.role'])
      .where('u.status', '=', 'active')
      .where((eb) =>
        eb.or([
          eb('u.role', 'in', ['SUPER_ADMIN', 'ENGINEER', 'PROJECT_MANAGER']),
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
          throw new ConflictException("Picked people must be active staff or this customer's users.");
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
    await this.trackChange(t, user, {
      siteId,
      entity: 'Site overview',
      action: 'changed',
      detail: [...Object.keys(patch), ...(region !== undefined ? ['region'] : []), ...(contacts ? ['people'] : [])].join(', '),
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

  /* ----------------------------- site review ----------------------------- */

  private async siteForReview(t: TenantContext, siteId: string) {
    assertSiteInScope(t, siteId);
    const site = await this.scoped(t)
      .selectFrom('discovery_sites')
      .select(['id', 'sitecode', 'review_status'])
      .where('id', '=', siteId)
      .executeTakeFirst();
    if (!site) throw new NotFoundException('site not found');
    return site;
  }

  /** Marks a site's Data Collection as submitted for review. Nothing is locked; later changes are recorded for the engineer. */
  async submitSite(t: TenantContext, user: AuthedUser, siteId: string) {
    const site = await this.siteForReview(t, siteId);
    if (site.review_status !== 'draft') {
      throw new ConflictException(`This site is already ${site.review_status}.`);
    }
    const row = await this.scoped(t)
      .updateTable('discovery_sites')
      .set({ review_status: 'submitted', submitted_by: user.id, submitted_at: new Date().toISOString(), accepted_by: null, accepted_at: null })
      .where('id', '=', siteId)
      .returning(['id', 'review_status', 'submitted_at'])
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'discovery.site_submitted', { actor: actorOf(user), targetType: 'discovery_site', targetId: siteId });
    await this.audit.platform('discovery.site_submitted', { actor: actorOf(user), tenantId: t.id, detail: { siteId } });
    return row;
  }

  /** The engineer accepts a submitted site. Changes made up to now count as reviewed. */
  async acceptSite(t: TenantContext, user: AuthedUser, siteId: string) {
    const site = await this.siteForReview(t, siteId);
    if (site.review_status !== 'submitted') {
      throw new ConflictException(`Cannot accept a site that is ${site.review_status}.`);
    }
    const now = new Date().toISOString();
    const row = await this.scoped(t)
      .updateTable('discovery_sites')
      .set({ review_status: 'accepted', accepted_by: user.id, accepted_at: now })
      .where('id', '=', siteId)
      .returning(['id', 'review_status', 'accepted_at'])
      .executeTakeFirstOrThrow();
    await this.acknowledgeAll(t, user, siteId, now);
    await this.audit.tenant(t.schema, 'discovery.site_accepted', { actor: actorOf(user), targetType: 'discovery_site', targetId: siteId });
    await this.audit.platform('discovery.site_accepted', { actor: actorOf(user), tenantId: t.id, detail: { siteId } });
    return row;
  }

  /** Back to draft: the review starts again, and the changes recorded so far are cleared. */
  async reopenSite(t: TenantContext, user: AuthedUser, siteId: string) {
    const site = await this.siteForReview(t, siteId);
    if (site.review_status === 'draft') return { id: site.id, review_status: 'draft' as const };
    const row = await this.scoped(t)
      .updateTable('discovery_sites')
      .set({ review_status: 'draft', submitted_by: null, submitted_at: null, accepted_by: null, accepted_at: null })
      .where('id', '=', siteId)
      .returning(['id', 'review_status'])
      .executeTakeFirstOrThrow();
    await this.acknowledgeAll(t, user, siteId, new Date().toISOString());
    await this.audit.tenant(t.schema, 'discovery.site_reopened', { actor: actorOf(user), targetType: 'discovery_site', targetId: siteId });
    return row;
  }

  private async acknowledgeAll(t: TenantContext, user: AuthedUser, siteId: string, at: string) {
    await this.scoped(t)
      .updateTable('discovery_site_changes')
      .set({ acknowledged_at: at, acknowledged_by: user.id })
      .where('site_id', '=', siteId)
      .where('acknowledged_at', 'is', null)
      .execute();
  }

  /** The engineer has seen the changes recorded since the site was submitted. */
  async acknowledgeSiteChanges(t: TenantContext, user: AuthedUser, siteId: string) {
    await this.siteForReview(t, siteId);
    await this.acknowledgeAll(t, user, siteId, new Date().toISOString());
    await this.audit.tenant(t.schema, 'discovery.site_changes_acknowledged', { actor: actorOf(user), targetType: 'discovery_site', targetId: siteId });
    return { ok: true };
  }

  /** Changes made to a site since it was submitted that nobody has acknowledged yet, newest first. */
  async listSiteChanges(t: TenantContext, siteId: string) {
    await this.siteForReview(t, siteId);
    const s = this.scoped(t);
    const base = s.selectFrom('discovery_site_changes').where('site_id', '=', siteId).where('acknowledged_at', 'is', null);
    const [items, cnt] = await Promise.all([
      base.selectAll().orderBy('changed_at', 'desc').limit(200).execute(),
      base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst(),
    ]);
    return { items, total: Number(cnt?.n ?? 0) };
  }

  /* -------------------------------- sites -------------------------------- */

  async addSite(t: TenantContext, user: AuthedUser, input: DiscoverySiteInput, canReview: boolean) {
    assertCustomerWide(t, 'Sites');
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
    await this.trackChange(t, user, { siteId: id, entity: 'Site details', action: 'changed', label: row.sitecode, detail: Object.keys(set).join(', ') });
    return row;
  }

  async deleteSite(t: TenantContext, user: AuthedUser, id: string, canReview: boolean) {
    assertCustomerWide(t, 'Sites');
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
    await this.trackChange(t, user, { siteId: row.site_id, entity: 'Network (E911)', action: 'added', label: row.subnet });
    return row;
  }

  async updateNetwork(
    t: TenantContext,
    user: AuthedUser,
    id: string,
    patch: Partial<DiscoveryNetworkInput>,
    canReview: boolean,
  ) {
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
    await this.trackChange(t, user, { siteId: row.site_id, entity: 'Network (E911)', action: 'changed', label: row.subnet });
    return row;
  }

  async deleteNetwork(t: TenantContext, user: AuthedUser, id: string, canReview: boolean) {
    await this.assertRowSiteInScope(t, 'discovery_network', id, 'subnet not found');
    const prev = await this.scoped(t).selectFrom('discovery_network').select(['site_id', 'subnet']).where('id', '=', id).executeTakeFirst();
    const res = await this.scoped(t).deleteFrom('discovery_network').where('id', '=', id).executeTakeFirst();
    if (!res.numDeletedRows) throw new NotFoundException('subnet not found');
    await this.audit.tenant(t.schema, 'discovery.network_deleted', {
      actor: actorOf(user),
      targetType: 'discovery_network',
      targetId: id,
    });
    await this.trackChange(t, user, { siteId: prev?.site_id, entity: 'Network (E911)', action: 'removed', label: prev?.subnet });
    return { ok: true };
  }

  /* -------------------------------- flows ------------------------------- */

  async addFlow(t: TenantContext, user: AuthedUser, input: DiscoveryFlowInput, canReview: boolean) {
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
    await this.trackChange(t, user, { siteId: row.site_id, entity: 'Call flow', action: 'added', label: row.name });
    return row;
  }

  async updateFlow(
    t: TenantContext,
    user: AuthedUser,
    id: string,
    patch: Partial<DiscoveryFlowInput>,
    canReview: boolean,
  ) {
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
    await this.trackChange(t, user, { siteId: row.site_id, entity: 'Call flow', action: 'changed', label: row.name });
    return row;
  }

  async deleteFlow(t: TenantContext, user: AuthedUser, id: string, canReview: boolean) {
    await this.assertRowSiteInScope(t, 'discovery_flows', id, 'flow not found');
    const prev = await this.scoped(t).selectFrom('discovery_flows').select(['site_id', 'name']).where('id', '=', id).executeTakeFirst();
    const res = await this.scoped(t).deleteFrom('discovery_flows').where('id', '=', id).executeTakeFirst();
    if (!res.numDeletedRows) throw new NotFoundException('flow not found');
    await this.audit.tenant(t.schema, 'discovery.flow_deleted', {
      actor: actorOf(user),
      targetType: 'discovery_flow',
      targetId: id,
    });
    await this.trackChange(t, user, { siteId: prev?.site_id, entity: 'Call flow', action: 'removed', label: prev?.name });
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
