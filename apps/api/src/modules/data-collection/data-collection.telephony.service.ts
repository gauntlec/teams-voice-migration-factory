import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { tenantDb, type DB } from '@tvmf/db';
import {
  MAX_RANGE_SIZE,
  type CallingPolicyInput,
  type DiscoveryCapInput,
  type DiscoveryListQuery,
  type DiscoveryNumberRangeInput,
  type DiscoveryResourceAccountInput,
  type DiscoveryUserInput,
  type NumberHolderType,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { DataCollectionService } from './data-collection.service';
import { assertCustomerWide, assertSiteInScope } from './site-scope';

type Scoped = ReturnType<typeof tenantDb>;
const actorOf = (u: AuthedUser) => ({ id: u.id, email: u.email });

/** '' -> null, otherwise pass through (dropdowns clear to ''). */
const nz = <T>(v: T | '' | null | undefined): T | null => (v === '' || v == null ? null : v);

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
    table: 'discovery_users' | 'discovery_caps' | 'discovery_resource_accounts',
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
    return {
      items: items.map((u) => ({
        ...u,
        phone_number: byHolder.get(u.id)?.e164 ?? null,
        phone_number_id: byHolder.get(u.id)?.id ?? null,
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

  async listResourceAccounts(t: TenantContext, q: DiscoveryListQuery) {
    const s = this.s(t);
    const sites = this.siteIdFilter(t, q.siteId);
    const { page, limit, offset } = this.pageOf(q);
    let b = s.selectFrom('discovery_resource_accounts');
    if (sites) b = b.where('site_id', 'in', sites);
    if (q.q) b = b.where('name', 'ilike', `%${q.q}%`);
    const [items, cnt] = await Promise.all([
      b.selectAll().orderBy('name').limit(limit).offset(offset).execute(),
      b.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst(),
    ]);
    const ids = items.map((r) => r.id);
    const nums = ids.length
      ? await s
          .selectFrom('phone_numbers')
          .select(['id', 'e164', 'holder_id'])
          .where('holder_type', '=', 'resource_account')
          .where('holder_id', 'in', ids)
          .orderBy('e164')
          .execute()
      : [];
    const byHolder = new Map<string, { id: string; e164: string }[]>();
    for (const n of nums) {
      const arr = byHolder.get(n.holder_id as string) ?? [];
      arr.push({ id: n.id, e164: n.e164 });
      byHolder.set(n.holder_id as string, arr);
    }
    return {
      items: items.map((r) => ({ ...r, phone_numbers: byHolder.get(r.id) ?? [] })),
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
          .where('range_id', 'in', ids)
          .groupBy('range_id')
          .execute()
      : [];
    const byRange = new Map(
      grp.map((g) => [
        g.range_id,
        { total: Number(g.total), assigned: Number(g.assigned), reserved: Number(g.reserved) },
      ]),
    );
    return {
      items: items.map((r) => ({
        ...r,
        counts: byRange.get(r.id) ?? { total: 0, assigned: 0, reserved: 0 },
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
    if (q.q) b = b.where('n.e164', 'ilike', `%${q.q}%`);
    const [items, cnt] = await Promise.all([
      b
        .select([
          'n.id as id',
          'n.e164 as e164',
          'n.status as status',
          'n.holder_type as holder_type',
          'n.holder_id as holder_id',
          'n.range_id as range_id',
          'r.range_start as range_start',
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

  /* ====================== calling policies ====================== */

  async addCallingPolicy(t: TenantContext, u: AuthedUser, i: CallingPolicyInput, canReview: boolean) {
    assertCustomerWide(t, 'Outbound calling policies');
    await this.base.assertEditable(t, canReview);
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
    await this.base.assertEditable(t, canReview);
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
    await this.base.assertEditable(t, canReview);
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
    await this.base.assertEditable(t, canReview);
    const e164s = expandRange(i.range_start, i.range_end);
    await this.siteByCode(t, i.sitecode);

    const range = await this.s(t)
      .insertInto('discovery_number_ranges')
      .values({
        sitecode: i.sitecode,
        range_start: i.range_start,
        range_end: i.range_end,
        kind: i.kind,
        carrier: nz(i.carrier),
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
    }

    await this.audit.tenant(t.schema, 'discovery.range_added', {
      actor: actorOf(u),
      targetType: 'discovery_number_range',
      targetId: range.id,
      detail: { requested: e164s.length, generated },
    });
    return { range, generated, skipped: e164s.length - generated };
  }

  async updateRange(
    t: TenantContext,
    u: AuthedUser,
    id: string,
    patch: Partial<DiscoveryNumberRangeInput>,
    canReview: boolean,
  ) {
    await this.base.assertEditable(t, canReview);
    await this.assertRangeInScope(t, id);
    // Bounds are fixed once numbers are generated - recreate the range to change them.
    const set: Record<string, unknown> = {};
    for (const k of ['kind', 'carrier', 'loa_sent', 'loa_completed', 'comments', 'sitecode'] as const) {
      if (k in patch) set[k] = k === 'carrier' || k === 'comments' ? nz(patch[k]) : patch[k];
    }
    if (typeof set.sitecode === 'string') await this.siteByCode(t, set.sitecode);
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
    return row;
  }

  async deleteRange(t: TenantContext, u: AuthedUser, id: string, canReview: boolean) {
    await this.base.assertEditable(t, canReview);
    await this.assertRangeInScope(t, id);
    const inUse = await this.s(t)
      .selectFrom('phone_numbers')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('range_id', '=', id)
      .where('status', '<>', 'available')
      .executeTakeFirstOrThrow();
    if (Number(inUse.n) > 0) {
      throw new ConflictException(
        `${inUse.n} number(s) from this range are assigned or reserved. Release them first.`,
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
    return { ok: true };
  }

  async reserveNumber(t: TenantContext, u: AuthedUser, id: string, reserved: boolean, canReview: boolean) {
    await this.base.assertEditable(t, canReview);
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
    return row;
  }

  /* ==================== atomic assignment core ==================== */

  private async claimNumber(t: TenantContext, numberId: string, holderType: NumberHolderType, holderId: string) {
    const res = await this.s(t)
      .updateTable('phone_numbers')
      .set({ holder_type: holderType, holder_id: holderId, status: 'assigned' })
      .where('id', '=', numberId)
      .where('holder_id', 'is', null)
      .where('status', '=', 'available')
      .executeTakeFirst();
    if (!Number(res.numUpdatedRows)) {
      const n = await this.s(t)
        .selectFrom('phone_numbers')
        .select('status')
        .where('id', '=', numberId)
        .executeTakeFirst();
      if (!n) throw new NotFoundException('phone number not found');
      throw new ConflictException(
        n.status === 'reserved' ? 'That number is reserved.' : 'That number is already assigned.',
      );
    }
  }

  private async releaseHolder(t: TenantContext, holderType: NumberHolderType, holderId: string) {
    await this.s(t)
      .updateTable('phone_numbers')
      .set({ holder_type: null, holder_id: null, status: 'available' })
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

  async addUser(t: TenantContext, u: AuthedUser, i: DiscoveryUserInput, canReview: boolean) {
    await this.base.assertEditable(t, canReview);
    const siteId = await this.resolveHolderSite(t, i.site_id);
    if (nz(i.phone_number_id)) await this.assertNumberInScope(t, nz(i.phone_number_id)!);
    let row;
    try {
      row = await this.s(t)
        .insertInto('discovery_users')
        .values({
          site_id: siteId,
          upn: i.upn,
          display_name: nz(i.display_name),
          calling_policy_id: nz(i.calling_policy_id),
          caller_id: nz(i.caller_id),
          voicemail_enabled: i.voicemail_enabled ?? true,
          voicemail_language: nz(i.voicemail_language),
          requires_handset: i.requires_handset ?? false,
          handset_model: nz(i.handset_model),
          access_port_id: nz(i.access_port_id),
          comments: nz(i.comments),
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
    return row;
  }

  async updateUser(
    t: TenantContext,
    u: AuthedUser,
    id: string,
    patch: Partial<DiscoveryUserInput>,
    canReview: boolean,
  ) {
    await this.base.assertEditable(t, canReview);
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
    ] as const) {
      if (k in patch) set[k] = typeof patch[k] === 'boolean' ? patch[k] : nz(patch[k] as string);
    }
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
    return row;
  }

  async deleteUser(t: TenantContext, u: AuthedUser, id: string, canReview: boolean) {
    await this.base.assertEditable(t, canReview);
    await this.assertHolderInScope(t, 'discovery_users', id, 'user not found');
    await this.releaseHolder(t, 'user', id);
    const res = await this.s(t).deleteFrom('discovery_users').where('id', '=', id).executeTakeFirst();
    if (!Number(res.numDeletedRows)) throw new NotFoundException('user not found');
    await this.audit.tenant(t.schema, 'discovery.user_deleted', {
      actor: actorOf(u),
      targetType: 'discovery_user',
      targetId: id,
    });
    return { ok: true };
  }

  /* ============================== caps ============================== */

  async addCap(t: TenantContext, u: AuthedUser, i: DiscoveryCapInput, canReview: boolean) {
    await this.base.assertEditable(t, canReview);
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
    return row;
  }

  async updateCap(
    t: TenantContext,
    u: AuthedUser,
    id: string,
    patch: Partial<DiscoveryCapInput>,
    canReview: boolean,
  ) {
    await this.base.assertEditable(t, canReview);
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
    return row;
  }

  async deleteCap(t: TenantContext, u: AuthedUser, id: string, canReview: boolean) {
    await this.base.assertEditable(t, canReview);
    await this.assertHolderInScope(t, 'discovery_caps', id, 'CAP not found');
    await this.releaseHolder(t, 'cap', id);
    const res = await this.s(t).deleteFrom('discovery_caps').where('id', '=', id).executeTakeFirst();
    if (!Number(res.numDeletedRows)) throw new NotFoundException('CAP not found');
    await this.audit.tenant(t.schema, 'discovery.cap_deleted', {
      actor: actorOf(u),
      targetType: 'discovery_cap',
      targetId: id,
    });
    return { ok: true };
  }

  /* ====================== resource accounts ====================== */

  async addResourceAccount(
    t: TenantContext,
    u: AuthedUser,
    i: DiscoveryResourceAccountInput,
    canReview: boolean,
  ) {
    await this.base.assertEditable(t, canReview);
    const siteId = await this.resolveHolderSite(t, i.site_id);
    const row = await this.s(t)
      .insertInto('discovery_resource_accounts')
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
    await this.audit.tenant(t.schema, 'discovery.resource_account_added', {
      actor: actorOf(u),
      targetType: 'discovery_resource_account',
      targetId: row.id,
    });
    return row;
  }

  async updateResourceAccount(
    t: TenantContext,
    u: AuthedUser,
    id: string,
    patch: Partial<DiscoveryResourceAccountInput>,
    canReview: boolean,
  ) {
    await this.base.assertEditable(t, canReview);
    await this.assertHolderInScope(t, 'discovery_resource_accounts', id, 'resource account not found');
    const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of [
      'name',
      'kind',
      'directory_entry',
      'business_hours',
      'who_answers',
      'ooh_action',
      'exception_conditions',
      'exception_action',
      'holiday',
      'advanced_features',
      'comments',
    ] as const) {
      if (k in patch) set[k] = k === 'kind' || k === 'name' ? patch[k] : nz(patch[k] as string);
    }
    if ('site_id' in patch) set.site_id = await this.resolveHolderSite(t, patch.site_id);
    const row = await this.s(t)
      .updateTable('discovery_resource_accounts')
      .set(set)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('resource account not found');
    await this.audit.tenant(t.schema, 'discovery.resource_account_updated', {
      actor: actorOf(u),
      targetType: 'discovery_resource_account',
      targetId: id,
    });
    return row;
  }

  async deleteResourceAccount(t: TenantContext, u: AuthedUser, id: string, canReview: boolean) {
    await this.base.assertEditable(t, canReview);
    await this.assertHolderInScope(t, 'discovery_resource_accounts', id, 'resource account not found');
    await this.releaseHolder(t, 'resource_account', id);
    const res = await this.s(t)
      .deleteFrom('discovery_resource_accounts')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!Number(res.numDeletedRows)) throw new NotFoundException('resource account not found');
    await this.audit.tenant(t.schema, 'discovery.resource_account_deleted', {
      actor: actorOf(u),
      targetType: 'discovery_resource_account',
      targetId: id,
    });
    return { ok: true };
  }

  async attachRaNumber(t: TenantContext, u: AuthedUser, raId: string, numberId: string, canReview: boolean) {
    await this.base.assertEditable(t, canReview);
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
    return { ok: true };
  }

  async detachRaNumber(t: TenantContext, u: AuthedUser, raId: string, numberId: string, canReview: boolean) {
    await this.base.assertEditable(t, canReview);
    await this.assertHolderInScope(t, 'discovery_resource_accounts', raId, 'resource account not found');
    const res = await this.s(t)
      .updateTable('phone_numbers')
      .set({ holder_type: null, holder_id: null, status: 'available' })
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
    return { ok: true };
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
