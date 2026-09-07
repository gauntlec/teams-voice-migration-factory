import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { tenantDb, type DB } from '@tvmf/db';
import {
  MAX_RANGE_SIZE,
  type CallingPolicyInput,
  type DiscoveryCapInput,
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

  /** The sitecodes a site contact is limited to, or null for whole-customer. */
  private async scopedSitecodes(t: TenantContext): Promise<string[] | null> {
    if (!t.siteScope) return null;
    const rows = await this.s(t)
      .selectFrom('discovery_sites')
      .select('sitecode')
      .where('id', 'in', t.siteScope)
      .execute();
    // '\x00' can never be a real sitecode - keeps `in ()` from being emitted.
    return rows.length ? rows.map((r) => r.sitecode) : ['\x00'];
  }

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

  /* ============================ snapshot ============================ */

  async snapshot(t: TenantContext) {
    const s = this.s(t);
    const scope = t.siteScope;
    const sitecodes = await this.scopedSitecodes(t);

    let rangesQ = s.selectFrom('discovery_number_ranges').selectAll().orderBy('range_start');
    let numbersQ = s.selectFrom('phone_numbers').selectAll().orderBy('e164');
    let usersQ = s.selectFrom('discovery_users').selectAll().orderBy('upn');
    let capsQ = s.selectFrom('discovery_caps').selectAll().orderBy('display_name');
    let rasQ = s.selectFrom('discovery_resource_accounts').selectAll().orderBy('name');
    if (scope && sitecodes) {
      rangesQ = rangesQ.where('sitecode', 'in', sitecodes);
      numbersQ = numbersQ.where('range_id', 'in', (eb) =>
        eb.selectFrom('discovery_number_ranges').select('id').where('sitecode', 'in', sitecodes),
      );
      usersQ = usersQ.where('site_id', 'in', scope);
      capsQ = capsQ.where('site_id', 'in', scope);
      rasQ = rasQ.where('site_id', 'in', scope);
    }

    const [callingPolicies, ranges, numbers, users, caps, resourceAccounts] = await Promise.all([
      s.selectFrom('discovery_calling_policies').selectAll().orderBy('name').execute(),
      rangesQ.execute(),
      numbersQ.execute(),
      usersQ.execute(),
      capsQ.execute(),
      rasQ.execute(),
    ]);

    // resolve holder display names + per-holder number(s)
    const byHolder = new Map<string, typeof numbers>();
    for (const n of numbers) {
      if (!n.holder_id) continue;
      const arr = byHolder.get(n.holder_id) ?? [];
      arr.push(n);
      byHolder.set(n.holder_id, arr);
    }
    const numberOf = (id: string) => byHolder.get(id)?.[0]?.e164 ?? null;
    const numberIdOf = (id: string) => byHolder.get(id)?.[0]?.id ?? null;
    const numbersOf = (id: string) => (byHolder.get(id) ?? []).map((n) => ({ id: n.id, e164: n.e164 }));

    const rangeCounts = new Map<string, { total: number; assigned: number; reserved: number }>();
    for (const n of numbers) {
      const c = rangeCounts.get(n.range_id) ?? { total: 0, assigned: 0, reserved: 0 };
      c.total += 1;
      if (n.status === 'assigned') c.assigned += 1;
      if (n.status === 'reserved') c.reserved += 1;
      rangeCounts.set(n.range_id, c);
    }

    return {
      callingPolicies,
      ranges: ranges.map((r) => ({ ...r, counts: rangeCounts.get(r.id) ?? { total: 0, assigned: 0, reserved: 0 } })),
      numbers: numbers.map((n) => ({
        ...n,
        holder_name: n.holder_id ? this.holderName(n.holder_type, n.holder_id, users, caps, resourceAccounts) : null,
      })),
      numberSummary: {
        total: numbers.length,
        available: numbers.filter((n) => n.status === 'available').length,
        reserved: numbers.filter((n) => n.status === 'reserved').length,
        assigned: numbers.filter((n) => n.status === 'assigned').length,
      },
      users: users.map((u) => ({ ...u, phone_number: numberOf(u.id), phone_number_id: numberIdOf(u.id) })),
      caps: caps.map((c) => ({ ...c, phone_number: numberOf(c.id), phone_number_id: numberIdOf(c.id) })),
      resourceAccounts: resourceAccounts.map((r) => ({ ...r, phone_numbers: numbersOf(r.id) })),
    };
  }

  private holderName(
    type: string | null,
    id: string,
    users: { id: string; upn: string; display_name: string | null }[],
    caps: { id: string; display_name: string }[],
    ras: { id: string; name: string }[],
  ): string | null {
    if (type === 'user') return users.find((u) => u.id === id)?.display_name || users.find((u) => u.id === id)?.upn || null;
    if (type === 'cap') return caps.find((c) => c.id === id)?.display_name ?? null;
    if (type === 'resource_account') return ras.find((r) => r.id === id)?.name ?? null;
    return null;
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
