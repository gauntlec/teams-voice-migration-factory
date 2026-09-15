import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { tenantDb, type DB } from '@tvmf/db';
import {
  POLICY_KIND_TO_TENANT_TYPE,
  POLICY_KINDS,
  RESOURCE_ACCOUNT_APPLICATION_IDS,
  type BuildAutoAttendantCreateInput,
  type BuildAutoAttendantPatchInput,
  type BuildBulkPatchInput,
  type BuildCallQueueCreateInput,
  type BuildCallQueuePatchInput,
  type BuildCapCreateInput,
  type BuildCapPatchInput,
  type BuildIdentityCreateInput,
  type BuildIdentityPatchInput,
  type BuildListQuery,
  type BuildResourceAccountCreateInput,
  type BuildResourceAccountPatchInput,
  type BuildRowValidation,
  type BuildSiteRollup,
  type BuildTemplateApplyInput,
  type BuildTemplateCreateInput,
  type BuildTemplatePatchInput,
  type BuildValidateResult,
  type CallingPolicySiteMapSetInput,
  type DiscoverySiteOverview,
  type NumberHolderType,
  type NumberType,
  type Paginated,
  type PolicyKey,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import { applyBulkPatch, auditBulkPatch } from '../../common/bulk-patch';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { TenantDiscoveryService } from '../tenant-discovery/tenant-discovery.service';
import { BuildValidationService } from './build-validation.service';

type Scoped = ReturnType<typeof tenantDb>;
const actorOf = (u: AuthedUser) => ({ id: u.id, email: u.email });

@Injectable()
export class BuildService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly validation: BuildValidationService,
    private readonly discovery: TenantDiscoveryService,
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
      s.selectFrom('build_users').select(['id', 'site_id', 'upn', 'e164', 'number_type', 'policies', 'policy_ids']).where('site_id', 'in', siteIds).execute(),
      s.selectFrom('build_caps').select(['id', 'site_id', 'upn', 'e164', 'number_type', 'policies', 'policy_ids']).where('site_id', 'in', siteIds).execute(),
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
  async bulkUpdateUsers(t: TenantContext, u: AuthedUser, body: BuildBulkPatchInput) {
    return this.bulkUpdateIdentity(t, u, 'build_users', 'user', body.ids, body.patch);
  }
  async deleteUser(t: TenantContext, u: AuthedUser, id: string) {
    return this.deleteIdentity(t, u, 'build_users', id);
  }
  async populateUsers(t: TenantContext, u: AuthedUser, siteId: string) {
    const s = this.s(t);
    await this.assertCallingPoliciesMapped(t, siteId, 'discovery_users', 'build_users', 'discovery_user_id');
    // Data Collection's Users tab assigns a real phone_numbers claim (the
    // picker, not the free-text requested_number). Design & Build imports a
    // *copy* of that number as this row's starting target - Data Collection
    // keeps its own claim untouched; it's the input record, not something
    // Populate should consume. See BuildValidationService for the
    // duplicate-number check this now depends on instead of a shared claim.
    const discUsers = await s.selectFrom('discovery_users').select('id').where('site_id', '=', siteId).execute();
    const numbers = await this.currentNumbersFor(t, 'user', discUsers.map((r) => r.id));
    const template = await this.defaultTemplateFor(t, siteId, 'user');
    const callingPolicyMap = await this.callingPolicyMapFor(t, siteId);
    const defaultNumberType = await this.siteNumberTypeDefault(t, siteId);
    return this.populateIdentity(t, u, {
      table: 'build_users',
      sourceTable: 'discovery_users',
      linkColumn: 'discovery_user_id',
      objectType: 'user',
      siteId,
      map: (d) => {
        // Every new row starts from the site's default Users template (if
        // any); a user with a Data Collection calling policy set gets that
        // specific mapped real Voice Routing Policy instead of the
        // template's default - the Teams concept that actually governs
        // local/national/international dialing permission is
        // OnlineVoiceRoutingPolicy, not TeamsCallingPolicy. See
        // assertCallingPoliciesMapped for why one is always known here.
        const policy_ids: Record<string, string | null> = { ...(template?.policy_ids ?? {}) };
        const policies: Record<string, string | null> = { ...(template?.policies ?? {}) };
        const mappedCalling = d.calling_policy_id ? callingPolicyMap.get(d.calling_policy_id) : undefined;
        if (mappedCalling) {
          policy_ids.voice_routing_policy = mappedCalling.id;
          policies.voice_routing_policy = mappedCalling.name;
        }
        const claimedNumber = numbers.get(d.id);
        return {
          upn: d.upn,
          did: d.requested_number,
          e164: claimedNumber?.e164 ?? null,
          phone_number_id: claimedNumber?.id ?? null,
          // Best-effort default so Populate doesn't leave every new row
          // silently missing Set-CsPhoneNumberAssignment - see
          // siteNumberTypeDefault. Only fills in when the site's PSTN/
          // licensing model resolves unambiguously; otherwise left null and
          // flagged by BuildValidationService/the deployment preview instead
          // of guessed.
          number_type: claimedNumber?.e164 ? defaultNumberType : null,
          migration_wave: null,
          policy_ids,
          policies,
          // Discovery's per-user voicemail choice wins when the customer set
          // one; the template's is only a fallback for whichever half is blank.
          voicemail: {
            enabled: d.voicemail_enabled ?? template?.voicemail_enabled ?? null,
            language: d.voicemail_language ?? template?.voicemail_language ?? null,
          },
        };
      },
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
  async bulkUpdateCaps(t: TenantContext, u: AuthedUser, body: BuildBulkPatchInput) {
    return this.bulkUpdateIdentity(t, u, 'build_caps', 'cap', body.ids, body.patch);
  }
  async deleteCap(t: TenantContext, u: AuthedUser, id: string) {
    return this.deleteIdentity(t, u, 'build_caps', id);
  }
  async populateCaps(t: TenantContext, u: AuthedUser, siteId: string) {
    const s = this.s(t);
    await this.assertCallingPoliciesMapped(t, siteId, 'discovery_caps', 'build_caps', 'discovery_cap_id');
    const discCaps = await s.selectFrom('discovery_caps').select('id').where('site_id', '=', siteId).execute();
    const numbers = await this.currentNumbersFor(t, 'cap', discCaps.map((r) => r.id));
    const template = await this.defaultTemplateFor(t, siteId, 'cap');
    const callingPolicyMap = await this.callingPolicyMapFor(t, siteId);
    const defaultNumberType = await this.siteNumberTypeDefault(t, siteId);
    return this.populateIdentity(t, u, {
      table: 'build_caps',
      sourceTable: 'discovery_caps',
      linkColumn: 'discovery_cap_id',
      objectType: 'cap',
      siteId,
      map: (d) => {
        const policy_ids: Record<string, string | null> = { ...(template?.policy_ids ?? {}) };
        const policies: Record<string, string | null> = { ...(template?.policies ?? {}) };
        const mappedCalling = d.calling_policy_id ? callingPolicyMap.get(d.calling_policy_id) : undefined;
        if (mappedCalling) {
          policy_ids.voice_routing_policy = mappedCalling.id;
          policies.voice_routing_policy = mappedCalling.name;
        }
        const claimedNumber = numbers.get(d.id);
        const mapped: Record<string, unknown> = {
          upn: d.upn ?? '',
          display_name: d.display_name,
          phone_model: d.device_model,
          e164: claimedNumber?.e164 ?? null,
          phone_number_id: claimedNumber?.id ?? null,
          // See populateUsers - same best-effort default, same reason.
          number_type: claimedNumber?.e164 ? defaultNumberType : null,
          policy_ids,
          policies,
        };
        // discovery_caps has no per-CAP voicemail choice - the template's is
        // the only source, and only if the template actually sets one.
        if (template && (template.voicemail_enabled !== null || template.voicemail_language !== null)) {
          mapped.voicemail = { enabled: template.voicemail_enabled, language: template.voicemail_language };
        }
        return mapped;
      },
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
    const validated = await this.validation.validateRows(
      t,
      rows as {
        id: string;
        upn: string;
        e164: string | null;
        number_type: string | null;
        policies: Record<string, string | null> | null;
        policy_ids: Record<string, string | null> | null;
      }[],
    );
    // phone_number_id is a native column now (see 0017_build_phone_number_id) -
    // no separate holder lookup needed to know "what number is this row's".
    const items = rows.map((r) => ({ ...r, validation: validated.get(r.id) ?? null }));
    return { items, total: Number(n), page: q.page, limit: q.limit } satisfies Paginated<unknown>;
  }

  private async getIdentity(t: TenantContext, table: 'build_users' | 'build_caps', id: string) {
    const row = await this.s(t).selectFrom(table).selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    const validated = await this.validation.validateRows(t, [row]);
    return { ...row, validation: validated.get(id) ?? null };
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
    const { phone_number_id, policy_ids, ...rest } = body;
    const resolved = policy_ids ? await this.resolvePolicyIds(t, policy_ids) : null;
    // A number is being assigned right here and the caller didn't say what
    // type it is - fill in the site's default rather than let this row start
    // life silently missing Set-CsPhoneNumberAssignment (see siteNumberTypeDefault).
    const number_type =
      rest.number_type ?? (phone_number_id ? await this.siteNumberTypeDefault(t, rest.site_id) : null);
    let row = await this.s(t)
      .insertInto(table)
      .values({
        site_id: rest.site_id,
        upn: rest.upn,
        did: rest.did ?? null,
        ext: rest.ext ?? null,
        number_type,
        revoke_ev: rest.revoke_ev ?? false,
        hold_uri: rest.hold_uri ?? null,
        action: rest.action ?? null,
        migration_wave: rest.migration_wave ?? null,
        comments: rest.comments ?? null,
        hidden: rest.hidden ?? false,
        policies: resolved?.policies ?? rest.policies ?? {},
        policy_ids: resolved?.policy_ids ?? {},
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
        .set({ e164: number?.e164 ?? null, phone_number_id: number?.id ?? null } as never)
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
    const { phone_number_id, policy_ids, ...rest } = body;
    const patch: Record<string, unknown> = { ...rest, updated_at: new Date().toISOString() };
    // pg serialises a plain object to jsonb fine, but a top-level array value
    // gets bound as a native Postgres array instead of JSON text unless
    // stringified first (see schema.ts) - delegates is the one array-shaped
    // field here (call_forwarding/pickup_group are plain objects).
    if (patch.delegates !== undefined) patch.delegates = JSON.stringify(patch.delegates);
    if (phone_number_id !== undefined) {
      Object.assign(patch, await this.applyNumberChange(t, table, holderType, id, phone_number_id, 'number_type' in rest));
    }
    if (policy_ids !== undefined) {
      Object.assign(patch, await this.resolvePolicyIds(t, policy_ids));
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

  /**
   * Applies the same patch to many rows at once - the "select rows, set
   * values once" bulk-edit flow (BulkEditDialog, BuildSiteWorkspace.tsx).
   * Unlike updateIdentity, there's no phone_number_id here (buildBulkPatchSchema
   * excludes it - see packages/shared/src/dto.ts for why) so there's no
   * per-row number-inventory side effect to loop over; policy_ids resolves
   * once (it's the same target for every row) and the whole batch is a
   * single UPDATE ... WHERE id IN (...), not N queries. One summary audit
   * row, not one per affected row - matches populateIdentity's precedent.
   */
  private async bulkUpdateIdentity(
    t: TenantContext,
    u: AuthedUser,
    table: 'build_users' | 'build_caps',
    holderType: NumberHolderType,
    ids: string[],
    body: Record<string, unknown>,
  ): Promise<{ updated: number }> {
    const { policy_ids, ...rest } = body;
    const patch: Record<string, unknown> = { ...rest };
    // Bulk patches are genuinely partial by design - BulkEditDialog starts
    // every field blank (there's no single row to seed "unchanged" from
    // like RecordDialog does for single-row edit), so only the keys the
    // engineer actually touched are present here. policy_ids resolves once
    // (it's the same target for every row) before the shared jsonb-merge
    // patch applies it - see applyBulkPatch's jsonbMergeKeys.
    if (policy_ids !== undefined) {
      const resolved = await this.resolvePolicyIds(t, policy_ids as Partial<Record<string, string | null>>);
      patch.policy_ids = resolved.policy_ids;
      patch.policies = resolved.policies;
    }
    const { updated, appliedPatch } = await applyBulkPatch(this.s(t), table, ids, patch, [
      'policy_ids',
      'policies',
      'voicemail',
    ]);
    await auditBulkPatch(this.audit, t.schema, `build.${holderType}s_bulk_updated`, {
      actor: actorOf(u),
      targetType: `build_${holderType}`,
      ids,
      updated,
      patch: appliedPatch,
    });
    return { updated };
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
      calling_policy_id?: string | null;
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
    // phone_number_id is a native column now (see 0017_build_phone_number_id).
    const items = rows;
    return { items, total: Number(n), page: q.page, limit: q.limit } satisfies Paginated<unknown>;
  }

  async getResourceAccount(t: TenantContext, id: string) {
    const row = await this.s(t).selectFrom('build_resource_accounts').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    return row;
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
    const resolved = body.voice_routing_policy_id
      ? await this.resolvePolicyIds(t, { voice_routing_policy: body.voice_routing_policy_id })
      : null;
    // Same reasoning as createIdentity - default number_type when a number is
    // being assigned right here and the caller didn't say what type it is.
    const number_type =
      body.number_type ?? (body.phone_number_id ? await this.siteNumberTypeDefault(t, body.site_id) : null);
    let row = await this.s(t)
      .insertInto('build_resource_accounts')
      .values({
        site_id: body.site_id,
        display_name: body.display_name,
        kind: body.kind,
        upn: body.upn ?? '',
        location_id: body.location_id ?? null,
        number_type,
        voice_routing_policy: resolved?.policies.voice_routing_policy ?? body.voice_routing_policy ?? null,
        voice_routing_policy_id: resolved?.policy_ids.voice_routing_policy ?? null,
        application_id: body.created ? RESOURCE_ACCOUNT_APPLICATION_IDS[body.kind] : null,
        status: {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (body.phone_number_id) {
      const number = await this.setSingleNumber(t, 'resource_account', row.id, body.phone_number_id);
      row = await this.s(t)
        .updateTable('build_resource_accounts')
        .set({ phone_number: number?.e164 ?? null, phone_number_id: number?.id ?? null })
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
    const { phone_number_id, created, voice_routing_policy_id, ...rest } = body;
    const patch: Record<string, unknown> = { ...rest, updated_at: new Date().toISOString() };
    if (phone_number_id !== undefined) {
      Object.assign(
        patch,
        await this.applyNumberChange(t, 'build_resource_accounts', 'resource_account', id, phone_number_id, 'number_type' in rest),
      );
    }
    if (voice_routing_policy_id !== undefined) {
      const resolved = await this.resolvePolicyIds(t, { voice_routing_policy: voice_routing_policy_id });
      patch.voice_routing_policy = resolved.policies.voice_routing_policy ?? null;
      patch.voice_routing_policy_id = resolved.policy_ids.voice_routing_policy ?? null;
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

  /**
   * Populate also seeds build_call_queues/build_auto_attendants alongside
   * build_resource_accounts, so the narrative discovery fields
   * (business_hours/who_answers/ooh_action/exception_conditions/
   * exception_action/holiday/advanced_features/comments) don't silently
   * vanish the moment this runs - they used to be discarded entirely.
   * Only `comments` maps onto call_queues (-> notes); the rest are AA-only,
   * matching the "no CQ narrative fields" note in buildCallQueueWritable.
   */
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
      if (d.kind === 'auto_attendant') {
        const notes = [d.exception_conditions, d.exception_action].filter(Boolean).join(' / ') || null;
        await s
          .insertInto('build_auto_attendants')
          .values({
            site_id: siteId,
            discovery_resource_account_id: d.id,
            name: d.name,
            resource_accounts: JSON.stringify([]),
            config: {},
            holiday_call_flows: JSON.stringify([]),
            business_hours: d.business_hours,
            ooh_action: d.ooh_action,
            holiday: d.holiday,
            advanced_features: d.advanced_features,
            notes: [d.comments, notes].filter(Boolean).join(' / ') || null,
          })
          .execute();
      } else {
        await s
          .insertInto('build_call_queues')
          .values({
            site_id: siteId,
            discovery_resource_account_id: d.id,
            name: d.name,
            resource_accounts: JSON.stringify([]),
            agents: JSON.stringify([]),
            overflow: {},
            timeout: {},
            notes: d.comments,
          })
          .execute();
      }
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

  /* ========================== call queues ========================== */

  async listCallQueues(t: TenantContext, q: BuildListQuery) {
    const s = this.s(t);
    let base = s.selectFrom('build_call_queues').where('site_id', '=', q.siteId);
    if (q.q) base = base.where('name', 'ilike', `%${q.q}%`);
    const [{ n }] = await base.select((eb) => eb.fn.countAll<number>().as('n')).execute();
    const items = await base.selectAll().orderBy('name').limit(q.limit).offset((q.page - 1) * q.limit).execute();
    return { items, total: Number(n), page: q.page, limit: q.limit } satisfies Paginated<unknown>;
  }

  async getCallQueue(t: TenantContext, id: string) {
    const row = await this.s(t).selectFrom('build_call_queues').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    return row;
  }

  async createCallQueue(t: TenantContext, u: AuthedUser, body: BuildCallQueueCreateInput) {
    this.assertCallQueueLanguage(body.overflow, body.timeout, body.no_agent_action, body.language_id);
    const row = await this.s(t)
      .insertInto('build_call_queues')
      .values({
        site_id: body.site_id,
        name: body.name,
        routing_method: body.routing_method ?? 'Attendant',
        agent_alert_time: body.agent_alert_time ?? 30,
        presence_based_routing: body.presence_based_routing ?? true,
        agents: JSON.stringify(body.agents ?? []),
        overflow: body.overflow ?? {},
        timeout: body.timeout ?? {},
        no_agent_action: body.no_agent_action ?? {},
        no_agent_apply_to: body.no_agent_apply_to ?? null,
        language_id: body.language_id || null,
        resource_accounts: JSON.stringify(body.resource_accounts ?? []),
        notes: body.notes || null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'build.call_queue_created', {
      actor: actorOf(u),
      targetType: 'build_call_queue',
      targetId: row.id,
    });
    return row;
  }

  async updateCallQueue(t: TenantContext, u: AuthedUser, id: string, body: BuildCallQueuePatchInput) {
    const existing = await this.getCallQueue(t, id);
    const overflow = body.overflow !== undefined ? body.overflow : (existing.overflow as Record<string, unknown>);
    const timeout = body.timeout !== undefined ? body.timeout : (existing.timeout as Record<string, unknown>);
    const noAgentAction = body.no_agent_action !== undefined ? body.no_agent_action : (existing.no_agent_action as Record<string, unknown>);
    const languageId = body.language_id !== undefined ? body.language_id : existing.language_id;
    this.assertCallQueueLanguage(overflow, timeout, noAgentAction, languageId);
    const { agents, resource_accounts, ...rest } = body;
    const patch: Record<string, unknown> = { ...rest, updated_at: new Date().toISOString() };
    // pg binds a plain array as a native Postgres array, not jsonb, unless
    // stringified first (see schema.ts) - agents/resource_accounts are the
    // array-shaped fields here (overflow/timeout are plain objects).
    if (agents !== undefined) patch.agents = JSON.stringify(agents);
    if (resource_accounts !== undefined) patch.resource_accounts = JSON.stringify(resource_accounts);
    const row = await this.s(t)
      .updateTable('build_call_queues')
      .set(patch as never)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    await this.audit.tenant(t.schema, 'build.call_queue_updated', {
      actor: actorOf(u),
      targetType: 'build_call_queue',
      targetId: id,
      detail: { fields: Object.keys(patch) },
    });
    return row;
  }

  async deleteCallQueue(t: TenantContext, u: AuthedUser, id: string) {
    const row = await this.s(t).deleteFrom('build_call_queues').where('id', '=', id).returningAll().executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    await this.audit.tenant(t.schema, 'build.call_queue_deleted', { actor: actorOf(u), targetType: 'build_call_queue', targetId: id });
    return { ok: true };
  }

  /** Set-CsCallQueue requires -LanguageId whenever Overflow/Timeout/NoAgentAction is SharedVoicemail. */
  private assertCallQueueLanguage(overflow: unknown, timeout: unknown, noAgentAction: unknown, languageId: string | null | undefined) {
    const action = (v: unknown) => (v as { action?: string } | null | undefined)?.action;
    if (
      (action(overflow) === 'SharedVoicemail' || action(timeout) === 'SharedVoicemail' || action(noAgentAction) === 'SharedVoicemail') &&
      !languageId
    ) {
      throw new BadRequestException('language_id is required when overflow, timeout or no-agent action is SharedVoicemail');
    }
  }

  /* ======================== auto attendants ========================= */

  async listAutoAttendants(t: TenantContext, q: BuildListQuery) {
    const s = this.s(t);
    let base = s.selectFrom('build_auto_attendants').where('site_id', '=', q.siteId);
    if (q.q) base = base.where('name', 'ilike', `%${q.q}%`);
    const [{ n }] = await base.select((eb) => eb.fn.countAll<number>().as('n')).execute();
    const items = await base.selectAll().orderBy('name').limit(q.limit).offset((q.page - 1) * q.limit).execute();
    return { items, total: Number(n), page: q.page, limit: q.limit } satisfies Paginated<unknown>;
  }

  async getAutoAttendant(t: TenantContext, id: string) {
    const row = await this.s(t).selectFrom('build_auto_attendants').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    return row;
  }

  async createAutoAttendant(t: TenantContext, u: AuthedUser, body: BuildAutoAttendantCreateInput) {
    const row = await this.s(t)
      .insertInto('build_auto_attendants')
      .values({
        site_id: body.site_id,
        name: body.name,
        resource_accounts: JSON.stringify([]),
        config: {},
        business_hours: body.business_hours || null,
        ooh_action: body.ooh_action || null,
        holiday: body.holiday || null,
        advanced_features: body.advanced_features || null,
        notes: body.notes || null,
        language_id: body.language_id || null,
        time_zone_id: body.time_zone_id || null,
        voice_id: body.voice_id || null,
        voice_response_enabled: body.voice_response_enabled ?? false,
        operator: body.operator ?? null,
        default_call_flow: body.default_call_flow ?? null,
        after_hours_call_flow: body.after_hours_call_flow ?? null,
        holiday_call_flows: JSON.stringify(body.holiday_call_flows ?? []),
        schedule: body.schedule ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'build.auto_attendant_created', {
      actor: actorOf(u),
      targetType: 'build_auto_attendant',
      targetId: row.id,
    });
    return row;
  }

  async updateAutoAttendant(t: TenantContext, u: AuthedUser, id: string, body: BuildAutoAttendantPatchInput) {
    const { holiday_call_flows, ...rest } = body;
    const patch: Record<string, unknown> = { ...rest, updated_at: new Date().toISOString() };
    // pg binds a plain array as a native Postgres array, not jsonb, unless
    // stringified first (see schema.ts) - holiday_call_flows is the one
    // array-shaped field here (operator/default_call_flow/after_hours_call_flow/
    // schedule are plain objects).
    if (holiday_call_flows !== undefined) patch.holiday_call_flows = JSON.stringify(holiday_call_flows);
    const row = await this.s(t)
      .updateTable('build_auto_attendants')
      .set(patch as never)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    await this.audit.tenant(t.schema, 'build.auto_attendant_updated', {
      actor: actorOf(u),
      targetType: 'build_auto_attendant',
      targetId: id,
      detail: { fields: Object.keys(patch) },
    });
    return row;
  }

  async deleteAutoAttendant(t: TenantContext, u: AuthedUser, id: string) {
    const row = await this.s(t).deleteFrom('build_auto_attendants').where('id', '=', id).returningAll().executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    await this.audit.tenant(t.schema, 'build.auto_attendant_deleted', {
      actor: actorOf(u),
      targetType: 'build_auto_attendant',
      targetId: id,
    });
    return { ok: true };
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
   * read-only. Populate from Discovery copies both the id and the e164 onto
   * the new build row (phone_number_id, e164) as a real reference, not just
   * text - see 0017_build_phone_number_id.sql. Data Collection's own claim
   * (phone_numbers.holder_id) is never touched, so its Number column keeps
   * showing it too. Batched: one query for the whole site.
   */
  private async currentNumbersFor(t: TenantContext, holderType: NumberHolderType, holderIds: string[]) {
    const out = new Map<string, { id: string; e164: string }>();
    if (holderIds.length === 0) return out;
    const rows = await this.s(t)
      .selectFrom('phone_numbers')
      .select(['id', 'e164', 'holder_id'])
      .where('holder_type', '=', holderType)
      .where('holder_id', 'in', holderIds)
      .execute();
    for (const r of rows) if (r.holder_id) out.set(r.holder_id, { id: r.id, e164: r.e164 });
    return out;
  }

  /**
   * Best-effort default for a row's `number_type` (Set-CsPhoneNumberAssignment
   * -PhoneNumberType), derived from the site's "PSTN / licensing model"
   * overview field. Only three of its four values resolve unambiguously to a
   * NumberType - 'Mixed' (and an unset model) can't be guessed and come back
   * null, leaving number_type for the engineer to set by hand on that row (the
   * deployment preview flags it rather than silently skipping the command -
   * see identityRowWarnings/resourceAccountRowWarnings in
   * packages/shared/src/deployment.ts). Never overwrites an explicit choice -
   * callers only use this to fill in a blank.
   */
  private async siteNumberTypeDefault(t: TenantContext, siteId: string): Promise<NumberType | null> {
    const site = await this.s(t).selectFrom('discovery_sites').select('overview').where('id', '=', siteId).executeTakeFirst();
    const licensingModel = (site?.overview as DiscoverySiteOverview | undefined)?.licensingModel;
    return licensingModel === 'DirectRouting' || licensingModel === 'CallingPlan' || licensingModel === 'OperatorConnect'
      ? licensingModel
      : null;
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

  /**
   * Applies a phone_number_id change to a build_users/build_caps/
   * build_resource_accounts row, returning the patch fields to merge in (or
   * `{}` if unchanged). Distinguishes using the row's OWN current
   * phone_number_id column - a plain reference, not phone_numbers.holder_id,
   * which for an imported number stays with discovery_users/discovery_caps
   * (see 0017_build_phone_number_id.sql):
   *  - same id sent back (including both null) -> unchanged, no-op
   *  - a genuinely different id -> atomically claim it (setSingleNumber
   *    releases any *real* claim this holder already had first), set both
   *    the number text column and phone_number_id to match
   *  - explicitly cleared (was set, now null) -> release any real claim this
   *    row holds (a no-op if it only ever had an imported reference and
   *    never a real claim) and clear both columns
   */
  private async applyNumberChange(
    t: TenantContext,
    table: 'build_users' | 'build_caps' | 'build_resource_accounts',
    holderType: NumberHolderType,
    id: string,
    targetPhoneNumberId: string | null,
    /** true when the caller's own patch already set number_type explicitly - skip the site-default fill-in then. */
    explicitNumberType = false,
  ): Promise<Record<string, unknown>> {
    const numberColumn = table === 'build_resource_accounts' ? 'phone_number' : 'e164';
    const current = await this.s(t)
      .selectFrom(table)
      .select(['phone_number_id', 'number_type', 'site_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    const currentId = current?.phone_number_id ?? null;
    if (currentId === targetPhoneNumberId) return {};
    if (targetPhoneNumberId) {
      const claimed = await this.setSingleNumber(t, holderType, id, targetPhoneNumberId);
      const patch: Record<string, unknown> = { [numberColumn]: claimed?.e164 ?? null, phone_number_id: claimed?.id ?? null };
      // A number is newly being assigned here and this row has no number_type
      // yet - fill in the site's default rather than leave
      // Set-CsPhoneNumberAssignment silently unable to fire (see
      // siteNumberTypeDefault). Never overwrites an explicit choice, either
      // this row's existing one or one the same patch is also setting.
      if (!explicitNumberType && !current?.number_type && current?.site_id) {
        const derived = await this.siteNumberTypeDefault(t, current.site_id);
        if (derived) patch.number_type = derived;
      }
      return patch;
    }
    await this.releaseHolder(t, holderType, id); // no-op if this row never held a real claim
    return { [numberColumn]: null, phone_number_id: null };
  }

  /**
   * Resolves a policy_ids patch (one tenant_policies.id per PolicyKey, from
   * the live picker in BuildSiteWorkspace) into the two column values to
   * write together: the durable id (policy_ids), and the policy's current
   * live name (policies) - what Grant-Cs*Policy and the grid display
   * actually need. A submitted id must resolve to a live (not removed_at)
   * tenant_policies row whose type matches POLICY_KIND_TO_TENANT_TYPE for
   * that key - defends against a stale or mismatched id. A key explicitly
   * null clears that assignment. Full-object-replace semantics, same as
   * `policies` already had - RecordDialog always resubmits the complete
   * field set on save, so there's no partial-merge to do here.
   */
  private async resolvePolicyIds(
    t: TenantContext,
    ids: Partial<Record<string, string | null>>,
  ): Promise<{ policy_ids: Record<string, string | null>; policies: Record<string, string | null> }> {
    const wantedIds = [...new Set(Object.values(ids).filter((v): v is string => !!v))];
    const rows = wantedIds.length
      ? await this.s(t)
          .selectFrom('tenant_policies')
          .select(['id', 'name', 'policy_type'])
          .where('id', 'in', wantedIds)
          .where('removed_at', 'is', null)
          .execute()
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const policy_ids: Record<string, string | null> = {};
    const policies: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(ids)) {
      if (!value) {
        policy_ids[key] = null;
        policies[key] = null;
        continue;
      }
      const found = byId.get(value);
      const expectedType = POLICY_KIND_TO_TENANT_TYPE[key as PolicyKey];
      if (!found || (expectedType && found.policy_type !== expectedType)) {
        throw new ConflictException('That policy no longer exists in the tenant - refresh and pick again.');
      }
      policy_ids[key] = value;
      policies[key] = found.name;
    }
    return { policy_ids, policies };
  }

  /**
   * For any row whose target policy is still blank, fills it from the
   * tenant's current live assignment (tenant_users.policies, kept fresh by
   * Discovery or the targeted live check) - a starting point for design,
   * not a standing sync. Never touches a key that already has a target -
   * that's a real design decision, even if it now differs from live (see
   * BuildRowValidation.policyMismatches, which is how that divergence gets
   * surfaced instead - see BuildSiteWorkspace.tsx). Resolves each live name
   * to a real tenant_policies.id where possible, the same "link to actual
   * objects" principle as resolvePolicyIds above - a name that doesn't
   * resolve (tenant renamed it since, or a very unlikely race) still
   * backfills the display name without a policy_ids link, same graceful
   * degradation used elsewhere.
   */
  private async backfillPolicyTargets(
    t: TenantContext,
    rows: { id: string; upn: string; policies: Record<string, string | null> | null; policy_ids: Record<string, string | null> | null }[],
  ): Promise<Map<string, { policies: Record<string, string | null>; policy_ids: Record<string, string | null> }>> {
    const out = new Map<string, { policies: Record<string, string | null>; policy_ids: Record<string, string | null> }>();
    const upns = [...new Set(rows.map((r) => r.upn.toLowerCase()))];
    if (!upns.length) return out;
    const live = await this.s(t)
      .selectFrom('tenant_users')
      .select(['upn', 'policies'])
      .where(sql`lower(upn)`, 'in', upns)
      .where('removed_at', 'is', null)
      .execute();
    const liveByUpn = new Map(live.map((r) => [r.upn.toLowerCase(), r.policies as Record<string, string | null> | null]));

    // What each row actually needs, and every distinct (type, name) that needs resolving to an id.
    const needed = new Map<string, Record<string, string>>(); // rowId -> { key: liveName }
    const byType = new Map<string, Set<string>>();
    for (const row of rows) {
      const liveP = liveByUpn.get(row.upn.toLowerCase());
      if (!liveP) continue;
      const targets = row.policies ?? {};
      const rowNeeds: Record<string, string> = {};
      for (const kind of POLICY_KINDS) {
        if (targets[kind.key]) continue; // already has a target - never overwrite
        const tenantType = POLICY_KIND_TO_TENANT_TYPE[kind.key];
        if (!tenantType) continue; // e.g. dial_out_policy - no live source to backfill from
        const liveName = liveP[tenantType];
        if (!liveName) continue;
        rowNeeds[kind.key] = liveName;
        if (!byType.has(tenantType)) byType.set(tenantType, new Set());
        byType.get(tenantType)!.add(liveName);
      }
      if (Object.keys(rowNeeds).length) needed.set(row.id, rowNeeds);
    }
    if (!needed.size) return out;

    const idByTypeName = new Map<string, string>(); // "type::name" -> id
    for (const [policyType, names] of byType) {
      const found = await this.s(t)
        .selectFrom('tenant_policies')
        .select(['id', 'name'])
        .where('policy_type', '=', policyType)
        .where('removed_at', 'is', null)
        .where('name', 'in', [...names])
        .execute();
      for (const f of found) idByTypeName.set(`${policyType}::${f.name}`, f.id);
    }

    for (const row of rows) {
      const rowNeeds = needed.get(row.id);
      if (!rowNeeds) continue;
      const policies = { ...(row.policies ?? {}) };
      const policy_ids = { ...(row.policy_ids ?? {}) };
      for (const [key, liveName] of Object.entries(rowNeeds)) {
        policies[key] = liveName;
        const tenantType = POLICY_KIND_TO_TENANT_TYPE[key as PolicyKey]!;
        const id = idByTypeName.get(`${tenantType}::${liveName}`);
        if (id) policy_ids[key] = id;
      }
      out.set(row.id, { policies, policy_ids });
    }
    return out;
  }

  /* ============================== validate ============================== */

  /**
   * Snapshot the live-vs-target diff into the `validation` column for every
   * user/cap row on a site. Rows whose UPN has no stored tenant_users match
   * (nothing has synced yet, or a real sync ran but missed that specific
   * person) get a targeted live check - not a full environment re-sync -
   * when a usable tenant connection exists and this isn't itself the
   * post-live-check recheck (`live: false`, see BuildSiteWorkspace.tsx).
   */
  async validateSite(t: TenantContext, u: AuthedUser, siteId: string, live = true): Promise<BuildValidateResult> {
    const s = this.s(t);
    const [users, caps] = await Promise.all([
      s.selectFrom('build_users').select(['id', 'upn', 'e164', 'number_type', 'policies', 'policy_ids']).where('site_id', '=', siteId).execute(),
      s.selectFrom('build_caps').select(['id', 'upn', 'e164', 'number_type', 'policies', 'policy_ids']).where('site_id', '=', siteId).execute(),
    ]);
    const rows = [...users.map((r) => ({ ...r, table: 'build_users' as const })), ...caps.map((r) => ({ ...r, table: 'build_caps' as const }))];
    const validated = await this.validation.validateRows(t, rows);
    const backfills = await this.backfillPolicyTargets(t, rows);
    let issues = 0;
    const unmatchedUpns: string[] = [];
    for (const row of rows) {
      const v = validated.get(row.id);
      if (!v) continue;
      if (hasIssue(v)) issues += 1;
      if (!v.existsInTenant) unmatchedUpns.push(row.upn);
      const patch: Record<string, unknown> = { validation: v };
      const bf = backfills.get(row.id);
      if (bf) Object.assign(patch, bf);
      await s
        .updateTable(row.table)
        .set(patch as never)
        .where('id', '=', row.id)
        .execute();
    }
    await this.audit.tenant(t.schema, 'build.validated', {
      actor: actorOf(u),
      targetType: 'discovery_site',
      targetId: siteId,
      detail: { rows: rows.length, issues },
    });

    let liveCheck: BuildValidateResult['liveCheck'] = null;
    if (live && unmatchedUpns.length) {
      const run = await this.discovery.startTargetedUserRun(t, u, unmatchedUpns);
      if (run) liveCheck = { runId: run.id };
    }
    return { rows: rows.length, issues, liveCheck };
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
      s.deleteFrom('build_call_queues').where('site_id', '=', siteId).execute(),
      s.deleteFrom('build_auto_attendants').where('site_id', '=', siteId).execute(),
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

  /* =================== calling-policy site map =================== */

  /** discovery_users/discovery_caps rows on this site not yet linked to a build row. */
  private async unlinkedSourceIds(
    t: TenantContext,
    siteId: string,
    sourceTable: 'discovery_users' | 'discovery_caps',
    buildTable: 'build_users' | 'build_caps',
    linkColumn: 'discovery_user_id' | 'discovery_cap_id',
  ): Promise<string[]> {
    const s = this.s(t);
    const [source, existing] = await Promise.all([
      s.selectFrom(sourceTable).select('id').where('site_id', '=', siteId).execute(),
      s.selectFrom(buildTable).select(['id', linkColumn]).where('site_id', '=', siteId).execute(),
    ]);
    const linked = new Set(existing.map((e) => (e as Record<string, unknown>)[linkColumn]).filter(Boolean));
    return source.map((r) => r.id).filter((id) => !linked.has(id));
  }

  /** discovery_calling_policies.id -> the real tenant policy this site maps it to, live ones only. */
  private async callingPolicyMapFor(t: TenantContext, siteId: string) {
    const rows = await this.s(t)
      .selectFrom('calling_policy_site_map as m')
      .innerJoin('tenant_policies as tp', 'tp.id', 'm.tenant_policy_id')
      .select(['m.discovery_calling_policy_id as discovery_calling_policy_id', 'm.tenant_policy_id as tenant_policy_id', 'tp.name as tenant_policy_name'])
      .where('m.site_id', '=', siteId)
      .where('tp.removed_at', 'is', null)
      .execute();
    return new Map(rows.map((r) => [r.discovery_calling_policy_id, { id: r.tenant_policy_id, name: r.tenant_policy_name }]));
  }

  /**
   * Blocks Populate for one source (Users or CAPs) until every generic
   * calling-policy catalog entry actually referenced by an unlinked row on
   * this site has a real-tenant-policy mapping - "this mapping needs to be
   * done before data can be imported into the site."
   */
  private async assertCallingPoliciesMapped(
    t: TenantContext,
    siteId: string,
    sourceTable: 'discovery_users' | 'discovery_caps',
    buildTable: 'build_users' | 'build_caps',
    linkColumn: 'discovery_user_id' | 'discovery_cap_id',
  ) {
    const unlinkedIds = await this.unlinkedSourceIds(t, siteId, sourceTable, buildTable, linkColumn);
    if (!unlinkedIds.length) return;
    const used = await this.s(t)
      .selectFrom(sourceTable)
      .select('calling_policy_id')
      .where('id', 'in', unlinkedIds)
      .where('calling_policy_id', 'is not', null)
      .execute();
    const usedIds = [...new Set(used.map((r) => r.calling_policy_id).filter((id): id is string => !!id))];
    if (!usedIds.length) return;
    const map = await this.callingPolicyMapFor(t, siteId);
    const missingIds = usedIds.filter((id) => !map.has(id));
    if (!missingIds.length) return;
    const names = await this.s(t)
      .selectFrom('discovery_calling_policies')
      .select(['id', 'name'])
      .where('id', 'in', missingIds)
      .execute();
    throw new BadRequestException(
      `${names.length} calling polic${names.length === 1 ? 'y isn\'t' : 'ies aren\'t'} mapped to a real tenant policy yet - map ${names.length === 1 ? 'it' : 'them'} in Calling policy map before populating: ${names.map((n) => n.name).join(', ')}.`,
    );
  }

  async listCallingPolicyMap(t: TenantContext, siteId: string) {
    const s = this.s(t);
    const [catalog, map, usedUserIds, usedCapIds] = await Promise.all([
      s.selectFrom('discovery_calling_policies').select(['id', 'name']).orderBy('name').execute(),
      this.callingPolicyMapFor(t, siteId),
      this.unlinkedSourceIds(t, siteId, 'discovery_users', 'build_users', 'discovery_user_id'),
      this.unlinkedSourceIds(t, siteId, 'discovery_caps', 'build_caps', 'discovery_cap_id'),
    ]);
    const usedPolicyIds = new Set<string>();
    for (const [srcTable, ids] of [
      ['discovery_users', usedUserIds],
      ['discovery_caps', usedCapIds],
    ] as const) {
      if (!ids.length) continue;
      const rows = await s
        .selectFrom(srcTable)
        .select('calling_policy_id')
        .where('id', 'in', ids)
        .where('calling_policy_id', 'is not', null)
        .execute();
      for (const r of rows) if (r.calling_policy_id) usedPolicyIds.add(r.calling_policy_id);
    }
    return catalog.map((c) => ({
      discoveryCallingPolicyId: c.id,
      name: c.name,
      inUse: usedPolicyIds.has(c.id),
      tenantPolicyId: map.get(c.id)?.id ?? null,
      tenantPolicyName: map.get(c.id)?.name ?? null,
    }));
  }

  /**
   * The generic calling-policy catalog maps to the site's real Voice Routing
   * Policy (OnlineVoiceRoutingPolicy) - that's the Teams concept that
   * actually governs local/national/international dialing permission, not
   * TeamsCallingPolicy (call features like forwarding/park/busy-on-busy).
   */
  async setCallingPolicyMap(t: TenantContext, u: AuthedUser, body: CallingPolicySiteMapSetInput) {
    const s = this.s(t);
    const policy = await s
      .selectFrom('discovery_calling_policies')
      .select('id')
      .where('id', '=', body.discovery_calling_policy_id)
      .executeTakeFirst();
    if (!policy) throw new NotFoundException('Calling policy not found');
    const target = await s
      .selectFrom('tenant_policies')
      .select(['id', 'policy_type'])
      .where('id', '=', body.tenant_policy_id)
      .where('removed_at', 'is', null)
      .executeTakeFirst();
    if (!target || target.policy_type !== POLICY_KIND_TO_TENANT_TYPE.voice_routing_policy) {
      throw new ConflictException('That policy no longer exists in the tenant - refresh and pick again.');
    }
    const row = await s
      .insertInto('calling_policy_site_map')
      .values({
        site_id: body.site_id,
        discovery_calling_policy_id: body.discovery_calling_policy_id,
        tenant_policy_id: body.tenant_policy_id,
      })
      .onConflict((oc) =>
        oc
          .columns(['site_id', 'discovery_calling_policy_id'])
          .doUpdateSet({ tenant_policy_id: body.tenant_policy_id, updated_at: new Date().toISOString() }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'build.calling_policy_mapped', {
      actor: actorOf(u),
      targetType: 'calling_policy_site_map',
      targetId: row.id,
      detail: { siteId: body.site_id, discoveryCallingPolicyId: body.discovery_calling_policy_id, tenantPolicyId: body.tenant_policy_id },
    });
    return row;
  }

  async deleteCallingPolicyMap(t: TenantContext, u: AuthedUser, id: string) {
    const row = await this.s(t).deleteFrom('calling_policy_site_map').where('id', '=', id).returningAll().executeTakeFirst();
    if (!row) throw new NotFoundException('Mapping not found');
    await this.audit.tenant(t.schema, 'build.calling_policy_unmapped', {
      actor: actorOf(u),
      targetType: 'calling_policy_site_map',
      targetId: id,
    });
    return { ok: true };
  }

  /* ============================== templates ============================== */

  private async defaultTemplateFor(t: TenantContext, siteId: string, kind: 'user' | 'cap') {
    return this.s(t)
      .selectFrom('build_templates')
      .selectAll()
      .where('site_id', '=', siteId)
      .where('kind', '=', kind)
      .where('is_default', '=', true)
      .executeTakeFirst();
  }

  async listTemplates(t: TenantContext, siteId: string, kind?: 'user' | 'cap') {
    let q = this.s(t).selectFrom('build_templates').selectAll().where('site_id', '=', siteId);
    if (kind) q = q.where('kind', '=', kind);
    return q.orderBy('name').execute();
  }

  async createTemplate(t: TenantContext, u: AuthedUser, body: BuildTemplateCreateInput) {
    const resolved = body.policy_ids ? await this.resolvePolicyIds(t, body.policy_ids) : { policy_ids: {}, policies: {} };
    if (body.is_default) {
      await this.s(t)
        .updateTable('build_templates')
        .set({ is_default: false })
        .where('site_id', '=', body.site_id)
        .where('kind', '=', body.kind)
        .execute();
    }
    const row = await this.s(t)
      .insertInto('build_templates')
      .values({
        site_id: body.site_id,
        kind: body.kind,
        name: body.name,
        policy_ids: resolved.policy_ids,
        policies: resolved.policies,
        voicemail_enabled: body.voicemail_enabled ?? null,
        voicemail_language: body.voicemail_language ?? null,
        is_default: body.is_default ?? false,
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'build.template_created', {
      actor: actorOf(u),
      targetType: 'build_template',
      targetId: row.id,
      detail: { name: row.name, kind: row.kind },
    });
    return row;
  }

  async updateTemplate(t: TenantContext, u: AuthedUser, id: string, body: BuildTemplatePatchInput) {
    const existing = await this.s(t).selectFrom('build_templates').select(['id', 'site_id', 'kind']).where('id', '=', id).executeTakeFirst();
    if (!existing) throw new NotFoundException('Template not found');
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.voicemail_enabled !== undefined) patch.voicemail_enabled = body.voicemail_enabled;
    if (body.voicemail_language !== undefined) patch.voicemail_language = body.voicemail_language;
    if (body.policy_ids !== undefined) {
      const resolved = await this.resolvePolicyIds(t, body.policy_ids);
      patch.policy_ids = sql`${sql.ref('policy_ids')} || ${JSON.stringify(resolved.policy_ids)}::jsonb`;
      patch.policies = sql`${sql.ref('policies')} || ${JSON.stringify(resolved.policies)}::jsonb`;
    }
    if (body.is_default === true) {
      await this.s(t)
        .updateTable('build_templates')
        .set({ is_default: false })
        .where('site_id', '=', existing.site_id)
        .where('kind', '=', existing.kind)
        .execute();
      patch.is_default = true;
    } else if (body.is_default === false) {
      patch.is_default = false;
    }
    const row = await this.s(t).updateTable('build_templates').set(patch as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'build.template_updated', { actor: actorOf(u), targetType: 'build_template', targetId: id });
    return row;
  }

  async deleteTemplate(t: TenantContext, u: AuthedUser, id: string) {
    const row = await this.s(t).deleteFrom('build_templates').where('id', '=', id).returningAll().executeTakeFirst();
    if (!row) throw new NotFoundException('Template not found');
    await this.audit.tenant(t.schema, 'build.template_deleted', {
      actor: actorOf(u),
      targetType: 'build_template',
      targetId: id,
      detail: { name: row.name },
    });
    return { ok: true };
  }

  /** Apply one template's policy_ids/voicemail to a set of already-populated
   * rows - reuses the same bulk-patch mechanism as the bulk-edit action, so
   * only the keys the template actually sets change on each selected row. */
  async applyTemplate(t: TenantContext, u: AuthedUser, id: string, ids: string[]) {
    const template = await this.s(t).selectFrom('build_templates').selectAll().where('id', '=', id).executeTakeFirst();
    if (!template) throw new NotFoundException('Template not found');
    const table = template.kind === 'user' ? 'build_users' : 'build_caps';
    const patch: Record<string, unknown> = { policy_ids: template.policy_ids, policies: template.policies };
    if (template.voicemail_enabled !== null || template.voicemail_language !== null) {
      patch.voicemail = { enabled: template.voicemail_enabled, language: template.voicemail_language };
    }
    const { updated, appliedPatch } = await applyBulkPatch(this.s(t), table, ids, patch, ['policy_ids', 'policies']);
    await auditBulkPatch(this.audit, t.schema, `build.${holderTypeOf(table)}s_template_applied`, {
      actor: actorOf(u),
      targetType: `build_${holderTypeOf(table)}`,
      ids,
      updated,
      patch: appliedPatch,
    });
    return { updated };
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
  return (
    !v.existsInTenant ||
    v.numberConflict ||
    v.numberTypeMissing ||
    v.policyMismatches.length > 0 ||
    v.unknownPolicies.length > 0
  );
}

/** Postgres unique_violation (23505) - the (site_id, lower(upn)) index tripped. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
