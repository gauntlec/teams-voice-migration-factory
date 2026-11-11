import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { cooloffDays, coolingUntil, reconcileNumbersWithTeams, refreshNumberConflict, releasedNumber, setNumbersParked, tenantDb, type DB } from '@tvmf/db';
import {
  MAX_RANGE_SIZE,
  type CallingPolicyInput,
  type DiscoveryCapBulkPatchInput,
  type DiscoveryCapInput,
  type DiscoveryListQuery,
  type DiscoveryNumberRangeInput,
  type NumberRangesImportInput,
  type NumberRangesBulkUpdateInput,
  type DiscoveryResourceAccountInput,
  type DiscoveryVoiceAppInput,
  type DiscoveryUserBulkPatchInput,
  type DiscoveryUserInput,
  type ImportUserRow,
  type NumberHolderType,
  type DiscoveryBulkDeleteInput,
  coolingMessage,
  PARKED_NUMBER_MESSAGE,
  parkingInOperationsMessage,
  autoAttendantWizardAnswersSchema,
  autoAttendantWizardProblem,
  callQueueWizardAnswersSchema,
  groupToQueueAnswers,
  mapVisualGroups,
  onlyRingsAGroup,
  toCaptures,
  visualCallFlowProblem,
  visualFlowGroups,
  type SaveVisualCallFlowInput,
  type UpdateVisualCallFlowInput,
  attendantFlowIds,
  visualFlowFromRows,
  type AutoAttendantWizardAnswers,
  type VisualCallFlow,
  type VisualGroup,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import { applyBulkPatch, auditBulkPatch } from '../../common/bulk-patch';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { DataCollectionService } from './data-collection.service';
import { assertCustomerWide, assertSiteInScope } from './site-scope';

type Scoped = ReturnType<typeof tenantDb>;
const actorOf = (u: AuthedUser) => ({ id: u.id, email: u.email });

/** '' -> null, otherwise pass through (dropdowns clear to ''). */
const nz = <T>(v: T | '' | null | undefined): T | null => (v === '' || v == null ? null : v);

/** Last 10 significant digits of a phone string, for loose number matching. */
const numKey = (v: string | null | undefined): string => String(v ?? '').replace(/\D/g, '').slice(-10);

@Injectable()
export class TelephonyService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly base: DataCollectionService,
  ) {}

  private s(t: TenantContext): Scoped {
    return tenantDb(this.db as Kysely<DB>, t.schema);
  }

  /* ========================= site scoping ========================= */

  /** Resolve a sitecode to its site row and check it is in the caller's scope. */
  private async siteByCode(t: TenantContext, sitecode: string) {
    const site = await this.s(t)
      .selectFrom('discovery_sites')
      .select(['id', 'sitecode'])
      .where('sitecode', '=', sitecode)
      .executeTakeFirst();
    if (!site) {
      throw new BadRequestException(`No site with code "${sitecode}". Add the site first.`);
    }
    assertSiteInScope(t, site.id);
    return site;
  }

  /** Throw if the number range is outside the caller's site scope. No-op when unscoped. */
  private async assertRangeInScope(t: TenantContext, rangeId: string) {
    if (!t.siteScope) return;
    const row = await this.s(t)
      .selectFrom('discovery_number_ranges as r')
      .leftJoin('discovery_sites as st', 'st.sitecode', 'r.sitecode')
      .select('st.id as site_id')
      .where('r.id', '=', rangeId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('range not found');
    assertSiteInScope(t, row.site_id);
  }

  /** Throw if the phone number's range is outside the caller's site scope. */
  private async assertNumberInScope(t: TenantContext, numberId: string) {
    if (!t.siteScope) return;
    const row = await this.s(t)
      .selectFrom('phone_numbers as n')
      .innerJoin('discovery_number_ranges as r', 'r.id', 'n.range_id')
      .leftJoin('discovery_sites as st', 'st.sitecode', 'r.sitecode')
      .select('st.id as site_id')
      .where('n.id', '=', numberId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('phone number not found');
    assertSiteInScope(t, row.site_id);
  }

  /** Throw if the holder row (user / cap / resource account) is out of scope. */
  private async assertHolderInScope(
    t: TenantContext,
    table: 'discovery_users' | 'discovery_caps' | 'discovery_resource_accounts' | 'discovery_voice_apps',
    id: string,
    notFound: string,
  ) {
    if (!t.siteScope) return;
    const row = await this.s(t)
      .selectFrom(table)
      .select('site_id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException(notFound);
    assertSiteInScope(t, row.site_id);
  }

  /**
   * Bulk variant of assertHolderInScope - one query for every selected id,
   * rather than the row-at-a-time version. Needed here (and not for Design &
   * Build's bulk edit) because a CUSTOMER "site contact" can hold
   * discovery:write scoped to specific sites, so a bulk request has to be
   * checked defensively even though the UI only ever selects rows already
   * filtered to one site.
   */
  private async assertHolderIdsInScope(t: TenantContext, table: 'discovery_users' | 'discovery_caps', ids: string[]) {
    const rows = await this.s(t).selectFrom(table).select(['id', 'site_id']).where('id', 'in', ids).execute();
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new NotFoundException(`${missing.length} row(s) not found`);
    if (!t.siteScope) return;
    for (const row of rows) assertSiteInScope(t, row.site_id);
  }

  /**
   * Bulk delete for Site Data's Users / CAPs / Resource accounts tabs -
   * the ticked rows, or every row of that kind on one site. Same rules and
   * side effects as deleting each row on its own (Site Data lock, site
   * scope, numbers back to the free pool; Design & Build rows populated from
   * them stay, just unlinked), in one transaction and one audit row.
   */
  async bulkDelete(t: TenantContext, u: AuthedUser, kind: 'user' | 'cap' | 'resource_account' | 'voice_app', body: DiscoveryBulkDeleteInput, canReview: boolean) {
    const table = ({ user: 'discovery_users', cap: 'discovery_caps', resource_account: 'discovery_resource_accounts', voice_app: 'discovery_voice_apps' } as const)[kind];
    let ids: string[];
    let siteId: string | null = null;
    if ('ids' in body) {
      ids = [...new Set(body.ids)];
      const rows = await this.s(t).selectFrom(table).select(['id', 'site_id']).where('id', 'in', ids).execute();
      if (rows.length !== ids.length) throw new NotFoundException(`${ids.length - rows.length} row(s) not found - refresh and try again.`);
      for (const row of rows) assertSiteInScope(t, row.site_id);
    } else {
      siteId = body.site_id;
      assertSiteInScope(t, siteId);
      ids = (await this.s(t).selectFrom(table).select('id').where('site_id', '=', siteId).execute()).map((r) => r.id);
    }
    if (ids.length === 0) return { deleted: 0 };
    const tracked = await this.holderRows(t, table, ids);
    let flowsDeleted = 0;

    await this.db.transaction().execute(async (trx) => {
      const x = tenantDb(trx as unknown as Kysely<DB>, t.schema);
      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        // a voice app holds no numbers (its resource accounts do); the others hand theirs back
        if (kind !== 'voice_app') {
          await x
            .updateTable('phone_numbers')
            .set(releasedNumber())
            .where('holder_type', '=', kind)
            .where('holder_id', 'in', chunk)
            .execute();
        }
        // an auto attendant or call queue's Call flow goes with its voice app
        if (kind === 'voice_app') flowsDeleted += Number((await x.deleteFrom('discovery_flows').where('voice_app_id', 'in', chunk).executeTakeFirst()).numDeletedRows ?? 0);
        await x.deleteFrom(table).where('id', 'in', chunk).execute();
      }
    });
    await this.audit.tenant(t.schema, `discovery.${kind}s_bulk_deleted`, {
      actor: actorOf(u),
      targetType: siteId ? 'discovery_site' : `discovery_${kind}`,
      targetId: siteId ?? undefined,
      detail: { count: ids.length, all: !!siteId, ids: ids.slice(0, 500), ...(kind === 'voice_app' ? { callFlows: flowsDeleted } : {}) },
    });
    await this.trackRows(t, u, tracked, ({ user: 'User', cap: 'Common area phone', resource_account: 'Resource account', voice_app: 'Auto attendant or call queue' } as const)[kind], 'removed');
    return { deleted: ids.length, ...(kind === 'voice_app' ? { callFlowsDeleted: flowsDeleted } : {}) };
  }

  /* ===================== paginated list reads ===================== */

  /** page/limit/offset from a validated list query. */
  private pageOf(q: DiscoveryListQuery) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    return { page, limit, offset: (page - 1) * limit };
  }

  /**
   * The `site_id` values a list should be restricted to: `[siteId]` for a
   * specific site (checked against the caller's scope), the caller's whole
   * scope for a site contact, or `null` (no restriction) for whole-customer.
   */
  private siteIdFilter(t: TenantContext, siteId?: string): string[] | null {
    if (siteId) {
      assertSiteInScope(t, siteId);
      return [siteId];
    }
    return t.siteScope;
  }

  /** Same as `siteIdFilter` but resolved to sitecodes (for ranges / numbers). */
  private async sitecodeFilter(t: TenantContext, siteId?: string): Promise<string[] | null> {
    const ids = this.siteIdFilter(t, siteId);
    if (!ids) return null;
    const rows = await this.s(t)
      .selectFrom('discovery_sites')
      .select('sitecode')
      .where('id', 'in', ids)
      .execute();
    return rows.length ? rows.map((r) => r.sitecode) : ['\x00'];
  }

  /**
   * What the user-import preview needs, read fresh when a file is loaded: the UPNs already on the customer (so rows that were
   * imported before show as such) and every number still free on this site (the full list, not one page of it).
   */
  async userImportContext(t: TenantContext, siteId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId)) throw new BadRequestException('A site is required.');
    assertSiteInScope(t, siteId);
    const s = this.s(t);
    const site = await s.selectFrom('discovery_sites').select('sitecode').where('id', '=', siteId).executeTakeFirst();
    if (!site) throw new BadRequestException('Unknown site for this customer.');

    const sites = this.siteIdFilter(t, undefined);
    let users = s.selectFrom('discovery_users').select('upn');
    if (sites) users = users.where('site_id', 'in', sites);
    const upns = (await users.execute()).map((r) => r.upn.trim().toLowerCase());

    const free = site.sitecode
      ? await s
          .selectFrom('phone_numbers as n')
          .innerJoin('discovery_number_ranges as r', 'r.id', 'n.range_id')
          .select('n.e164 as e164')
          .where('r.sitecode', '=', site.sitecode)
          .where('n.status', '=', 'available')
          .execute()
      : [];
    return { upns, freeNumbers: free.map((r) => r.e164) };
  }

  async listUsers(t: TenantContext, q: DiscoveryListQuery) {
    const s = this.s(t);
    const sites = this.siteIdFilter(t, q.siteId);
    const { page, limit, offset } = this.pageOf(q);
    let b = s.selectFrom('discovery_users');
    if (sites) b = b.where('site_id', 'in', sites);
    if (q.q) {
      const like = `%${q.q}%`;
      b = b.where((eb) => eb.or([eb('upn', 'ilike', like), eb('display_name', 'ilike', like)]));
    }
    if (q.handset) {
      // the same test as needsHandset (@tvmf/shared): marked as needing one, or a model named
      const has = sql<boolean>`(requires_handset or coalesce(btrim(handset_model), '') <> '')`;
      b = b.where(q.handset === 'yes' ? has : sql<boolean>`not ${has}`);
    }
    const [items, cnt] = await Promise.all([
      b.selectAll().orderBy('upn').limit(limit).offset(offset).execute(),
      b.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst(),
    ]);
    const ids = items.map((u) => u.id);
    const nums = ids.length
      ? await s
          .selectFrom('phone_numbers')
          .select(['id', 'e164', 'holder_id'])
          .where('holder_type', '=', 'user')
          .where('holder_id', 'in', ids)
          .execute()
      : [];
    const byHolder = new Map(nums.map((n) => [n.holder_id as string, n]));
    // A requested number the user doesn't hold: why not (bug report "Number not in site Ranges") - it isn't in any of the site's
    // ranges, or it is but someone else has it (or it's parked or reserved).
    const unmet = items.filter((u) => u.requested_number && numKey(u.requested_number) !== '' && numKey(u.requested_number) !== numKey(byHolder.get(u.id)?.e164));
    const keys = [...new Set(unmet.map((u) => numKey(u.requested_number)))];
    const onSites = keys.length
      ? await s
          .selectFrom('phone_numbers as n')
          .innerJoin('discovery_number_ranges as r', 'r.id', 'n.range_id')
          .innerJoin('discovery_sites as ds', 'ds.sitecode', 'r.sitecode')
          .select(['ds.id as site_id', sql<string>`right(regexp_replace(n.e164, '\\D', '', 'g'), 10)`.as('k')])
          .where(sql<boolean>`right(regexp_replace(n.e164, '\\D', '', 'g'), 10) in (${sql.join(keys)})`)
          .execute()
      : [];
    const inSiteRange = new Set(onSites.map((r) => `${r.site_id}|${r.k}`));
    const requestedState = (u: (typeof items)[number]): 'outside_site_ranges' | 'taken' | null =>
      unmet.includes(u) ? (inSiteRange.has(`${u.site_id}|${numKey(u.requested_number)}`) ? 'taken' : 'outside_site_ranges') : null;
    return {
      items: items.map((u) => ({
        ...u,
        phone_number: byHolder.get(u.id)?.e164 ?? null,
        phone_number_id: byHolder.get(u.id)?.id ?? null,
        requested_number_state: requestedState(u),
      })),
      total: Number(cnt?.n ?? 0),
      page,
      limit,
    };
  }

  async listCaps(t: TenantContext, q: DiscoveryListQuery) {
    const s = this.s(t);
    const sites = this.siteIdFilter(t, q.siteId);
    const { page, limit, offset } = this.pageOf(q);
    let b = s.selectFrom('discovery_caps');
    if (sites) b = b.where('site_id', 'in', sites);
    if (q.q) {
      const like = `%${q.q}%`;
      b = b.where((eb) => eb.or([eb('display_name', 'ilike', like), eb('upn', 'ilike', like)]));
    }
    const [items, cnt] = await Promise.all([
      b.selectAll().orderBy('display_name').limit(limit).offset(offset).execute(),
      b.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst(),
    ]);
    const ids = items.map((c) => c.id);
    const nums = ids.length
      ? await s
          .selectFrom('phone_numbers')
          .select(['id', 'e164', 'holder_id'])
          .where('holder_type', '=', 'cap')
          .where('holder_id', 'in', ids)
          .execute()
      : [];
    const byHolder = new Map(nums.map((n) => [n.holder_id as string, n]));
    return {
      items: items.map((c) => ({
        ...c,
        phone_number: byHolder.get(c.id)?.e164 ?? null,
        phone_number_id: byHolder.get(c.id)?.id ?? null,
      })),
      total: Number(cnt?.n ?? 0),
      page,
      limit,
    };
  }

  /** The numbers attached to each of these resource accounts (a resource account can hold several). */
  private async numbersOf(t: TenantContext, raIds: string[]) {
    const byHolder = new Map<string, { id: string; e164: string }[]>();
    if (!raIds.length) return byHolder;
    const nums = await this.s(t)
      .selectFrom('phone_numbers')
      .select(['id', 'e164', 'holder_id'])
      .where('holder_type', '=', 'resource_account')
      .where('holder_id', 'in', raIds)
      .orderBy('e164')
      .execute();
    for (const n of nums) {
      const arr = byHolder.get(n.holder_id as string) ?? [];
      arr.push({ id: n.id, e164: n.e164 });
      byHolder.set(n.holder_id as string, arr);
    }
    return byHolder;
  }

  /** Voice apps (auto attendants and call queues), each with the resource accounts that answer for it. */
  async listVoiceApps(t: TenantContext, q: DiscoveryListQuery) {
    const s = this.s(t);
    const sites = this.siteIdFilter(t, q.siteId);
    const { page, limit, offset } = this.pageOf(q);
    let b = s.selectFrom('discovery_voice_apps');
    if (sites) b = b.where('site_id', 'in', sites);
    if (q.q) b = b.where('name', 'ilike', `%${q.q}%`);
    const [items, cnt] = await Promise.all([
      b.selectAll().orderBy('name').orderBy('id').limit(limit).offset(offset).execute(),
      b.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst(),
    ]);
    const ids = items.map((r) => r.id);
    const ras = ids.length ? await s.selectFrom('discovery_resource_accounts').select(['id', 'name', 'upn', 'voice_app_id']).where('voice_app_id', 'in', ids).orderBy('name').execute() : [];
    const numbers = await this.numbersOf(t, ras.map((r) => r.id));
    const byApp = new Map<string, { id: string; name: string; upn: string | null; numbers: string[] }[]>();
    for (const r of ras) byApp.set(r.voice_app_id as string, [...(byApp.get(r.voice_app_id as string) ?? []), { id: r.id, name: r.name, upn: r.upn, numbers: (numbers.get(r.id) ?? []).map((n) => n.e164) }]);
    // Each voice app's Call flow - its structured capture (wizard answers, Import to Design & Build) - so Site Data shows them as one row.
    const flows = ids.length ? await s.selectFrom('discovery_flows').selectAll().where('voice_app_id', 'in', ids).orderBy('created_at').execute() : [];
    const flowOf = new Map<string, (typeof flows)[number]>();
    for (const f of flows) if (!flowOf.has(f.voice_app_id as string)) flowOf.set(f.voice_app_id as string, f);
    return {
      items: items.map((r) => ({ ...r, resource_accounts: byApp.get(r.id) ?? [], call_flow: flowOf.get(r.id) ?? null })),
      total: Number(cnt?.n ?? 0),
      page,
      limit,
    };
  }

  /** Resource accounts, each with its numbers and the voice app it answers for. */
  async listResourceAccounts(t: TenantContext, q: DiscoveryListQuery) {
    const s = this.s(t);
    const sites = this.siteIdFilter(t, q.siteId);
    const { page, limit, offset } = this.pageOf(q);
    let b = s.selectFrom('discovery_resource_accounts');
    if (sites) b = b.where('site_id', 'in', sites);
    if (q.q) b = b.where((eb) => eb.or([eb('name', 'ilike', `%${q.q}%`), eb('upn', 'ilike', `%${q.q}%`)]));
    const [items, cnt] = await Promise.all([
      b.selectAll().orderBy('name').orderBy('id').limit(limit).offset(offset).execute(),
      b.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst(),
    ]);
    const byHolder = await this.numbersOf(t, items.map((r) => r.id));
    const appIds = [...new Set(items.map((r) => r.voice_app_id).filter((v): v is string => !!v))];
    const apps = appIds.length ? await s.selectFrom('discovery_voice_apps').select(['id', 'name']).where('id', 'in', appIds).execute() : [];
    const appName = new Map(apps.map((a) => [a.id, a.name]));
    // The number Teams has for a discovered resource account, and whether it is attached here: one in none of the site's ranges is shown, not lost.
    const objIds = items.map((r) => r.tenant_object_id).filter((v): v is string => !!v);
    const objs = objIds.length ? await s.selectFrom('tenant_objects').select(['id', 'data']).where('id', 'in', objIds).execute() : [];
    const discovered = new Map(objs.map((o) => [o.id, typeof (o.data as Record<string, unknown>)?.PhoneNumber === 'string' ? ((o.data as Record<string, unknown>).PhoneNumber as string).replace(/^tel:/i, '').split(';')[0]!.trim() || null : null]));
    return {
      items: items.map((r) => {
        const phone_numbers = byHolder.get(r.id) ?? [];
        const discovered_number = r.tenant_object_id ? (discovered.get(r.tenant_object_id) ?? null) : null;
        return {
          ...r,
          phone_numbers,
          voice_app_name: r.voice_app_id ? (appName.get(r.voice_app_id) ?? null) : null,
          discovered_number,
          discovered_number_attached: !!discovered_number && phone_numbers.some((n) => n.e164 === discovered_number),
        };
      }),
      total: Number(cnt?.n ?? 0),
      page,
      limit,
    };
  }

  async listRanges(t: TenantContext, q: DiscoveryListQuery) {
    const s = this.s(t);
    const codes = await this.sitecodeFilter(t, q.siteId);
    const { page, limit, offset } = this.pageOf(q);
    let b = s.selectFrom('discovery_number_ranges');
    if (codes) b = b.where('sitecode', 'in', codes);
    if (q.q) {
      const like = `%${q.q}%`;
      b = b.where((eb) =>
        eb.or([
          eb('range_start', 'ilike', like),
          eb('range_end', 'ilike', like),
          eb('carrier', 'ilike', like),
          eb('sitecode', 'ilike', like),
        ]),
      );
    }
    const [items, cnt] = await Promise.all([
      b.selectAll().orderBy('sitecode').orderBy('range_start').limit(limit).offset(offset).execute(),
      b.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst(),
    ]);
    const ids = items.map((r) => r.id);
    const grp = ids.length
      ? await s
          .selectFrom('phone_numbers')
          .select('range_id')
          .select(sql<string>`count(*)`.as('total'))
          .select(sql<string>`count(*) filter (where status = 'assigned')`.as('assigned'))
          .select(sql<string>`count(*) filter (where status = 'reserved')`.as('reserved'))
          .select(sql<string>`count(*) filter (where status = 'parked')`.as('parked'))
          .where('range_id', 'in', ids)
          .groupBy('range_id')
          .execute()
      : [];
    const byRange = new Map(
      grp.map((g) => [
        g.range_id,
        { total: Number(g.total), assigned: Number(g.assigned), reserved: Number(g.reserved), parked: Number(g.parked) },
      ]),
    );
    return {
      items: items.map((r) => ({
        ...r,
        counts: byRange.get(r.id) ?? { total: 0, assigned: 0, reserved: 0, parked: 0 },
      })),
      total: Number(cnt?.n ?? 0),
      page,
      limit,
    };
  }

  async listNumbers(t: TenantContext, q: DiscoveryListQuery) {
    const s = this.s(t);
    const codes = await this.sitecodeFilter(t, q.siteId);
    const { page, limit, offset } = this.pageOf(q);
    let b = s
      .selectFrom('phone_numbers as n')
      .innerJoin('discovery_number_ranges as r', 'r.id', 'n.range_id');
    if (codes) b = b.where('r.sitecode', 'in', codes);
    if (q.status) b = b.where('n.status', '=', q.status);
    if (q.q) {
      // The number, or who holds it: the user's UPN and display name, the common area phone's, or the resource account's name.
      const like = `%${q.q}%`;
      b = b.where((eb) =>
        eb.or([
          eb('n.e164', 'ilike', like),
          sql<boolean>`(n.holder_type = 'user' and exists (select 1 from ${sql.table(`${t.schema}.discovery_users`)} hu where hu.id = n.holder_id and (hu.upn ilike ${like} or hu.display_name ilike ${like})))`,
          sql<boolean>`(n.holder_type = 'cap' and exists (select 1 from ${sql.table(`${t.schema}.discovery_caps`)} hc where hc.id = n.holder_id and (hc.upn ilike ${like} or hc.display_name ilike ${like})))`,
          sql<boolean>`(n.holder_type = 'resource_account' and exists (select 1 from ${sql.table(`${t.schema}.discovery_resource_accounts`)} hr where hr.id = n.holder_id and (hr.name ilike ${like} or hr.upn ilike ${like})))`,
        ]),
      );
    }
    const [items, cnt] = await Promise.all([
      b
        .select([
          'n.id as id',
          'n.e164 as e164',
          'n.status as status',
          'n.holder_type as holder_type',
          'n.holder_id as holder_id',
          'n.cooling_until as cooling_until',
          'n.cooling_reason as cooling_reason',
          'n.live_status as live_status',
          'n.live_holder_kind as live_holder_kind',
          'n.live_holder_upn as live_holder_upn',
          'n.live_holder_name as live_holder_name',
          'n.live_only as live_only',
          'n.conflict as conflict',
          'n.parked_at as parked_at',
          'n.range_id as range_id',
          'r.range_start as range_start',
          'r.range_end as range_end',
          'r.sitecode as sitecode',
        ])
        .orderBy('n.e164')
        .limit(limit)
        .offset(offset)
        .execute(),
      b.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst(),
    ]);
    // resolve holder display names for this page
    const byType: Record<string, string[]> = { user: [], cap: [], resource_account: [] };
    for (const n of items) if (n.holder_id && n.holder_type && byType[n.holder_type]) byType[n.holder_type].push(n.holder_id);
    const names = new Map<string, string>();
    if (byType.user.length) {
      for (const u of await s.selectFrom('discovery_users').select(['id', 'upn', 'display_name']).where('id', 'in', byType.user).execute())
        names.set(u.id, u.display_name || u.upn);
    }
    if (byType.cap.length) {
      for (const c of await s.selectFrom('discovery_caps').select(['id', 'display_name']).where('id', 'in', byType.cap).execute())
        names.set(c.id, c.display_name);
    }
    if (byType.resource_account.length) {
      for (const r of await s.selectFrom('discovery_resource_accounts').select(['id', 'name']).where('id', 'in', byType.resource_account).execute())
        names.set(r.id, r.name);
    }
    return {
      items: items.map((n) => ({ ...n, holder_name: n.holder_id ? names.get(n.holder_id) ?? null : null })),
      total: Number(cnt?.n ?? 0),
      page,
      limit,
    };
  }

  /** e164 -> sitecode for every number in the tenant, regardless of status -
   * deliberately unpaginated (two columns, cheap) since a caller needs the
   * full picture to tell a cross-site number apart from one nobody owns. */
  async listNumberSiteMap(t: TenantContext) {
    return this.s(t)
      .selectFrom('phone_numbers as n')
      .innerJoin('discovery_number_ranges as r', 'r.id', 'n.range_id')
      .select(['n.e164 as e164', 'r.sitecode as sitecode'])
      .execute();
  }

  /* ====================== calling policies ====================== */

  async addCallingPolicy(t: TenantContext, u: AuthedUser, i: CallingPolicyInput, canReview: boolean) {
    assertCustomerWide(t, 'Outbound calling policies');
    try {
      const row = await this.s(t)
        .insertInto('discovery_calling_policies')
        .values({
          name: i.name,
          description: nz(i.description),
          allow_local: i.allow_local ?? true,
          allow_national: i.allow_national ?? false,
          allow_international: i.allow_international ?? false,
          allow_service: i.allow_service ?? true,
          allow_premium: i.allow_premium ?? false,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.tenant(t.schema, 'discovery.calling_policy_added', {
        actor: actorOf(u),
        targetType: 'calling_policy',
        targetId: row.id,
      });
      return row;
    } catch (e) {
      throw this.dupName(e, 'calling policy');
    }
  }

  async updateCallingPolicy(
    t: TenantContext,
    u: AuthedUser,
    id: string,
    patch: Partial<CallingPolicyInput>,
    canReview: boolean,
  ) {
    assertCustomerWide(t, 'Outbound calling policies');
    const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of [
      'name',
      'description',
      'allow_local',
      'allow_national',
      'allow_international',
      'allow_service',
      'allow_premium',
    ] as const) {
      if (k in patch) set[k] = k === 'description' ? nz(patch[k]) : patch[k];
    }
    const row = await this.s(t)
      .updateTable('discovery_calling_policies')
      .set(set)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('calling policy not found');
    await this.audit.tenant(t.schema, 'discovery.calling_policy_updated', {
      actor: actorOf(u),
      targetType: 'calling_policy',
      targetId: id,
    });
    return row;
  }

  async deleteCallingPolicy(t: TenantContext, u: AuthedUser, id: string, canReview: boolean) {
    assertCustomerWide(t, 'Outbound calling policies');
    const res = await this.s(t).deleteFrom('discovery_calling_policies').where('id', '=', id).executeTakeFirst();
    if (!Number(res.numDeletedRows)) throw new NotFoundException('calling policy not found');
    await this.audit.tenant(t.schema, 'discovery.calling_policy_deleted', {
      actor: actorOf(u),
      targetType: 'calling_policy',
      targetId: id,
    });
    return { ok: true };
  }

  /* ========================= number ranges ========================= */

  async addRange(t: TenantContext, u: AuthedUser, i: DiscoveryNumberRangeInput, canReview: boolean) {
    const e164s = expandRange(i.range_start, i.range_end);
    if (i.kind === 'port' && !nz(i.new_carrier)) throw new BadRequestException('Say which carrier these numbers are moving to (the new carrier).');
    await this.siteByCode(t, i.sitecode);
    const { range, generated } = await this.insertRange(t, u, i, e164s);
    await this.syncNumbersWithTeams(t);
    await this.base.trackChange(t, u, { sitecode: i.sitecode, entity: 'Number range', action: 'added', label: `${i.range_start} – ${i.range_end}` });
    return { range, generated, skipped: e164s.length - generated };
  }

  /**
   * Numbers follow Teams (number-reconcile.ts): after the ranges change, bring the inventory in line with what the last Discovery
   * sync stored, so a new range's numbers that are live in Teams show as assigned now, not at the next sync. Best-effort.
   */
  private async syncNumbersWithTeams(t: TenantContext) {
    try {
      await reconcileNumbersWithTeams(this.s(t), { releaseMissing: false });
    } catch {
      // the next Discovery sync does it
    }
  }

  /** Insert one range row plus its generated numbers (numbers already in the inventory are left alone). */
  private async insertRange(t: TenantContext, u: AuthedUser, i: DiscoveryNumberRangeInput, e164s: string[]) {
    const range = await this.s(t)
      .insertInto('discovery_number_ranges')
      .values({
        sitecode: i.sitecode,
        range_start: i.range_start,
        range_end: i.range_end,
        kind: i.kind,
        carrier: nz(i.carrier),
        new_carrier: i.kind === 'port' ? nz(i.new_carrier) : null,
        loa_sent: i.loa_sent ?? false,
        loa_completed: i.loa_completed ?? false,
        comments: nz(i.comments),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    let generated = 0;
    for (let k = 0; k < e164s.length; k += 500) {
      const chunk = e164s.slice(k, k + 500).map((e164) => ({ range_id: range.id, e164 }));
      const inserted = await this.s(t)
        .insertInto('phone_numbers')
        .values(chunk)
        .onConflict((oc) => oc.column('e164').doNothing())
        .returning('id')
        .execute();
      generated += inserted.length;
      // A number Discovery found in Teams before anyone owned it sits in a range with no site; the new range now owns it.
      const moved = await this.s(t)
        .updateTable('phone_numbers')
        .set({ range_id: range.id })
        .where('e164', 'in', chunk.map((c) => c.e164))
        .where('live_status', 'is not', null)
        .where('range_id', 'in', (eb) => eb.selectFrom('discovery_number_ranges').select('id').where('sitecode', 'is', null).where('id', '<>', range.id))
        .returning('id')
        .execute();
      generated += moved.length;
    }
    // ...and a "Found in Teams" range left with no numbers is removed.
    await this.s(t)
      .deleteFrom('discovery_number_ranges')
      .where('sitecode', 'is', null)
      .where('comments', 'like', 'Found in Teams by Discovery%')
      .where((eb) => eb.not(eb.exists(eb.selectFrom('phone_numbers').select('id').whereRef('phone_numbers.range_id', '=', 'discovery_number_ranges.id'))))
      .execute();

    await this.audit.tenant(t.schema, 'discovery.range_added', {
      actor: actorOf(u),
      targetType: 'discovery_number_range',
      targetId: range.id,
      detail: { requested: e164s.length, generated },
    });
    return { range, generated };
  }

  /**
   * Bulk-create ranges for one site from spreadsheet rows (DID-START / DID-END). Each row is
   * checked on its own: a bad row is reported and the rest still go in, and a row whose numbers
   * are all in the inventory already is skipped, so a half-finished import can be run again.
   */
  async importRanges(t: TenantContext, u: AuthedUser, input: NumberRangesImportInput, canReview: boolean) {
    assertSiteInScope(t, input.site_id);
    // a port row needs its new carrier: its own, or the one chosen for every row (checked per row below)
    const site = await this.s(t)
      .selectFrom('discovery_sites')
      .select(['id', 'sitecode'])
      .where('id', '=', input.site_id)
      .executeTakeFirst();
    if (!site?.sitecode) throw new BadRequestException('Unknown site for this customer.');

    let created = 0;
    let numbers = 0;
    let skipped = 0;
    const errors: { row: number; message: string }[] = [];
    for (let idx = 0; idx < input.rows.length; idx++) {
      const row = input.rows[idx];
      try {
        const kind = row.kind ?? input.kind;
        const newCarrier = nz(row.new_carrier) ?? nz(input.new_carrier);
        if (kind === 'port' && !newCarrier) throw new Error('A port needs the carrier the numbers are moving to (NEW CARRIER).');
        const e164s = expandRange(row.range_start, row.range_end);
        const existing = new Set<string>();
        for (let k = 0; k < e164s.length; k += 1000) {
          const found = await this.s(t)
            .selectFrom('phone_numbers as n')
            .innerJoin('discovery_number_ranges as r', 'r.id', 'n.range_id')
            .select(['n.e164 as e164', 'n.live_status as live_status', 'r.sitecode as sitecode'])
            .where('n.e164', 'in', e164s.slice(k, k + 1000))
            .execute();
          // a number only found in Teams (no site) is not "already in the inventory": the new range takes it over
          for (const f of found) if (f.sitecode || !f.live_status) existing.add(f.e164);
        }
        if (existing.size === e164s.length) {
          skipped += 1;
          continue;
        }
        const { generated } = await this.insertRange(
          t,
          u,
          {
            sitecode: site.sitecode,
            range_start: row.range_start,
            range_end: row.range_end,
            kind,
            carrier: nz(row.carrier) ?? input.carrier,
            new_carrier: newCarrier ?? undefined,
            comments: nz(row.comments) ?? undefined,
          },
          e164s,
        );
        created += 1;
        numbers += generated;
      } catch (e) {
        errors.push({ row: idx + 1, message: (e as Error).message });
      }
    }

    await this.audit.tenant(t.schema, 'discovery.ranges_imported', {
      actor: actorOf(u),
      targetType: 'discovery_site',
      targetId: site.id,
      detail: { created, numbers, skipped, failed: errors.length },
    });
    if (created > 0) await this.syncNumbersWithTeams(t);
    if (created > 0) await this.base.trackChange(t, u, { siteId: site.id, entity: 'Number range', action: 'added', label: `${created} range${created === 1 ? '' : 's'} imported`, detail: `${numbers} numbers` });
    return { created, numbers, skipped, errors };
  }

  async updateRange(
    t: TenantContext,
    u: AuthedUser,
    id: string,
    patch: Partial<DiscoveryNumberRangeInput>,
    canReview: boolean,
  ) {
    await this.assertRangeInScope(t, id);
    // Bounds are fixed once numbers are generated - recreate the range to change them.
    const set: Record<string, unknown> = {};
    for (const k of ['kind', 'carrier', 'new_carrier', 'loa_sent', 'loa_completed', 'comments', 'sitecode'] as const) {
      if (k in patch) set[k] = k === 'carrier' || k === 'new_carrier' || k === 'comments' ? nz(patch[k]) : patch[k];
    }
    if (typeof set.sitecode === 'string') await this.siteByCode(t, set.sitecode);
    // A range that is moving to a new carrier must say which. (A range already ported keeps what it has.)
    if ('kind' in set || 'new_carrier' in set) {
      const cur = await this.s(t).selectFrom('discovery_number_ranges').select(['kind', 'new_carrier', 'port_completed_at']).where('id', '=', id).executeTakeFirst();
      const kind = (set.kind ?? cur?.kind) as string | undefined;
      const newCarrier = 'new_carrier' in set ? (set.new_carrier as string | null) : cur?.new_carrier;
      if (kind === 'port' && !newCarrier && !cur?.port_completed_at) throw new BadRequestException('Say which carrier these numbers are moving to (the new carrier).');
    }
    const row = await this.s(t)
      .updateTable('discovery_number_ranges')
      .set(set)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('range not found');
    await this.audit.tenant(t.schema, 'discovery.range_updated', {
      actor: actorOf(u),
      targetType: 'discovery_number_range',
      targetId: id,
    });
    await this.base.trackChange(t, u, { sitecode: row.sitecode, entity: 'Number range', action: 'changed', label: `${row.range_start} – ${row.range_end}`, detail: Object.keys(set).join(', ') });
    return row;
  }

  /**
   * The same change to several ranges (bug report "Number Range Import from Excel": tick any number of ranges and change, say, their
   * Number transition). Each range goes through updateRange, so each is checked as editing it alone would be; one that can't change is
   * reported and the rest still change.
   */
  async bulkUpdateRanges(t: TenantContext, u: AuthedUser, input: NumberRangesBulkUpdateInput, canReview: boolean) {
    const patch: Partial<DiscoveryNumberRangeInput> = {};
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.carrier !== undefined) patch.carrier = input.carrier;
    if (input.new_carrier !== undefined) patch.new_carrier = input.new_carrier;
    if (Object.keys(patch).length === 0) throw new BadRequestException('Choose what to change.');
    let updated = 0;
    const errors: { id: string; range: string | null; message: string }[] = [];
    for (const id of [...new Set(input.ids)]) {
      try {
        await this.updateRange(t, u, id, patch, canReview);
        updated += 1;
      } catch (e) {
        const r = await this.s(t).selectFrom('discovery_number_ranges').select(['range_start', 'range_end']).where('id', '=', id).executeTakeFirst();
        errors.push({ id, range: r ? `${r.range_start} – ${r.range_end}` : null, message: (e as Error).message });
      }
    }
    return { updated, errors };
  }

  async deleteRange(t: TenantContext, u: AuthedUser, id: string, canReview: boolean) {
    await this.assertRangeInScope(t, id);
    const prevRange = await this.s(t).selectFrom('discovery_number_ranges').select(['sitecode', 'range_start', 'range_end']).where('id', '=', id).executeTakeFirst();
    const inUse = await this.s(t)
      .selectFrom('phone_numbers')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('range_id', '=', id)
      .where('status', '<>', 'available')
      .executeTakeFirstOrThrow();
    if (Number(inUse.n) > 0) {
      throw new ConflictException(
        `${inUse.n} number(s) from this range are assigned, reserved or parked. Release them first.`,
      );
    }
    await this.s(t).deleteFrom('phone_numbers').where('range_id', '=', id).execute();
    const res = await this.s(t).deleteFrom('discovery_number_ranges').where('id', '=', id).executeTakeFirst();
    if (!Number(res.numDeletedRows)) throw new NotFoundException('range not found');
    await this.audit.tenant(t.schema, 'discovery.range_deleted', {
      actor: actorOf(u),
      targetType: 'discovery_number_range',
      targetId: id,
    });
    await this.syncNumbersWithTeams(t);
    if (prevRange) await this.base.trackChange(t, u, { sitecode: prevRange.sitecode, entity: 'Number range', action: 'removed', label: `${prevRange.range_start} – ${prevRange.range_end}` });
    return { ok: true };
  }

  /** Number cool-off (number-cooloff.ts): end it early so a released number can be reused now. */
  async endNumberCooloff(t: TenantContext, u: AuthedUser, id: string, reason: string) {
    await this.assertNumberInScope(t, id);
    const n = await this.s(t).selectFrom('phone_numbers').select(['e164', 'cooling_until']).where('id', '=', id).executeTakeFirst();
    if (!n) throw new NotFoundException('phone number not found');
    await this.s(t).updateTable('phone_numbers').set({ cooling_until: null, cooling_reason: null }).where('id', '=', id).execute();
    await this.audit.tenant(t.schema, 'discovery.number_cooloff_ended', {
      actor: actorOf(u),
      targetType: 'phone_number',
      targetId: id,
      detail: { e164: n.e164, was: n.cooling_until, reason },
    });
    return { ok: true };
  }

  async numberPolicy(t: TenantContext) {
    return { cooloff_days: await cooloffDays(this.s(t)) };
  }

  async updateNumberPolicy(t: TenantContext, u: AuthedUser, days: number) {
    const s = this.s(t);
    await s.insertInto('number_policy').values({ id: true, cooloff_days: days }).onConflict((oc) => oc.column('id').doUpdateSet({ cooloff_days: days })).execute();
    await this.audit.tenant(t.schema, 'discovery.number_policy_updated', { actor: actorOf(u), targetType: 'number_policy', targetId: 'cooloff', detail: { cooloff_days: days } });
    return { cooloff_days: days };
  }

  async reserveNumber(t: TenantContext, u: AuthedUser, id: string, reserved: boolean, canReview: boolean) {
    await this.assertNumberInScope(t, id);
    const n = await this.s(t).selectFrom('phone_numbers').selectAll().where('id', '=', id).executeTakeFirst();
    if (!n) throw new NotFoundException('phone number not found');
    if (n.status === 'assigned') throw new ConflictException('That number is assigned to a holder.');
    const row = await this.s(t)
      .updateTable('phone_numbers')
      .set({ status: reserved ? 'reserved' : 'available' })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, reserved ? 'discovery.number_reserved' : 'discovery.number_released', {
      actor: actorOf(u),
      targetType: 'phone_number',
      targetId: id,
    });
    const owner = await this.s(t).selectFrom('discovery_number_ranges').select('sitecode').where('id', '=', row.range_id).executeTakeFirst();
    await this.base.trackChange(t, u, { sitecode: owner?.sitecode, entity: 'Number', action: 'changed', label: row.e164, detail: reserved ? 'reserved' : 'released' });
    return row;
  }

  /**
   * Parks a spare number, or brings a parked one back into use (number-parking.ts). Only while the site is in project mode:
   * once it is in operations a "Park or unpark phone numbers" service request does it.
   */
  async parkNumber(t: TenantContext, u: AuthedUser, id: string, parked: boolean) {
    await this.assertNumberInScope(t, id);
    const site = await this.s(t)
      .selectFrom('phone_numbers as n')
      .innerJoin('discovery_number_ranges as r', 'r.id', 'n.range_id')
      .leftJoin('discovery_sites as st', 'st.sitecode', 'r.sitecode')
      .select(['r.sitecode as sitecode', 'st.mode as mode'])
      .where('n.id', '=', id)
      .executeTakeFirst();
    if (!site) throw new NotFoundException('phone number not found');
    if (site.mode === 'operations') throw new ConflictException(parkingInOperationsMessage(site.sitecode ?? 'This site'));
    const r = await this.db.transaction().execute((trx) => setNumbersParked(tenantDb(trx as unknown as Kysely<DB>, t.schema), [id], parked, u.id));
    if (r.blocked.length) throw new ConflictException(r.blocked.join(' '));
    const e164 = r.changed[0]!.e164;
    await this.audit.tenant(t.schema, parked ? 'discovery.number_parked' : 'discovery.number_unparked', {
      actor: actorOf(u),
      targetType: 'phone_number',
      targetId: id,
      detail: { e164 },
    });
    await this.base.trackChange(t, u, { sitecode: site.sitecode ?? undefined, entity: 'Number', action: 'changed', label: e164, detail: parked ? 'parked' : 'back in use' });
    return this.s(t).selectFrom('phone_numbers').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  }

  /* ==================== atomic assignment core ==================== */

  private async claimNumber(t: TenantContext, numberId: string, holderType: NumberHolderType, holderId: string) {
    const cooling = await coolingUntil(this.s(t), numberId);
    if (cooling) throw new ConflictException(coolingMessage(cooling));
    const res = await this.s(t)
      .updateTable('phone_numbers')
      .set({ holder_type: holderType, holder_id: holderId, status: 'assigned', live_only: false })
      .where('id', '=', numberId)
      .where('holder_id', 'is', null)
      // free (a free number Teams still has included), or assigned only because Teams has it (number-reconcile.ts): a holder in Site Data
      // takes it over, and any clash with Teams is flagged
      .where((eb) => eb.or([eb('status', '=', 'available'), eb('live_only', '=', true)]))
      .executeTakeFirst();
    if (!Number(res.numUpdatedRows)) {
      const n = await this.s(t)
        .selectFrom('phone_numbers')
        .select(['status', 'live_status', 'live_holder_name', 'live_holder_upn'])
        .where('id', '=', numberId)
        .executeTakeFirst();
      if (!n) throw new NotFoundException('phone number not found');
      throw new ConflictException(
        n.status === 'reserved' ? 'That number is reserved.' : n.status === 'parked' ? PARKED_NUMBER_MESSAGE : n.live_status ? `That number is in use in Teams (${n.live_holder_name ?? n.live_holder_upn ?? 'another object'}).` : 'That number is already assigned.',
      );
    }
    await refreshNumberConflict(this.s(t), numberId);
  }

  private async releaseHolder(t: TenantContext, holderType: NumberHolderType, holderId: string) {
    await this.s(t)
      .updateTable('phone_numbers')
      .set(releasedNumber())
      .where('holder_type', '=', holderType)
      .where('holder_id', '=', holderId)
      .execute();
  }

  /** 1:1 holders (user / cap): reconcile to exactly `numberId` (or none). */
  private async setSingleNumber(
    t: TenantContext,
    holderType: NumberHolderType,
    holderId: string,
    numberId: string | null,
  ) {
    const current = await this.s(t)
      .selectFrom('phone_numbers')
      .select('id')
      .where('holder_type', '=', holderType)
      .where('holder_id', '=', holderId)
      .executeTakeFirst();
    if ((current?.id ?? null) === numberId) return;
    if (current) await this.releaseHolder(t, holderType, holderId);
    if (numberId) await this.claimNumber(t, numberId, holderType, holderId);
  }

  /**
   * Validate an incoming holder `site_id`: it must exist in this customer and,
   * for a site contact, be one of their sites (they must always name one).
   * Returns the id to store (or null for a whole-customer caller who left it blank).
   */
  private async resolveHolderSite(
    t: TenantContext,
    siteId: string | null | undefined,
  ): Promise<string | null> {
    const id = nz(siteId ?? null) as string | null;
    if (id == null) {
      assertSiteInScope(t, null); // a site contact must pick a site
      return null;
    }
    const site = await this.s(t)
      .selectFrom('discovery_sites')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!site) throw new BadRequestException('Unknown site for this customer.');
    assertSiteInScope(t, id);
    return id;
  }

  /* ============================= users ============================= */

  /**
   * Discovery link: the real tenant user (from the last Discovery run) whose UPN
   * matches, or null. Purely additive - Site Data works without a run.
   */
  private async tenantUserIdFor(t: TenantContext, upn: string | null | undefined) {
    if (!upn) return null;
    const row = await this.s(t)
      .selectFrom('tenant_users')
      .select('id')
      .where(sql`lower(upn)`, '=', upn.trim().toLowerCase())
      .where('removed_at', 'is', null)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  async addUser(t: TenantContext, u: AuthedUser, i: DiscoveryUserInput, canReview: boolean) {
    const siteId = await this.resolveHolderSite(t, i.site_id);
    if (nz(i.phone_number_id)) await this.assertNumberInScope(t, nz(i.phone_number_id)!);
    const tenantUserId = await this.tenantUserIdFor(t, i.upn);
    let row;
    try {
      row = await this.s(t)
        .insertInto('discovery_users')
        .values({
          site_id: siteId,
          upn: i.upn,
          tenant_user_id: tenantUserId,
          display_name: nz(i.display_name),
          calling_policy_id: nz(i.calling_policy_id),
          caller_id: nz(i.caller_id),
          voicemail_enabled: i.voicemail_enabled ?? true,
          voicemail_language: nz(i.voicemail_language),
          call_forwarding: i.call_forwarding ?? null,
          requires_handset: i.requires_handset ?? false,
          handset_model: nz(i.handset_model),
          access_port_id: nz(i.access_port_id),
          comments: nz(i.comments),
          requested_number: nz(i.requested_number),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (e) {
      throw this.dupName(e, 'user (UPN)');
    }
    if (i.phone_number_id !== undefined) {
      await this.setSingleNumber(t, 'user', row.id, nz(i.phone_number_id));
    }
    await this.audit.tenant(t.schema, 'discovery.user_added', {
      actor: actorOf(u),
      targetType: 'discovery_user',
      targetId: row.id,
    });
    await this.base.trackChange(t, u, { siteId: row.site_id, entity: 'User', action: 'added', label: row.upn });
    return row;
  }

  async updateUser(
    t: TenantContext,
    u: AuthedUser,
    id: string,
    patch: Partial<DiscoveryUserInput>,
    canReview: boolean,
  ) {
    await this.assertHolderInScope(t, 'discovery_users', id, 'user not found');
    const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of [
      'upn',
      'display_name',
      'calling_policy_id',
      'caller_id',
      'voicemail_enabled',
      'voicemail_language',
      'requires_handset',
      'handset_model',
      'access_port_id',
      'comments',
      'requested_number',
    ] as const) {
      if (k in patch) set[k] = typeof patch[k] === 'boolean' ? patch[k] : nz(patch[k] as string);
    }
    if ('call_forwarding' in patch) set.call_forwarding = patch.call_forwarding ?? null;
    // a changed UPN re-resolves the Discovery link
    if ('upn' in patch) set.tenant_user_id = await this.tenantUserIdFor(t, patch.upn);
    if ('site_id' in patch) set.site_id = await this.resolveHolderSite(t, patch.site_id);
    if ('phone_number_id' in patch && nz(patch.phone_number_id ?? null)) {
      await this.assertNumberInScope(t, nz(patch.phone_number_id ?? null)!);
    }
    const row = await this.s(t)
      .updateTable('discovery_users')
      .set(set)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('user not found');
    if ('phone_number_id' in patch) {
      await this.setSingleNumber(t, 'user', id, nz(patch.phone_number_id ?? null));
    }
    await this.audit.tenant(t.schema, 'discovery.user_updated', {
      actor: actorOf(u),
      targetType: 'discovery_user',
      targetId: id,
    });
    await this.base.trackChange(t, u, { siteId: row.site_id, entity: 'User', action: 'changed', label: row.upn, detail: Object.keys(patch).join(', ') });
    return row;
  }

  /** Select many users, set a handful of fields once, apply to all of them -
   * see applyBulkPatch (shared with Design & Build's identical action). */
  async bulkUpdateUsers(t: TenantContext, u: AuthedUser, body: DiscoveryUserBulkPatchInput, canReview: boolean) {
    await this.assertHolderIdsInScope(t, 'discovery_users', body.ids);
    const tracked = await this.holderRows(t, 'discovery_users', body.ids);
    const { updated, appliedPatch } = await applyBulkPatch(this.s(t), 'discovery_users', body.ids, body.patch);
    await auditBulkPatch(this.audit, t.schema, 'discovery.users_bulk_updated', {
      actor: actorOf(u),
      targetType: 'discovery_user',
      ids: body.ids,
      updated,
      patch: appliedPatch,
    });
    await this.trackRows(t, u, tracked, 'User', 'changed', Object.keys(appliedPatch).join(', '));
    return { updated };
  }

  async deleteUser(t: TenantContext, u: AuthedUser, id: string, canReview: boolean) {
    await this.assertHolderInScope(t, 'discovery_users', id, 'user not found');
    const tracked = await this.holderRows(t, 'discovery_users', [id]);
    await this.releaseHolder(t, 'user', id);
    const res = await this.s(t).deleteFrom('discovery_users').where('id', '=', id).executeTakeFirst();
    if (!Number(res.numDeletedRows)) throw new NotFoundException('user not found');
    await this.audit.tenant(t.schema, 'discovery.user_deleted', {
      actor: actorOf(u),
      targetType: 'discovery_user',
      targetId: id,
    });
    await this.trackRows(t, u, tracked, 'User', 'removed');
    return { ok: true };
  }

  /**
   * Link every not-yet-linked user for one site to the tenant user with the same
   * UPN (from the last Discovery run), and refresh the display name for users
   * already linked. `unmatched` is how many unlinked users still have no live
   * tenant user. Discovery is the true source of what the customer's directory
   * actually calls this person, so every click of "Link to tenant" - not just
   * the initial link - overwrites whatever name Site Data had (typed by
   * hand, or from an Excel import) with the live tenant user's name. COALESCE
   * keeps the existing name only for the edge case where the live tenant user
   * has none recorded.
   */
  async relinkUsers(t: TenantContext, u: AuthedUser, siteId: string, canReview: boolean) {
    assertSiteInScope(t, siteId);
    const s = this.s(t);
    const tenantUsersRef = sql.table(`${t.schema}.tenant_users`);

    const res = await s
      .updateTable('discovery_users')
      .set({
        tenant_user_id: sql`(SELECT tu.id FROM ${tenantUsersRef} tu
                              WHERE lower(tu.upn) = lower(${sql.ref('discovery_users.upn')})
                                AND tu.removed_at IS NULL LIMIT 1)`,
        display_name: sql`COALESCE(
                              (SELECT tu.display_name FROM ${tenantUsersRef} tu
                               WHERE lower(tu.upn) = lower(${sql.ref('discovery_users.upn')})
                                 AND tu.removed_at IS NULL LIMIT 1),
                              ${sql.ref('discovery_users.display_name')}
                            )`,
        updated_at: new Date().toISOString(),
      })
      .where('site_id', '=', siteId)
      .where('tenant_user_id', 'is', null)
      .where(
        sql<boolean>`EXISTS (SELECT 1 FROM ${tenantUsersRef} tu
                     WHERE lower(tu.upn) = lower(${sql.ref('discovery_users.upn')})
                       AND tu.removed_at IS NULL)`,
      )
      .executeTakeFirst();
    const linked = Number(res.numUpdatedRows ?? 0);

    // Already-linked users: re-sync the name from their linked tenant user
    // (not a UPN re-match - the link itself doesn't change here).
    await s
      .updateTable('discovery_users')
      .set({
        display_name: sql`COALESCE(
                              (SELECT tu.display_name FROM ${tenantUsersRef} tu
                               WHERE tu.id = ${sql.ref('discovery_users.tenant_user_id')}
                                 AND tu.removed_at IS NULL),
                              ${sql.ref('discovery_users.display_name')}
                            )`,
        updated_at: new Date().toISOString(),
      })
      .where('site_id', '=', siteId)
      .where('tenant_user_id', 'is not', null)
      .executeTakeFirst();

    const [{ n }] = await s
      .selectFrom('discovery_users')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('site_id', '=', siteId)
      .where('tenant_user_id', 'is', null)
      .execute();
    const unmatched = Number(n);

    await this.audit.tenant(t.schema, 'discovery.users_relinked', {
      actor: actorOf(u),
      targetType: 'discovery_site',
      targetId: siteId,
      detail: { linked, unmatched },
    });
    return { linked, unmatched };
  }

  /**
   * Bulk-create users for one site from parsed spreadsheet rows. Per row:
   * de-dup on UPN (case-insensitive), resolve the calling-policy *name* to an id,
   * store the requested number verbatim and link a free inventory number for the
   * site when it matches. Not transactional - a partial import is re-runnable
   * (existing UPNs are skipped).
   */
  async importUsers(
    t: TenantContext,
    u: AuthedUser,
    siteId: string,
    rows: ImportUserRow[],
    canReview: boolean,
  ) {
    assertSiteInScope(t, siteId);
    const s = this.s(t);

    const site = await s
      .selectFrom('discovery_sites')
      .select(['id', 'sitecode'])
      .where('id', '=', siteId)
      .executeTakeFirst();
    if (!site) throw new BadRequestException('Unknown site for this customer.');

    const policies = await s
      .selectFrom('discovery_calling_policies')
      .select(['id', 'name'])
      .execute();
    const policyByName = new Map(policies.map((p) => [p.name.trim().toLowerCase(), p.id]));

    const freeNums = site.sitecode
      ? await s
          .selectFrom('phone_numbers as n')
          .innerJoin('discovery_number_ranges as r', 'r.id', 'n.range_id')
          .select(['n.id as id', 'n.e164 as e164'])
          .where('r.sitecode', '=', site.sitecode)
          .where('n.status', '=', 'available')
          .execute()
      : [];
    const numById = new Map(freeNums.map((n) => [numKey(n.e164), n.id]));

    const existing = new Set(
      (await s.selectFrom('discovery_users').select('upn').execute()).map((r) =>
        r.upn.trim().toLowerCase(),
      ),
    );

    let created = 0;
    let skipped = 0;
    const errors: { row: number; upn: string; message: string }[] = [];

    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const upn = row.upn.trim().toLowerCase();
      if (existing.has(upn)) {
        skipped += 1;
        continue;
      }
      const reqNum = nz(row.requested_number) ?? null;
      const numId = reqNum ? (numById.get(numKey(reqNum)) ?? null) : null;
      const policyId = row.calling_policy
        ? (policyByName.get(row.calling_policy.trim().toLowerCase()) ?? null)
        : null;
      try {
        const tenantUserId = await this.tenantUserIdFor(t, upn);
        const rec = await s
          .insertInto('discovery_users')
          .values({
            site_id: siteId,
            upn,
            display_name: nz(row.display_name),
            calling_policy_id: policyId,
            caller_id: row.caller_id ?? null,
            voicemail_enabled: row.voicemail_enabled ?? true,
            voicemail_language: nz(row.voicemail_language),
            requires_handset: row.requires_handset ?? false,
            handset_model: nz(row.handset_model),
            access_port_id: nz(row.access_port_id),
            comments: nz(row.comments),
            requested_number: reqNum,
            tenant_user_id: tenantUserId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (numId) {
          await this.setSingleNumber(t, 'user', rec.id, numId);
          numById.delete(numKey(reqNum!)); // never hand the same number to two rows
        }
        existing.add(upn);
        created += 1;
      } catch (e) {
        errors.push({ row: idx + 1, upn, message: (e as Error).message });
      }
    }

    await this.audit.tenant(t.schema, 'discovery.users_imported', {
      actor: actorOf(u),
      targetType: 'discovery_site',
      targetId: siteId,
      detail: { created, skipped, errors: errors.length },
    });
    if (created > 0) await this.base.trackChange(t, u, { siteId, entity: 'User', action: 'added', label: `${created} user${created === 1 ? '' : 's'} imported` });
    return { created, skipped, errors };
  }

  /* ============================== caps ============================== */

  async addCap(t: TenantContext, u: AuthedUser, i: DiscoveryCapInput, canReview: boolean) {
    const siteId = await this.resolveHolderSite(t, i.site_id);
    if (nz(i.phone_number_id)) await this.assertNumberInScope(t, nz(i.phone_number_id)!);
    const row = await this.s(t)
      .insertInto('discovery_caps')
      .values({
        site_id: siteId,
        display_name: i.display_name,
        upn: nz(i.upn),
        device_model: nz(i.device_model),
        calling_policy_id: nz(i.calling_policy_id),
        caller_id: nz(i.caller_id),
        access_port_id: nz(i.access_port_id),
        comments: nz(i.comments),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (i.phone_number_id !== undefined) {
      await this.setSingleNumber(t, 'cap', row.id, nz(i.phone_number_id));
    }
    await this.audit.tenant(t.schema, 'discovery.cap_added', {
      actor: actorOf(u),
      targetType: 'discovery_cap',
      targetId: row.id,
    });
    await this.base.trackChange(t, u, { siteId: row.site_id, entity: 'Common area phone', action: 'added', label: row.display_name });
    return row;
  }

  async updateCap(
    t: TenantContext,
    u: AuthedUser,
    id: string,
    patch: Partial<DiscoveryCapInput>,
    canReview: boolean,
  ) {
    await this.assertHolderInScope(t, 'discovery_caps', id, 'CAP not found');
    const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of [
      'display_name',
      'upn',
      'device_model',
      'calling_policy_id',
      'caller_id',
      'access_port_id',
      'comments',
    ] as const) {
      if (k in patch) set[k] = nz(patch[k] as string);
    }
    if ('site_id' in patch) set.site_id = await this.resolveHolderSite(t, patch.site_id);
    if ('phone_number_id' in patch && nz(patch.phone_number_id ?? null)) {
      await this.assertNumberInScope(t, nz(patch.phone_number_id ?? null)!);
    }
    const row = await this.s(t)
      .updateTable('discovery_caps')
      .set(set)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('CAP not found');
    if ('phone_number_id' in patch) {
      await this.setSingleNumber(t, 'cap', id, nz(patch.phone_number_id ?? null));
    }
    await this.audit.tenant(t.schema, 'discovery.cap_updated', {
      actor: actorOf(u),
      targetType: 'discovery_cap',
      targetId: id,
    });
    await this.base.trackChange(t, u, { siteId: row.site_id, entity: 'Common area phone', action: 'changed', label: row.display_name, detail: Object.keys(patch).join(', ') });
    return row;
  }

  /** Select many CAPs, set a handful of fields once, apply to all of them -
   * see applyBulkPatch (shared with Design & Build's identical action). */
  async bulkUpdateCaps(t: TenantContext, u: AuthedUser, body: DiscoveryCapBulkPatchInput, canReview: boolean) {
    await this.assertHolderIdsInScope(t, 'discovery_caps', body.ids);
    const tracked = await this.holderRows(t, 'discovery_caps', body.ids);
    const { updated, appliedPatch } = await applyBulkPatch(this.s(t), 'discovery_caps', body.ids, body.patch);
    await auditBulkPatch(this.audit, t.schema, 'discovery.caps_bulk_updated', {
      actor: actorOf(u),
      targetType: 'discovery_cap',
      ids: body.ids,
      updated,
      patch: appliedPatch,
    });
    await this.trackRows(t, u, tracked, 'Common area phone', 'changed', Object.keys(appliedPatch).join(', '));
    return { updated };
  }

  async deleteCap(t: TenantContext, u: AuthedUser, id: string, canReview: boolean) {
    await this.assertHolderInScope(t, 'discovery_caps', id, 'CAP not found');
    const tracked = await this.holderRows(t, 'discovery_caps', [id]);
    await this.releaseHolder(t, 'cap', id);
    const res = await this.s(t).deleteFrom('discovery_caps').where('id', '=', id).executeTakeFirst();
    if (!Number(res.numDeletedRows)) throw new NotFoundException('CAP not found');
    await this.audit.tenant(t.schema, 'discovery.cap_deleted', {
      actor: actorOf(u),
      targetType: 'discovery_cap',
      targetId: id,
    });
    await this.trackRows(t, u, tracked, 'Common area phone', 'removed');
    return { ok: true };
  }

  /* ============================ voice apps ============================ */

  async addVoiceApp(t: TenantContext, u: AuthedUser, i: DiscoveryVoiceAppInput, canReview: boolean) {
    const siteId = await this.resolveHolderSite(t, i.site_id);
    const row = await this.s(t)
      .insertInto('discovery_voice_apps')
      .values({
        site_id: siteId,
        name: i.name,
        kind: i.kind,
        directory_entry: nz(i.directory_entry),
        business_hours: nz(i.business_hours),
        who_answers: nz(i.who_answers),
        ooh_action: nz(i.ooh_action),
        exception_conditions: nz(i.exception_conditions),
        exception_action: nz(i.exception_action),
        holiday: nz(i.holiday),
        advanced_features: nz(i.advanced_features),
        comments: nz(i.comments),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (i.phone_number_id) {
      // The voice app has no number of its own: a resource account of the same name holds it and answers for the app. If the number
      // cannot be taken (in use, cooling off, another site's), nothing is left behind.
      let raId: string | null = null;
      try {
        const ra = await this.addResourceAccount(t, u, { site_id: siteId, name: i.name, kind: i.kind, voice_app_id: row.id }, canReview);
        raId = ra.id;
        await this.attachRaNumber(t, u, ra.id, i.phone_number_id, canReview);
      } catch (e) {
        if (raId) await this.s(t).deleteFrom('discovery_resource_accounts').where('id', '=', raId).execute();
        await this.s(t).deleteFrom('discovery_voice_apps').where('id', '=', row.id).execute();
        throw e;
      }
    }
    await this.audit.tenant(t.schema, 'discovery.voice_app_added', { actor: actorOf(u), targetType: 'discovery_voice_app', targetId: row.id });
    await this.base.trackChange(t, u, { siteId: row.site_id, entity: 'Voice app', action: 'added', label: row.name });
    return row;
  }

  async updateVoiceApp(t: TenantContext, u: AuthedUser, id: string, patch: Partial<DiscoveryVoiceAppInput>, canReview: boolean) {
    await this.assertHolderInScope(t, 'discovery_voice_apps', id, 'voice app not found');
    const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of ['name', 'kind', 'directory_entry', 'business_hours', 'who_answers', 'ooh_action', 'exception_conditions', 'exception_action', 'holiday', 'advanced_features', 'comments'] as const) {
      if (k in patch) set[k] = k === 'kind' || k === 'name' ? patch[k] : nz(patch[k] as string);
    }
    if ('site_id' in patch) set.site_id = await this.resolveHolderSite(t, patch.site_id);
    const row = await this.s(t).updateTable('discovery_voice_apps').set(set).where('id', '=', id).returningAll().executeTakeFirst();
    if (!row) throw new NotFoundException('voice app not found');
    await this.audit.tenant(t.schema, 'discovery.voice_app_updated', { actor: actorOf(u), targetType: 'discovery_voice_app', targetId: id });
    await this.base.trackChange(t, u, { siteId: row.site_id, entity: 'Voice app', action: 'changed', label: row.name, detail: Object.keys(patch).join(', ') });
    return row;
  }

  /** Deleting a voice app keeps its resource accounts (and their numbers): they just stop belonging to it. */
  async deleteVoiceApp(t: TenantContext, u: AuthedUser, id: string, canReview: boolean) {
    await this.assertHolderInScope(t, 'discovery_voice_apps', id, 'voice app not found');
    const tracked = await this.holderRows(t, 'discovery_voice_apps', [id]);
    // Its Call flow goes with it: they are one auto attendant or call queue, and a flow left without its voice app never reaches
    // Design & Build.
    const flows = await this.s(t).deleteFrom('discovery_flows').where('voice_app_id', '=', id).returning(['id', 'name', 'site_id']).execute();
    const res = await this.s(t).deleteFrom('discovery_voice_apps').where('id', '=', id).executeTakeFirst();
    if (!Number(res.numDeletedRows)) throw new NotFoundException('voice app not found');
    await this.audit.tenant(t.schema, 'discovery.voice_app_deleted', { actor: actorOf(u), targetType: 'discovery_voice_app', targetId: id, detail: { callFlows: flows.length } });
    await this.trackRows(t, u, tracked, 'Voice app', 'removed');
    return { ok: true, callFlowsDeleted: flows.length };
  }

  /* ====================== Call Flows (preview) ====================== */

  /**
   * Saves a call flow made in Call Flows (preview) (docs/CALL-FLOWS-WIZARD.md step 2) as the classic wizards would have: the number on a
   * resource account answering an auto attendant, one call queue capture per group linked to it by flowId, each marked editor
   * 'call-flows'. With `straight_to_queue` the number answers the flow's one group directly. Engineers only while it is a preview.
   * Everything is checked before anything is written; the number is taken first, as it is the step most likely to be refused.
   */
  async saveVisualCallFlow(t: TenantContext, u: AuthedUser, input: SaveVisualCallFlowInput, canReview: boolean) {
    if (u.role === 'CUSTOMER') throw new ForbiddenException('Call Flows (preview) is for engineers while it is a preview.');
    const siteId = await this.resolveHolderSite(t, input.site_id);
    const flow = input.flow as VisualCallFlow;
    const problem = visualCallFlowProblem(flow);
    if (problem) throw new BadRequestException(problem);
    const straight = input.straight_to_queue ? onlyRingsAGroup(flow) : null;
    if (input.straight_to_queue && !straight) throw new BadRequestException('Only a call flow that rings one group all the time, with no greeting, can send calls straight to the group.');

    // A number already answering a call flow: open that one instead (decided 10 Nov 2026).
    await this.assertNumberInScope(t, input.phone_number_id);
    const held = await this.s(t)
      .selectFrom('phone_numbers as n')
      .innerJoin('discovery_resource_accounts as ra', (j) => j.onRef('ra.id', '=', 'n.holder_id').on('n.holder_type', '=', 'resource_account'))
      .leftJoin('discovery_voice_apps as va', 'va.id', 'ra.voice_app_id')
      .select(['n.e164', 'ra.name as ra_name', 'va.name as app_name'])
      .where('n.id', '=', input.phone_number_id)
      .executeTakeFirst();
    if (held) throw new ConflictException(`${held.e164} already answers "${held.app_name ?? held.ra_name}". Open that call flow instead, or choose another number.`);

    // Each group's answers, and the attendant's with ids standing in for the groups' captures: all checked before anything is written.
    const groups = new Map<string, VisualGroup>();
    for (const g of visualFlowGroups(flow)) if (!groups.has(g.id)) groups.set(g.id, g);
    const queueAnswers = new Map([...groups].map(([id, g]) => [id, callQueueWizardAnswersSchema.parse(groupToQueueAnswers(g))]));
    const attendantAnswers = (ids: Map<string, string>) => {
      const c = toCaptures(mapVisualGroups(flow, (g) => ({ ...g, id: ids.get(g.id)! })), { attendantFlowId: randomUUID(), attendantInFront: true });
      const answers = autoAttendantWizardAnswersSchema.parse(c.top.capture.answers);
      const words = autoAttendantWizardProblem(answers);
      if (words) throw new BadRequestException(words);
      return answers;
    };
    if (!straight) attendantAnswers(new Map([...groups.keys()].map((id) => [id, randomUUID()])));

    const description = (what: string) => `Made in Call Flows (preview) - ${what}`;
    const madeApps: string[] = [];
    try {
      const top = await this.addVoiceApp(t, u, { site_id: siteId, name: straight ? straight.name : flow.name, kind: straight ? 'call_queue' : 'auto_attendant', phone_number_id: input.phone_number_id }, canReview);
      madeApps.push(top.id);
      const ra = await this.s(t).selectFrom('discovery_resource_accounts').select('id').where('voice_app_id', '=', top.id).executeTakeFirstOrThrow();
      if (straight) {
        const row = await this.base.addFlow(
          t,
          u,
          { site_id: siteId, kind: 'call_queue', name: straight.name, description: description(`rings ${straight.people.length} people`), wizard_answers: queueAnswers.get(straight.id)!, wizard_version: 1, voice_app_id: top.id, resource_account_id: ra.id, editor: 'call-flows' },
          canReview,
        );
        return { voiceAppId: top.id, flowId: row.id, queues: 0 };
      }
      const ids = new Map<string, string>();
      for (const [id, g] of groups) {
        const row = await this.base.addFlow(
          t,
          u,
          { site_id: siteId, kind: 'call_queue', name: g.name, description: description(`a group in "${flow.name}"`), wizard_answers: queueAnswers.get(id)!, wizard_version: 1, editor: 'call-flows' },
          canReview,
        );
        ids.set(id, row.id);
        if (row.voice_app_id) madeApps.push(row.voice_app_id);
      }
      const row = await this.base.addFlow(
        t,
        u,
        { site_id: siteId, kind: 'auto_attendant', name: flow.name, description: description('answers the number'), wizard_answers: attendantAnswers(ids), wizard_version: 1, voice_app_id: top.id, resource_account_id: ra.id, editor: 'call-flows' },
        canReview,
      );
      return { voiceAppId: top.id, flowId: row.id, queues: ids.size };
    } catch (e) {
      // nothing half made: the number freed, its resource account, the voice apps and their Call flows removed
      if (madeApps.length) {
        const ras = await this.s(t).selectFrom('discovery_resource_accounts').select('id').where('voice_app_id', 'in', madeApps).execute();
        for (const r of ras) await this.releaseHolder(t, 'resource_account', r.id);
        if (ras.length) await this.s(t).deleteFrom('discovery_resource_accounts').where('id', 'in', ras.map((r) => r.id)).execute();
        await this.s(t).deleteFrom('discovery_flows').where('voice_app_id', 'in', madeApps).execute();
        await this.s(t).deleteFrom('discovery_voice_apps').where('id', 'in', madeApps).execute();
      }
      throw e;
    }
  }

  /**
   * A call flow made in Call Flows (preview), changed there (docs/CALL-FLOWS-WIZARD.md step 4). Its captures are updated in place: the
   * auto attendant (or the group the number goes straight to), each group it already had, a new call queue capture for each new group, and a
   * group taken out is deleted with its voice app unless another Call flow still points at it. The number and resource account are kept;
   * whether it goes straight to a group can't change here. Everything is checked before anything is written.
   */
  async updateVisualCallFlow(t: TenantContext, u: AuthedUser, flowId: string, input: UpdateVisualCallFlowInput, canReview: boolean) {
    if (u.role === 'CUSTOMER') throw new ForbiddenException('Call Flows (preview) is for engineers while it is a preview.');
    const top = await this.s(t).selectFrom('discovery_flows').selectAll().where('id', '=', flowId).executeTakeFirst();
    if (!top) throw new NotFoundException('flow not found');
    assertSiteInScope(t, top.site_id);
    if (top.editor !== 'call-flows' || !top.wizard_answers) throw new BadRequestException('This call flow wasn’t made in Call Flows (preview). Open it in the classic wizard.');
    const flow = input.flow as VisualCallFlow;
    const problem = visualCallFlowProblem(flow);
    if (problem) throw new BadRequestException(problem);
    const straight = top.kind === 'call_queue';
    if (!!input.straight_to_queue !== straight) throw new BadRequestException(straight ? 'This call flow sends calls straight to its group: that can’t be changed here.' : 'This call flow has a phone menu in front: that can’t be changed here.');
    const description = (what: string) => `Made in Call Flows (preview) - ${what}`;
    const rename = async (voiceAppId: string | null, name: string) => {
      if (voiceAppId) await this.s(t).updateTable('discovery_voice_apps').set({ name, updated_at: new Date().toISOString() }).where('id', '=', voiceAppId).execute();
    };

    if (straight) {
      const g = onlyRingsAGroup({ ...flow, business: { then: flow.business.then } });
      if (!g) throw new BadRequestException('Only a call flow that rings one group all the time, with no greeting, can send calls straight to the group.');
      const answers = callQueueWizardAnswersSchema.parse(groupToQueueAnswers(g));
      await this.base.updateFlow(t, u, top.id, { name: g.name, wizard_answers: answers, description: description(`rings ${g.people.length} people`) }, canReview);
      await rename(top.voice_app_id, g.name);
      return { flowId: top.id, queues: 0 };
    }

    // the groups this auto attendant already had: the preview's own call queue captures it points at
    const rows = await this.s(t).selectFrom('discovery_flows').select(['id', 'kind', 'name', 'wizard_answers', 'editor', 'voice_app_id']).where('site_id', '=', top.site_id).execute();
    const had = new Set(attendantFlowIds(top.wizard_answers as AutoAttendantWizardAnswers).filter((id) => rows.some((r) => r.id === id && r.kind === 'call_queue' && r.editor === 'call-flows')));
    const groups = new Map<string, VisualGroup>();
    for (const g of visualFlowGroups(flow)) if (!groups.has(g.id)) groups.set(g.id, g);
    const queueAnswers = new Map([...groups].map(([id, g]) => [id, callQueueWizardAnswersSchema.parse(groupToQueueAnswers(g))]));
    const attendantAnswers = (ids: Map<string, string>) => {
      const c = toCaptures(mapVisualGroups(flow, (g) => ({ ...g, id: ids.get(g.id)! })), { attendantFlowId: top.id, attendantInFront: true });
      const answers = autoAttendantWizardAnswersSchema.parse(c.top.capture.answers);
      const words = autoAttendantWizardProblem(answers);
      if (words) throw new BadRequestException(words);
      return answers;
    };
    attendantAnswers(new Map([...groups.keys()].map((id) => [id, had.has(id) ? id : randomUUID()])));

    const ids = new Map<string, string>();
    for (const [id, g] of groups) {
      if (had.has(id)) {
        const row = rows.find((r) => r.id === id)!;
        await this.base.updateFlow(t, u, id, { name: g.name, wizard_answers: queueAnswers.get(id)!, description: description(`a group in "${flow.name}"`) }, canReview);
        await rename(row.voice_app_id, g.name);
        ids.set(id, id);
      } else {
        const row = await this.base.addFlow(t, u, { site_id: top.site_id, kind: 'call_queue', name: g.name, description: description(`a group in "${flow.name}"`), wizard_answers: queueAnswers.get(id)!, wizard_version: 1, editor: 'call-flows' }, canReview);
        ids.set(id, row.id);
      }
    }
    await this.base.updateFlow(t, u, top.id, { name: flow.name, wizard_answers: attendantAnswers(ids), description: description('answers the number') }, canReview);
    await rename(top.voice_app_id, flow.name);

    // a group taken out goes, unless another Call flow still points at it
    let removed = 0;
    for (const id of had) {
      if (groups.has(id)) continue;
      const pointedAt = rows.some((r) => r.id !== top.id && r.kind === 'auto_attendant' && !!r.wizard_answers && attendantFlowIds(r.wizard_answers as AutoAttendantWizardAnswers).includes(id));
      if (pointedAt) continue;
      await this.base.deleteFlow(t, u, id, canReview);
      removed++;
    }
    return { flowId: top.id, queues: ids.size, removed };
  }

  /* ====================== resource accounts ====================== */

  /** A resource account can only answer for a voice app on its own site. */
  private async assertVoiceAppOnSite(t: TenantContext, voiceAppId: string | null | undefined, siteId: string | null) {
    if (!voiceAppId) return;
    const app = await this.s(t).selectFrom('discovery_voice_apps').select(['site_id', 'kind']).where('id', '=', voiceAppId).executeTakeFirst();
    if (!app) throw new NotFoundException('voice app not found');
    if (siteId && app.site_id !== siteId) throw new BadRequestException('That voice app is on a different site.');
  }

  /**
   * A resource account's link to an auto attendant or call queue lives on the account (voice_app_id); the Call flow keeps a copy
   * (resource_account_id) that the AA / CQ wizard shows. Linking from the Resource accounts tab must update that copy too, or the
   * wizard shows no account (bug report "Associated Resource Account to AA & CQ"). An account linked to a voice app fills a flow
   * of that app that has none; an account unlinked (or deleted) hands its flows to another account still on the old app, or none.
   */
  private async syncFlowResourceAccount(t: TenantContext, raId: string, oldAppId: string | null, newAppId: string | null) {
    const s = this.s(t);
    const now = new Date().toISOString();
    if (oldAppId && oldAppId !== newAppId) {
      const other = await s
        .selectFrom('discovery_resource_accounts')
        .select('id')
        .where('voice_app_id', '=', oldAppId)
        .where('id', '!=', raId)
        .orderBy('created_at')
        .orderBy('id')
        .executeTakeFirst();
      await s
        .updateTable('discovery_flows')
        .set({ resource_account_id: other?.id ?? null, updated_at: now })
        .where('voice_app_id', '=', oldAppId)
        .where((eb) => eb.or([eb('resource_account_id', '=', raId), eb('resource_account_id', 'is', null)]))
        .execute();
    }
    if (newAppId) {
      await s
        .updateTable('discovery_flows')
        .set({ resource_account_id: raId, updated_at: now })
        .where('voice_app_id', '=', newAppId)
        .where('resource_account_id', 'is', null)
        .execute();
    }
  }

  async addResourceAccount(t: TenantContext, u: AuthedUser, i: DiscoveryResourceAccountInput, canReview: boolean) {
    const siteId = await this.resolveHolderSite(t, i.site_id);
    await this.assertVoiceAppOnSite(t, i.voice_app_id, siteId);
    const row = await this.s(t)
      .insertInto('discovery_resource_accounts')
      .values({ site_id: siteId, name: i.name, kind: i.kind, upn: nz(i.upn)?.toLowerCase() ?? null, voice_app_id: i.voice_app_id ?? null, comments: nz(i.comments) })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.syncFlowResourceAccount(t, row.id, null, row.voice_app_id);
    await this.audit.tenant(t.schema, 'discovery.resource_account_added', { actor: actorOf(u), targetType: 'discovery_resource_account', targetId: row.id });
    await this.base.trackChange(t, u, { siteId: row.site_id, entity: 'Resource account', action: 'added', label: row.name });
    return row;
  }

  async updateResourceAccount(t: TenantContext, u: AuthedUser, id: string, patch: Partial<DiscoveryResourceAccountInput>, canReview: boolean) {
    await this.assertHolderInScope(t, 'discovery_resource_accounts', id, 'resource account not found');
    const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if ('name' in patch) set.name = patch.name;
    if ('kind' in patch) set.kind = patch.kind;
    if ('upn' in patch) set.upn = nz(patch.upn)?.toLowerCase() ?? null;
    if ('comments' in patch) set.comments = nz(patch.comments);
    if ('site_id' in patch) set.site_id = await this.resolveHolderSite(t, patch.site_id);
    const before = await this.s(t).selectFrom('discovery_resource_accounts').select(['site_id', 'voice_app_id']).where('id', '=', id).executeTakeFirst();
    if ('voice_app_id' in patch) {
      const current = before;
      await this.assertVoiceAppOnSite(t, patch.voice_app_id, (set.site_id as string | null | undefined) ?? current?.site_id ?? null);
      set.voice_app_id = patch.voice_app_id ?? null;
    }
    const row = await this.s(t).updateTable('discovery_resource_accounts').set(set).where('id', '=', id).returningAll().executeTakeFirst();
    if (!row) throw new NotFoundException('resource account not found');
    if ('voice_app_id' in patch) await this.syncFlowResourceAccount(t, id, before?.voice_app_id ?? null, row.voice_app_id);
    await this.audit.tenant(t.schema, 'discovery.resource_account_updated', { actor: actorOf(u), targetType: 'discovery_resource_account', targetId: id });
    await this.base.trackChange(t, u, { siteId: row.site_id, entity: 'Resource account', action: 'changed', label: row.name, detail: Object.keys(patch).join(', ') });
    return row;
  }

  async deleteResourceAccount(t: TenantContext, u: AuthedUser, id: string, canReview: boolean) {
    await this.assertHolderInScope(t, 'discovery_resource_accounts', id, 'resource account not found');
    const tracked = await this.holderRows(t, 'discovery_resource_accounts', [id]);
    const before = await this.s(t).selectFrom('discovery_resource_accounts').select('voice_app_id').where('id', '=', id).executeTakeFirst();
    await this.releaseHolder(t, 'resource_account', id);
    const res = await this.s(t).deleteFrom('discovery_resource_accounts').where('id', '=', id).executeTakeFirst();
    if (!Number(res.numDeletedRows)) throw new NotFoundException('resource account not found');
    // the flow's link was cleared by ON DELETE SET NULL; another account still linked to the voice app takes its place
    await this.syncFlowResourceAccount(t, id, before?.voice_app_id ?? null, null);
    await this.audit.tenant(t.schema, 'discovery.resource_account_deleted', { actor: actorOf(u), targetType: 'discovery_resource_account', targetId: id });
    await this.trackRows(t, u, tracked, 'Resource account', 'removed');
    return { ok: true };
  }

  async attachRaNumber(t: TenantContext, u: AuthedUser, raId: string, numberId: string, canReview: boolean) {
    await this.assertHolderInScope(t, 'discovery_resource_accounts', raId, 'resource account not found');
    await this.assertNumberInScope(t, numberId);
    const ra = await this.s(t)
      .selectFrom('discovery_resource_accounts')
      .select('id')
      .where('id', '=', raId)
      .executeTakeFirst();
    if (!ra) throw new NotFoundException('resource account not found');
    await this.claimNumber(t, numberId, 'resource_account', raId);
    await this.audit.tenant(t.schema, 'discovery.resource_account_number_attached', {
      actor: actorOf(u),
      targetType: 'discovery_resource_account',
      targetId: raId,
      detail: { numberId },
    });
    await this.trackRows(t, u, await this.holderRows(t, 'discovery_resource_accounts', [raId]), 'Resource account number', 'added');
    return { ok: true };
  }

  async detachRaNumber(t: TenantContext, u: AuthedUser, raId: string, numberId: string, canReview: boolean) {
    await this.assertHolderInScope(t, 'discovery_resource_accounts', raId, 'resource account not found');
    const res = await this.s(t)
      .updateTable('phone_numbers')
      .set(releasedNumber())
      .where('id', '=', numberId)
      .where('holder_type', '=', 'resource_account')
      .where('holder_id', '=', raId)
      .executeTakeFirst();
    if (!Number(res.numUpdatedRows)) throw new NotFoundException('number is not attached to this resource account');
    await this.audit.tenant(t.schema, 'discovery.resource_account_number_detached', {
      actor: actorOf(u),
      targetType: 'discovery_resource_account',
      targetId: raId,
      detail: { numberId },
    });
    await this.trackRows(t, u, await this.holderRows(t, 'discovery_resource_accounts', [raId]), 'Resource account number', 'removed');
    return { ok: true };
  }

  /** Site and name of rows about to change or go, read first so a delete can still be recorded afterwards. */
  private async holderRows(t: TenantContext, table: 'discovery_users' | 'discovery_caps' | 'discovery_resource_accounts' | 'discovery_voice_apps', ids: string[]) {
    if (ids.length === 0) return [];
    const s = this.s(t);
    if (table === 'discovery_users') {
      return (await s.selectFrom(table).select(['site_id', 'upn as label']).where('id', 'in', ids).execute()) as { site_id: string | null; label: string | null }[];
    }
    if (table === 'discovery_caps') {
      return (await s.selectFrom(table).select(['site_id', 'display_name as label']).where('id', 'in', ids).execute()) as { site_id: string | null; label: string | null }[];
    }
    return (await s.selectFrom(table).select(['site_id', 'name as label']).where('id', 'in', ids).execute()) as { site_id: string | null; label: string | null }[];
  }

  /** One change per site for a group of rows, named by the first few. */
  private async trackRows(
    t: TenantContext,
    u: AuthedUser,
    rows: { site_id: string | null; label: string | null }[],
    entity: string,
    action: 'added' | 'changed' | 'removed',
    detail?: string,
  ) {
    const bySite = new Map<string, string[]>();
    for (const r of rows) if (r.site_id) bySite.set(r.site_id, [...(bySite.get(r.site_id) ?? []), r.label ?? '']);
    for (const [siteId, labels] of bySite) {
      const named = labels.filter(Boolean);
      const label = named.slice(0, 3).join(', ') + (labels.length > 3 ? ` and ${labels.length - 3} more` : '');
      await this.base.trackChange(t, u, { siteId, entity, action, label: label || `${labels.length}`, detail });
    }
  }

  private dupName(e: unknown, what: string): Error {
    const msg = (e as { message?: string })?.message ?? '';
    if (/duplicate key|unique/i.test(msg)) return new ConflictException(`That ${what} already exists.`);
    return e as Error;
  }
}

/** Expand an E.164 range into individual "+<digits>" strings. */
export function expandRange(startRaw: string, endRaw: string): string[] {
  const start = startRaw.replace(/\D/g, '');
  const end = endRaw.replace(/\D/g, '');
  if (!start || !end) throw new BadRequestException('Range start and end must be numeric.');
  if (start.length !== end.length) {
    throw new BadRequestException('Range start and end must have the same number of digits.');
  }
  const s = BigInt(start);
  const e = BigInt(end);
  if (e < s) throw new BadRequestException('Range end is before range start.');
  const count = e - s + 1n;
  if (count > BigInt(MAX_RANGE_SIZE)) {
    throw new BadRequestException(
      `That range is ${count} numbers, over the ${MAX_RANGE_SIZE} limit. Split it into smaller ranges.`,
    );
  }
  const out: string[] = [];
  for (let n = s; n <= e; n += 1n) out.push('+' + n.toString());
  return out;
}
