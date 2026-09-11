import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { tenantDb, type DB } from '@tvmf/db';
import {
  RESOURCE_ACCOUNT_APPLICATION_IDS,
  type BuildCapCreateInput,
  type BuildCapPatchInput,
  type BuildIdentityCreateInput,
  type BuildIdentityPatchInput,
  type BuildListQuery,
  type BuildResourceAccountCreateInput,
  type BuildResourceAccountPatchInput,
  type BuildRowValidation,
  type BuildSiteRollup,
  type NumberHolderType,
  type Paginated,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { BuildValidationService } from './build-validation.service';

type Scoped = ReturnType<typeof tenantDb>;
const actorOf = (u: AuthedUser) => ({ id: u.id, email: u.email });

@Injectable()
export class BuildService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly validation: BuildValidationService,
  ) {}
  private s(t: TenantContext): Scoped {
    return tenantDb(this.db, t.schema);
  }

  /* ============================ site rollup ============================ */

  async siteRollup(t: TenantContext): Promise<BuildSiteRollup[]> {
    const s = this.s(t);
    const sites = await s.selectFrom('discovery_sites').select(['id', 'sitecode', 'name']).orderBy('sitecode').execute();
    if (sites.length === 0) return [];
    const siteIds = sites.map((si) => si.id);

    const [users, caps, ras, deployments] = await Promise.all([
      s.selectFrom('build_users').select(['id', 'site_id', 'upn', 'e164', 'policies']).where('site_id', 'in', siteIds).execute(),
      s.selectFrom('build_caps').select(['id', 'site_id', 'upn', 'e164', 'policies']).where('site_id', 'in', siteIds).execute(),
      s.selectFrom('build_resource_accounts').select(['id', 'site_id']).where('site_id', 'in', siteIds).execute(),
      s
        .selectFrom('deployments')
        .select(['id', 'mode', 'status', 'created_at', sql<string>`scope->>'siteId'`.as('site_id')])
        .orderBy('created_at', 'desc')
        .limit(500)
        .execute(),
    ]);

    const validated = await this.validation.validateRows(t, [...users, ...caps]);
    const issuesBySite = new Map<string, number>();
    for (const row of [...users, ...caps]) {
      const v = validated.get(row.id);
      if (v && hasIssue(v)) issuesBySite.set(row.site_id, (issuesBySite.get(row.site_id) ?? 0) + 1);
    }
    const lastDeploymentBySite = new Map<string, (typeof deployments)[number]>();
    for (const d of deployments) {
      if (d.site_id && !lastDeploymentBySite.has(d.site_id)) lastDeploymentBySite.set(d.site_id, d);
    }
    const countOf = (rows: { site_id: string }[], siteId: string) => rows.filter((r) => r.site_id === siteId).length;

    return sites.map((site) => {
      const last = lastDeploymentBySite.get(site.id);
      return {
        id: site.id,
        sitecode: site.sitecode,
        name: site.name,
        counts: {
          users: countOf(users, site.id),
          caps: countOf(caps, site.id),
          resourceAccounts: countOf(ras, site.id),
        },
        validationIssues: issuesBySite.get(site.id) ?? 0,
        lastDeployment: last
          ? { id: last.id, mode: last.mode as 'dry_run' | 'execute', status: last.status, createdAt: String(last.created_at) }
          : null,
      };
    });
  }

  /* ============================== users ============================== */

  async listUsers(t: TenantContext, q: BuildListQuery) {
    const page = await this.listIdentity(t, 'build_users', q);
    const ctx = await this.discoveryUserContextFor(t, page.items.map((r) => r.discovery_user_id));
    page.items = page.items.map((r) => ({ ...r, ...emptyUserContext(), ...(r.discovery_user_id && ctx.get(r.discovery_user_id)) }));
    return page;
  }
  async getUser(t: TenantContext, id: string) {
    const row = await this.getIdentity(t, 'build_users', id);
    const ctx = await this.discoveryUserContextFor(t, [row.discovery_user_id]);
    return { ...row, ...emptyUserContext(), ...(row.discovery_user_id && ctx.get(row.discovery_user_id)) };
  }

  /**
   * Read-only reference from the linked discovery_users row - what the
   * customer told us in Data Collection, kept visible in Design & Build for
   * comparison, never overwritten there. `requested_number` is the free-text
   * ask (separate from the actual number import, see populateUsers);
   * `caller_id`/`voicemail_enabled`/`voicemail_language` are shown so the
   * engineer can see the requirement next to whichever target field
   * (policies.caller_id_policy, voicemail) they end up setting - there's no
   * direct customer-value -> Teams-policy-name mapping to auto-fill from
   * caller_id, so it's shown, not written.
   */
  private async discoveryUserContextFor(t: TenantContext, discoveryUserIds: (string | null)[]) {
    const ids = [...new Set(discoveryUserIds.filter((id): id is string => !!id))];
    const out = new Map<string, ReturnType<typeof emptyUserContext>>();
    if (ids.length === 0) return out;
    const rows = await this.s(t)
      .selectFrom('discovery_users')
      .select(['id', 'requested_number', 'caller_id', 'voicemail_enabled', 'voicemail_language'])
      .where('id', 'in', ids)
      .execute();
    for (const r of rows) {
      out.set(r.id, {
        requested_number: r.requested_number,
        requested_caller_id: r.caller_id,
        requested_voicemail_enabled: r.voicemail_enabled,
        requested_voicemail_language: r.voicemail_language,
      });
    }
    return out;
  }
  async createUser(t: TenantContext, u: AuthedUser, body: BuildIdentityCreateInput) {
    return this.createIdentity(t, u, 'build_users', 'user', body);
  }
  async updateUser(t: TenantContext, u: AuthedUser, id: string, body: BuildIdentityPatchInput) {
    return this.updateIdentity(t, u, 'build_users', 'user', id, body);
  }
  async deleteUser(t: TenantContext, u: AuthedUser, id: string) {
    return this.deleteIdentity(t, u, 'build_users', id);
  }
  async populateUsers(t: TenantContext, u: AuthedUser, siteId: string) {
    const s = this.s(t);
    // Data Collection's Users tab assigns a real phone_numbers claim (the
    // picker, not the free-text requested_number). Design & Build imports a
    // *copy* of that number as this row's starting target - Data Collection
    // keeps its own claim untouched; it's the input record, not something
    // Populate should consume. See BuildValidationService for the
    // duplicate-number check this now depends on instead of a shared claim.
    const discUsers = await s.selectFrom('discovery_users').select('id').where('site_id', '=', siteId).execute();
    const numbers = await this.currentNumbersFor(t, 'user', discUsers.map((r) => r.id));
    return this.populateIdentity(t, u, {
      table: 'build_users',
      sourceTable: 'discovery_users',
      linkColumn: 'discovery_user_id',
      objectType: 'user',
      siteId,
      map: (d) => ({
        upn: d.upn,
        did: d.requested_number,
        e164: numbers.get(d.id) ?? null,
        migration_wave: null,
        // Starting point only - voicemail_policy (the actual Teams policy
        // name) is still the engineer's call; this is just what the
        // customer told us in Data Collection.
        voicemail: { enabled: d.voicemail_enabled ?? null, language: d.voicemail_language ?? null },
      }),
    });
  }

  /* =============================== caps =============================== */

  async listCaps(t: TenantContext, q: BuildListQuery) {
    const page = await this.listIdentity(t, 'build_caps', q);
    const ctx = await this.discoveryCapContextFor(t, page.items.map((r) => r.discovery_cap_id));
    page.items = page.items.map((r) => ({
      ...r,
      requested_caller_id: (r.discovery_cap_id && ctx.get(r.discovery_cap_id)) ?? null,
    }));
    return page;
  }
  async getCap(t: TenantContext, id: string) {
    const row = await this.getIdentity(t, 'build_caps', id);
    const ctx = await this.discoveryCapContextFor(t, [row.discovery_cap_id]);
    return { ...row, requested_caller_id: (row.discovery_cap_id && ctx.get(row.discovery_cap_id)) ?? null };
  }

  /** Same idea as discoveryUserContextFor - discovery_caps has no voicemail, just caller_id. */
  private async discoveryCapContextFor(t: TenantContext, discoveryCapIds: (string | null)[]) {
    const ids = [...new Set(discoveryCapIds.filter((id): id is string => !!id))];
    const out = new Map<string, string | null>();
    if (ids.length === 0) return out;
    const rows = await this.s(t).selectFrom('discovery_caps').select(['id', 'caller_id']).where('id', 'in', ids).execute();
    for (const r of rows) out.set(r.id, r.caller_id);
    return out;
  }
  async createCap(t: TenantContext, u: AuthedUser, body: BuildCapCreateInput) {
    return this.createIdentity(t, u, 'build_caps', 'cap', body, { display_name: body.display_name ?? null });
  }
  async updateCap(t: TenantContext, u: AuthedUser, id: string, body: BuildCapPatchInput) {
    return this.updateIdentity(t, u, 'build_caps', 'cap', id, body);
  }
  async deleteCap(t: TenantContext, u: AuthedUser, id: string) {
    return this.deleteIdentity(t, u, 'build_caps', id);
  }
  async populateCaps(t: TenantContext, u: AuthedUser, siteId: string) {
    const s = this.s(t);
    const discCaps = await s.selectFrom('discovery_caps').select('id').where('site_id', '=', siteId).execute();
    const numbers = await this.currentNumbersFor(t, 'cap', discCaps.map((r) => r.id));
    return this.populateIdentity(t, u, {
      table: 'build_caps',
      sourceTable: 'discovery_caps',
      linkColumn: 'discovery_cap_id',
      objectType: 'cap',
      siteId,
      map: (d) => ({
        upn: d.upn ?? '',
        display_name: d.display_name,
        phone_model: d.device_model,
        e164: numbers.get(d.id) ?? null,
      }),
      skip: (d) => !d.upn, // a CAP row with no UPN yet can't be provisioned in Teams; leave it in Data Collection
    });
  }

  /* ======================= users/caps - shared core ======================= */

  private async listIdentity(t: TenantContext, table: 'build_users' | 'build_caps', q: BuildListQuery) {
    const s = this.s(t);
    let base = s.selectFrom(table).where('site_id', '=', q.siteId);
    if (q.hidden !== undefined) base = base.where('hidden', '=', q.hidden);
    else base = base.where('hidden', '=', false);
    if (q.q) {
      const like = `%${q.q}%`;
      base = base.where((eb) =>
        eb.or([eb('upn', 'ilike', like), eb('e164', 'ilike', like), eb('did', 'ilike', like)]),
      );
    }
    const [{ n }] = await base.select((eb) => eb.fn.countAll<number>().as('n')).execute();
    const rows = await base
      .selectAll()
      .orderBy('upn')
      .limit(q.limit)
      .offset((q.page - 1) * q.limit)
      .execute();
    const validated = await this.validation.validateRows(t, rows as { id: string; upn: string; e164: string | null; policies: Record<string, string | null> | null }[]);
    const phoneIds = await this.phoneNumberIdsFor(t, holderTypeOf(table), rows.map((r) => r.id));
    const items = rows.map((r) => ({ ...r, validation: validated.get(r.id) ?? null, phone_number_id: phoneIds.get(r.id) ?? null }));
    return { items, total: Number(n), page: q.page, limit: q.limit } satisfies Paginated<unknown>;
  }

  private async getIdentity(t: TenantContext, table: 'build_users' | 'build_caps', id: string) {
    const row = await this.s(t).selectFrom(table).selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    const validated = await this.validation.validateRows(t, [row]);
    const phoneIds = await this.phoneNumberIdsFor(t, holderTypeOf(table), [id]);
    return { ...row, validation: validated.get(id) ?? null, phone_number_id: phoneIds.get(id) ?? null };
  }

  async deleteIdentity(t: TenantContext, u: AuthedUser, table: 'build_users' | 'build_caps', id: string) {
    await this.releaseHolder(t, holderTypeOf(table), id);
    const row = await this.s(t).deleteFrom(table).where('id', '=', id).returningAll().executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    await this.audit.tenant(t.schema, `build.${holderTypeOf(table)}_deleted`, {
      actor: actorOf(u),
      targetType: `build_${holderTypeOf(table)}`,
      targetId: id,
    });
    return { ok: true };
  }

  private async createIdentity(
    t: TenantContext,
    u: AuthedUser,
    table: 'build_users' | 'build_caps',
    objectType: 'user' | 'cap',
    body: BuildIdentityCreateInput,
    extra: Record<string, unknown> = {},
  ) {
    const { phone_number_id, ...rest } = body;
    let row = await this.s(t)
      .insertInto(table)
      .values({
        site_id: rest.site_id,
        upn: rest.upn,
        did: rest.did ?? null,
        ext: rest.ext ?? null,
        number_type: rest.number_type ?? null,
        revoke_ev: rest.revoke_ev ?? false,
        hold_uri: rest.hold_uri ?? null,
        action: rest.action ?? null,
        migration_wave: rest.migration_wave ?? null,
        comments: rest.comments ?? null,
        hidden: rest.hidden ?? false,
        policies: rest.policies ?? {},
        voicemail: rest.voicemail ?? {},
        call_forwarding: rest.call_forwarding ?? {},
        delegates: rest.delegates ?? [],
        pickup_group: rest.pickup_group ?? {},
        validation: {},
        status: {},
        ...extra,
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow()
      .catch((err) => {
        throw isUniqueViolation(err) ? new ConflictException('That UPN is already on this site’s Build grid.') : err;
      });
    if (phone_number_id) {
      const number = await this.setSingleNumber(t, holderTypeOf(table), row.id, phone_number_id);
      row = await this.s(t)
        .updateTable(table)
        .set({ e164: number?.e164 ?? null } as never)
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    await this.audit.tenant(t.schema, `build.${objectType}_created`, {
      actor: actorOf(u),
      targetType: `build_${objectType}`,
      targetId: row.id,
    });
    return row;
  }

  private async updateIdentity(
    t: TenantContext,
    u: AuthedUser,
    table: 'build_users' | 'build_caps',
    holderType: NumberHolderType,
    id: string,
    body: BuildIdentityPatchInput & Record<string, unknown>,
  ) {
    const { phone_number_id, ...rest } = body;
    const patch: Record<string, unknown> = { ...rest, updated_at: new Date().toISOString() };
    if (phone_number_id !== undefined) {
      const number = await this.setSingleNumber(t, holderType, id, phone_number_id);
      patch.e164 = number?.e164 ?? null;
    }
    const row = await this.s(t)
      .updateTable(table)
      .set(patch as never)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()
      .catch((err) => {
        throw isUniqueViolation(err) ? new ConflictException('That UPN is already on this site’s Build grid.') : err;
      });
    if (!row) throw new NotFoundException('row not found');
    await this.audit.tenant(t.schema, `build.${holderType}_updated`, {
      actor: actorOf(u),
      targetType: `build_${holderType}`,
      targetId: id,
      detail: { fields: Object.keys(patch) },
    });
    return row;
  }

  private async populateIdentity<
    Src extends {
      id: string;
      site_id: string | null;
      upn: string | null;
      display_name?: string | null;
      requested_number?: string | null;
      device_model?: string | null;
      voicemail_enabled?: boolean | null;
      voicemail_language?: string | null;
    },
  >(
    t: TenantContext,
    u: AuthedUser,
    opts: {
      table: 'build_users' | 'build_caps';
      sourceTable: 'discovery_users' | 'discovery_caps';
      linkColumn: 'discovery_user_id' | 'discovery_cap_id';
      objectType: 'user' | 'cap';
      siteId: string;
      map: (d: Src) => Record<string, unknown>;
      skip?: (d: Src) => boolean;
    },
  ) {
    const s = this.s(t);
    const source = (await s
      .selectFrom(opts.sourceTable)
      .selectAll()
      .where('site_id', '=', opts.siteId)
      .execute()) as unknown as Src[];
    const existing = await s
      .selectFrom(opts.table)
      .select(['id', opts.linkColumn])
      .where('site_id', '=', opts.siteId)
      .execute();
    const linked = new Set(existing.map((e) => (e as Record<string, unknown>)[opts.linkColumn]).filter(Boolean));

    let created = 0;
    let skipped = 0;
    for (const d of source) {
      if (linked.has(d.id)) continue; // already populated from this discovery row
      if (opts.skip?.(d)) {
        skipped += 1;
        continue;
      }
      const mapped = opts.map(d);
      if (!mapped.upn) {
        skipped += 1;
        continue;
      }
      const res = await s
        .insertInto(opts.table)
        .values({
          site_id: opts.siteId,
          [opts.linkColumn]: d.id,
          policies: {},
          voicemail: {},
          call_forwarding: {},
          delegates: [],
          pickup_group: {},
          validation: {},
          status: {},
          ...mapped,
        } as never)
        // idx_build_users_site_upn / idx_build_caps_site_upn are expression
        // indexes (site_id, lower(upn)) - .columns() only handles plain
        // columns, .expression() is the Kysely API for expression indexes.
        // NB: Kysely wraps the expression in its own parens when compiling
        // ("on conflict (" + expr + ")"), so passing an already-parenthesized
        // sql fragment double-wraps it into a single row-constructor
        // ("((a, b))"), which Postgres rejects as a conflict target - no
        // surrounding parens here.
        .onConflict((oc) => oc.expression(sql`site_id, lower(upn)`).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (res?.id) created += 1;
      else skipped += 1; // UPN already present under a different (unlinked) row
    }
    await this.audit.tenant(t.schema, `build.${opts.objectType}s_populated`, {
      actor: actorOf(u),
      targetType: 'discovery_site',
      targetId: opts.siteId,
      detail: { created, skipped, total: source.length },
    });
    return { created, skipped, total: source.length };
  }

  /* ======================== resource accounts ======================== */

  async listResourceAccounts(t: TenantContext, q: BuildListQuery) {
    const s = this.s(t);
    let base = s.selectFrom('build_resource_accounts').where('site_id', '=', q.siteId);
    if (q.q) {
      const like = `%${q.q}%`;
      base = base.where((eb) => eb.or([eb('upn', 'ilike', like), eb('display_name', 'ilike', like)]));
    }
    const [{ n }] = await base.select((eb) => eb.fn.countAll<number>().as('n')).execute();
    const rows = await base
      .selectAll()
      .orderBy('display_name')
      .limit(q.limit)
      .offset((q.page - 1) * q.limit)
      .execute();
    const phoneIds = await this.phoneNumberIdsFor(t, 'resource_account', rows.map((r) => r.id));
    const items = rows.map((r) => ({ ...r, phone_number_id: phoneIds.get(r.id) ?? null }));
    return { items, total: Number(n), page: q.page, limit: q.limit } satisfies Paginated<unknown>;
  }

  async getResourceAccount(t: TenantContext, id: string) {
    const row = await this.s(t).selectFrom('build_resource_accounts').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    const phoneIds = await this.phoneNumberIdsFor(t, 'resource_account', [id]);
    return { ...row, phone_number_id: phoneIds.get(id) ?? null };
  }

  async deleteResourceAccount(t: TenantContext, u: AuthedUser, id: string) {
    await this.releaseHolder(t, 'resource_account', id);
    const row = await this.s(t).deleteFrom('build_resource_accounts').where('id', '=', id).returningAll().executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    await this.audit.tenant(t.schema, 'build.resource_account_deleted', {
      actor: actorOf(u),
      targetType: 'build_resource_account',
      targetId: id,
    });
    return { ok: true };
  }

  async createResourceAccount(t: TenantContext, u: AuthedUser, body: BuildResourceAccountCreateInput) {
    let row = await this.s(t)
      .insertInto('build_resource_accounts')
      .values({
        site_id: body.site_id,
        display_name: body.display_name,
        kind: body.kind,
        upn: body.upn ?? '',
        location_id: body.location_id ?? null,
        number_type: body.number_type ?? null,
        voice_routing_policy: body.voice_routing_policy ?? null,
        application_id: body.created ? RESOURCE_ACCOUNT_APPLICATION_IDS[body.kind] : null,
        status: {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (body.phone_number_id) {
      const number = await this.setSingleNumber(t, 'resource_account', row.id, body.phone_number_id);
      row = await this.s(t)
        .updateTable('build_resource_accounts')
        .set({ phone_number: number?.e164 ?? null })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    await this.audit.tenant(t.schema, 'build.resource_account_created', {
      actor: actorOf(u),
      targetType: 'build_resource_account',
      targetId: row.id,
    });
    return row;
  }

  async updateResourceAccount(t: TenantContext, u: AuthedUser, id: string, body: BuildResourceAccountPatchInput) {
    const { phone_number_id, created, ...rest } = body;
    const patch: Record<string, unknown> = { ...rest, updated_at: new Date().toISOString() };
    if (phone_number_id !== undefined) {
      const number = await this.setSingleNumber(t, 'resource_account', id, phone_number_id);
      patch.phone_number = number?.e164 ?? null;
    }
    if (created !== undefined) {
      const row = await this.getResourceAccount(t, id);
      patch.application_id = created ? RESOURCE_ACCOUNT_APPLICATION_IDS[row.kind] : null;
    }
    const row = await this.s(t)
      .updateTable('build_resource_accounts')
      .set(patch as never)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    await this.audit.tenant(t.schema, 'build.resource_account_updated', {
      actor: actorOf(u),
      targetType: 'build_resource_account',
      targetId: id,
      detail: { fields: Object.keys(patch) },
    });
    return row;
  }

  async populateResourceAccounts(t: TenantContext, u: AuthedUser, siteId: string) {
    const s = this.s(t);
    const source = await s.selectFrom('discovery_resource_accounts').selectAll().where('site_id', '=', siteId).execute();
    const existing = await s
      .selectFrom('build_resource_accounts')
      .select(['discovery_resource_account_id'])
      .where('site_id', '=', siteId)
      .execute();
    const linked = new Set(existing.map((e) => e.discovery_resource_account_id).filter(Boolean));
    let created = 0;
    for (const d of source) {
      if (linked.has(d.id)) continue;
      await s
        .insertInto('build_resource_accounts')
        .values({
          site_id: siteId,
          discovery_resource_account_id: d.id,
          display_name: d.name,
          kind: d.kind,
          upn: '',
          status: {},
        })
        .execute();
      created += 1;
    }
    await this.audit.tenant(t.schema, 'build.resource_accounts_populated', {
      actor: actorOf(u),
      targetType: 'discovery_site',
      targetId: siteId,
      detail: { created, total: source.length },
    });
    return { created, skipped: source.length - created, total: source.length };
  }

  /** Well-known Microsoft ApplicationId for this account's kind - what New-CsOnlineApplicationInstance needs. */
  applicationIdFor(kind: 'auto_attendant' | 'call_queue') {
    return RESOURCE_ACCOUNT_APPLICATION_IDS[kind];
  }

  /* ==================== phone_numbers atomic assignment ====================
   * Same claim/release pattern as DataCollectionTelephonyService (private
   * there): a 1:1 holder (user/cap/resource_account) reconciles to exactly one
   * `phone_numbers` row, atomically, so two Build rows can never claim the same
   * DID. */

  /** Batched lookup of each holder's current phone_numbers.id, for the "current selection" in a picker. */
  private async phoneNumberIdsFor(t: TenantContext, holderType: NumberHolderType, holderIds: string[]) {
    const out = new Map<string, string>();
    if (holderIds.length === 0) return out;
    const rows = await this.s(t)
      .selectFrom('phone_numbers')
      .select(['id', 'holder_id'])
      .where('holder_type', '=', holderType)
      .where('holder_id', 'in', holderIds)
      .execute();
    for (const r of rows) if (r.holder_id) out.set(r.holder_id, r.id);
    return out;
  }

  private async claimNumber(t: TenantContext, numberId: string, holderType: NumberHolderType, holderId: string) {
    const res = await this.s(t)
      .updateTable('phone_numbers')
      .set({ holder_type: holderType, holder_id: holderId, status: 'assigned' })
      .where('id', '=', numberId)
      .where('holder_id', 'is', null)
      .where('status', '=', 'available')
      .executeTakeFirst();
    if (!Number(res.numUpdatedRows)) {
      const n = await this.s(t).selectFrom('phone_numbers').select('status').where('id', '=', numberId).executeTakeFirst();
      if (!n) throw new NotFoundException('phone number not found');
      throw new ConflictException(n.status === 'reserved' ? 'That number is reserved.' : 'That number is already assigned.');
    }
  }

  /**
   * The number a discovery_users/discovery_caps row currently has claimed in
   * the shared `phone_numbers` inventory (via Data Collection's own picker) -
   * read-only. Populate from Discovery copies this as a build row's starting
   * `e164`; Data Collection's claim is never touched, so its own Number
   * column keeps showing it too. Batched: one query for the whole site.
   */
  private async currentNumbersFor(t: TenantContext, holderType: NumberHolderType, holderIds: string[]) {
    const out = new Map<string, string>();
    if (holderIds.length === 0) return out;
    const rows = await this.s(t)
      .selectFrom('phone_numbers')
      .select(['e164', 'holder_id'])
      .where('holder_type', '=', holderType)
      .where('holder_id', 'in', holderIds)
      .execute();
    for (const r of rows) if (r.holder_id) out.set(r.holder_id, r.e164);
    return out;
  }

  private async releaseHolder(t: TenantContext, holderType: NumberHolderType, holderId: string) {
    await this.s(t)
      .updateTable('phone_numbers')
      .set({ holder_type: null, holder_id: null, status: 'available' })
      .where('holder_type', '=', holderType)
      .where('holder_id', '=', holderId)
      .execute();
  }

  private async setSingleNumber(t: TenantContext, holderType: NumberHolderType, holderId: string, numberId: string | null) {
    const current = await this.s(t)
      .selectFrom('phone_numbers')
      .select('id')
      .where('holder_type', '=', holderType)
      .where('holder_id', '=', holderId)
      .executeTakeFirst();
    if ((current?.id ?? null) === numberId) {
      return numberId ? await this.s(t).selectFrom('phone_numbers').selectAll().where('id', '=', numberId).executeTakeFirst() : null;
    }
    if (current) await this.releaseHolder(t, holderType, current.id);
    if (!numberId) return null;
    await this.claimNumber(t, numberId, holderType, holderId);
    return this.s(t).selectFrom('phone_numbers').selectAll().where('id', '=', numberId).executeTakeFirstOrThrow();
  }

  /* ============================== validate ============================== */

  /** Snapshot the live-vs-target diff into the `validation` column for every user/cap row on a site. */
  async validateSite(t: TenantContext, u: AuthedUser, siteId: string) {
    const s = this.s(t);
    const [users, caps] = await Promise.all([
      s.selectFrom('build_users').select(['id', 'upn', 'e164', 'policies']).where('site_id', '=', siteId).execute(),
      s.selectFrom('build_caps').select(['id', 'upn', 'e164', 'policies']).where('site_id', '=', siteId).execute(),
    ]);
    const rows = [...users.map((r) => ({ ...r, table: 'build_users' as const })), ...caps.map((r) => ({ ...r, table: 'build_caps' as const }))];
    const validated = await this.validation.validateRows(t, rows);
    let issues = 0;
    for (const row of rows) {
      const v = validated.get(row.id);
      if (!v) continue;
      if (hasIssue(v)) issues += 1;
      await s
        .updateTable(row.table)
        .set({ validation: v as never })
        .where('id', '=', row.id)
        .execute();
    }
    await this.audit.tenant(t.schema, 'build.validated', {
      actor: actorOf(u),
      targetType: 'discovery_site',
      targetId: siteId,
      detail: { rows: rows.length, issues },
    });
    return { rows: rows.length, issues };
  }

  /* ============================== reset ============================== */

  /**
   * Wipe every build_users/build_caps/build_resource_accounts row for a site
   * so Populate from Discovery can start fresh. Releases any phone_numbers
   * those rows held back to 'available' first - this never touches the
   * customer tenant itself, only Voxshift's own draft configuration, and
   * discovery_users/discovery_caps in Data Collection (the source data) are
   * untouched, so re-populating recovers everything.
   */
  async resetSite(t: TenantContext, u: AuthedUser, siteId: string) {
    const s = this.s(t);
    const [users, caps, ras] = await Promise.all([
      s.selectFrom('build_users').select('id').where('site_id', '=', siteId).execute(),
      s.selectFrom('build_caps').select('id').where('site_id', '=', siteId).execute(),
      s.selectFrom('build_resource_accounts').select('id').where('site_id', '=', siteId).execute(),
    ]);
    const releaseAll = async (holderType: NumberHolderType, ids: string[]) => {
      if (ids.length === 0) return;
      await s
        .updateTable('phone_numbers')
        .set({ holder_type: null, holder_id: null, status: 'available' })
        .where('holder_type', '=', holderType)
        .where(
          'holder_id',
          'in',
          ids as never,
        )
        .execute();
    };
    await Promise.all([
      releaseAll('user', users.map((r) => r.id)),
      releaseAll('cap', caps.map((r) => r.id)),
      releaseAll('resource_account', ras.map((r) => r.id)),
    ]);
    await Promise.all([
      s.deleteFrom('build_users').where('site_id', '=', siteId).execute(),
      s.deleteFrom('build_caps').where('site_id', '=', siteId).execute(),
      s.deleteFrom('build_resource_accounts').where('site_id', '=', siteId).execute(),
    ]);
    const counts = { users: users.length, caps: caps.length, resourceAccounts: ras.length };
    await this.audit.tenant(t.schema, 'build.site_reset', {
      actor: actorOf(u),
      targetType: 'discovery_site',
      targetId: siteId,
      detail: counts,
    });
    return counts;
  }
}

/** Default shape for a build_users row with no (or an unlinked) discovery_users row. */
function emptyUserContext() {
  return {
    requested_number: null as string | null,
    requested_caller_id: null as string | null,
    requested_voicemail_enabled: null as boolean | null,
    requested_voicemail_language: null as string | null,
  };
}

function holderTypeOf(table: 'build_users' | 'build_caps'): NumberHolderType {
  return table === 'build_users' ? 'user' : 'cap';
}

function hasIssue(v: BuildRowValidation): boolean {
  return !v.existsInTenant || v.numberConflict || v.policyMismatches.length > 0 || v.unknownPolicies.length > 0;
}

/** Postgres unique_violation (23505) - the (site_id, lower(upn)) index tripped. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
