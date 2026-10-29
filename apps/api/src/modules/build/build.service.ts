import { AsyncLocalStorage } from 'node:async_hooks';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { computeSiteDrift, coolingUntil, makeAutoAttendantTargetResolver, refreshNumberConflict, resolveLiveNumberTypes, tenantDb, type DB } from '@tvmf/db';
import {
  identityDriftNotAccepted,
  VOICE_AUDIO_MAX_BYTES,
  VOICE_AUDIO_TYPES,
  coolingMessage,
  PARKED_NUMBER_MESSAGE,
  type BuildDriftAcceptInput,
  CALL_QUEUE_NO_AGENT_ACTIONS,
  CALL_QUEUE_NO_AGENT_APPLY_TO,
  CALL_QUEUE_OVERFLOW_ACTIONS,
  CALL_QUEUE_ROUTING_METHODS,
  CALL_QUEUE_TIMEOUT_ACTIONS,
  convertAutoAttendantWizard,
  convertCallQueueWizard,
  decodeCallQueueEnum,
  liveAutoAttendantToStructured,
  liveCallQueueActionExtras,
  liveIdList,
  POLICY_KIND_TO_TENANT_TYPE,
  POLICY_KINDS,
  renderCommand,
  RESOURCE_ACCOUNT_APPLICATION_IDS,
  type AutoAttendantCallableEntity,
  type AutoAttendantWizardAnswers,
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
  type BuildSharedCallingPolicyCreateInput,
  type BuildSharedCallingPolicyPatchInput,
  type BuildSiteRollup,
  type BuildTemplateApplyInput,
  type BuildTemplateCreateInput,
  type BuildTemplatePatchInput,
  type AddFromDiscoveryInput,
  type AddFromDiscoveryItemResult,
  type BuildIssueRow,
  type BuildQuickAddResult,
  type BuildValidateResult,
  type CallingPolicySiteMapSetInput,
  type CallQueueWizardAnswers,
  type DiscoverySiteOverview,
  type LiveCallableEntityRef,
  type NumberHolderType,
  type NumberType,
  type Paginated,
  type PolicyKey,
  DESIGN_ONLY_ISSUE_CODES,
  SR_STATUSES,
  srDesignLockedMessage,
  srDesignLocksRows,
  srReference,
  hasValidationIssue,
  lineUriToNumber,
  upnSchema,
  validationIssues,
  type LiveCallingSettings,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import { applyBulkPatch, auditBulkPatch } from '../../common/bulk-patch';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { DeploymentDocumentService } from '../deployment/deployment-document.service';
import { FilesService } from '../files/files.service';
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
    private readonly documentBuilder: DeploymentDocumentService,
    private readonly files: FilesService,
  ) {}
  /** The open transaction, while inTx is running - see inTx. */
  private readonly tx = new AsyncLocalStorage<Scoped>();

  private s(t: TenantContext): Scoped {
    return this.tx.getStore() ?? tenantDb(this.db, t.schema);
  }

  /**
   * Runs `fn` with every `this.s(t)` inside it on one database transaction,
   * so a change that touches the number inventory and a build row either
   * fully happens or not at all. Before this, a number could be claimed (and
   * the old one freed) and then the row update fail - e.g. a UPN clash -
   * leaving the inventory and the row disagreeing. Nested calls join the
   * outer transaction.
   */
  private inTx<T>(t: TenantContext, fn: () => Promise<T>): Promise<T> {
    if (this.tx.getStore()) return fn();
    return this.db.transaction().execute((trx) => this.tx.run(tenantDb(trx, t.schema), fn));
  }

  /**
   * Adds `service_requests` (e.g. ["SR-0042"]) to each row: the Managed
   * Services requests it was designed for, shown as a tag in Design & Build.
   */
  private async withSrRefs<T extends { id: string }>(t: TenantContext, rows: T[]): Promise<(T & { service_requests: string[] })[]> {
    if (rows.length === 0) return [];
    const links = await this.s(t)
      .selectFrom('service_request_items as i')
      .innerJoin('service_requests as r', 'r.id', 'i.request_id')
      .select(['i.row_id', 'r.number'])
      .where('i.row_id', 'in', rows.map((r) => r.id))
      .orderBy('r.number')
      .execute();
    const byRow = new Map<string, string[]>();
    for (const l of links) byRow.set(l.row_id, [...(byRow.get(l.row_id) ?? []), srReference(l.number)]);
    return rows.map((r) => ({ ...r, service_requests: byRow.get(r.id) ?? [] }));
  }

  /**
   * Managed Services: refuses (409) to change or delete rows linked to a
   * request that locks its design - Designed & built, waiting to deploy (see
   * srDesignLocksRows). Called first by every update / delete / bulk path,
   * before any side effect such as releasing a number. Rows on no request,
   * or only on Planned or finished ones, pass. No role overrides it.
   */
  async assertNotSrLocked(t: TenantContext, rowIds: string[]) {
    if (rowIds.length === 0) return;
    const hit = await this.s(t)
      .selectFrom('service_request_items as i')
      .innerJoin('service_requests as r', 'r.id', 'i.request_id')
      .select(['r.number', 'r.status'])
      .where('i.row_id', 'in', rowIds)
      .where('r.status', 'in', SR_STATUSES.filter(srDesignLocksRows))
      .orderBy('r.number')
      .executeTakeFirst();
    if (hit) throw new ConflictException(srDesignLockedMessage(hit.number, hit.status));
  }

  /* ============================ site rollup ============================ */

  async siteRollup(t: TenantContext): Promise<BuildSiteRollup[]> {
    const s = this.s(t);
    const sites = await s.selectFrom('discovery_sites').select(['id', 'sitecode', 'name']).orderBy('sitecode').execute();
    if (sites.length === 0) return [];
    const siteIds = sites.map((si) => si.id);

    const [users, caps, ras, deployments] = await Promise.all([
      s.selectFrom('build_users').select(['id', 'site_id', 'upn', 'e164', 'number_type', 'policies', 'policy_ids', 'discovery_user_id', 'number_decision']).where('site_id', 'in', siteIds).execute(),
      s.selectFrom('build_caps').select(['id', 'site_id', 'upn', 'e164', 'number_type', 'policies', 'policy_ids', 'discovery_cap_id', 'number_decision']).where('site_id', 'in', siteIds).execute(),
      s.selectFrom('build_resource_accounts').select(['id', 'site_id']).where('site_id', 'in', siteIds).execute(),
      // One row per site (its own latest), not the tenant's latest 500 rows
      // overall - a flat `.limit(500)` silently dropped a quieter site's
      // whole history once other sites' activity pushed it out of that
      // tenant-wide window (confirmed live on a busy tenant this session).
      s
        .selectFrom('deployments')
        .select(['id', 'mode', 'status', 'created_at', 'summary', sql<string>`scope->>'siteId'`.as('site_id')])
        .distinctOn(sql`scope->>'siteId'`)
        .orderBy(sql`scope->>'siteId'`)
        .orderBy('created_at', 'desc')
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
          ? {
              id: last.id,
              mode: last.mode as 'dry_run' | 'execute',
              status: last.status,
              createdAt: String(last.created_at),
              failed: Number((last.summary as Record<string, number> | null)?.failed ?? 0),
            }
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
   * customer told us in Site Data, kept visible in Design & Build for
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
  /**
   * Quick add: the engineer types only UPNs and each row is imported from the discovered tenant data - the live number
   * (and its type), the live policy assignments and, once a Validate check has read it, the voicemail settings. For a
   * common area phone the tenant's display name too. Linked to the site's Site Data record when it has one.
   * A UPN that is not in the discovered data is reported, not added: Validate against tenant can find it live.
   */
  async quickAddIdentity(t: TenantContext, u: AuthedUser, table: 'build_users' | 'build_caps', objectType: 'user' | 'cap', siteId: string, rawUpns: string[]): Promise<BuildQuickAddResult> {
    const s = this.s(t);
    const result: BuildQuickAddResult = { added: [], alreadyThere: [], notFound: [] };
    const upns: string[] = [];
    for (const raw of rawUpns.flatMap((r) => r.split(/[\s,;]+/)).filter(Boolean)) {
      const parsed = upnSchema.safeParse(raw);
      if (!parsed.success) result.notFound.push(raw);
      else if (!upns.includes(parsed.data)) upns.push(parsed.data);
    }
    if (!upns.length) return result;

    const live = await s
      .selectFrom('tenant_users')
      .select(['upn', 'display_name', 'line_uri', 'voicemail_enabled', 'voicemail_prompt_language'])
      .where('removed_at', 'is', null)
      .where(sql`lower(upn)`, 'in', upns)
      .execute();
    const liveByUpn = new Map(live.map((r) => [r.upn.toLowerCase(), r]));
    const numbers = live.map((r) => lineUriToNumber(r.line_uri)).filter((n): n is string => !!n);
    const [numberTypes, inventory, links] = await Promise.all([
      resolveLiveNumberTypes(s, numbers),
      numbers.length ? s.selectFrom('phone_numbers').select(['id', 'e164']).where('e164', 'in', numbers).execute() : Promise.resolve([]),
      objectType === 'user'
        ? s.selectFrom('discovery_users').select(['id', 'upn']).where('site_id', '=', siteId).where(sql`lower(upn)`, 'in', upns).execute()
        : s.selectFrom('discovery_caps').select(['id', 'upn']).where('site_id', '=', siteId).where(sql`lower(upn)`, 'in', upns).execute(),
    ]);
    const inventoryByNumber = new Map(inventory.map((n) => [n.e164, n.id]));
    const linkByUpn = new Map(links.map((l) => [(l.upn ?? '').toLowerCase(), l.id]));
    const defaultType = await this.siteNumberTypeDefault(t, siteId);

    const created: { id: string; upn: string; policies: Record<string, string | null>; policy_ids: Record<string, string | null> }[] = [];
    for (const upn of upns) {
      const l = liveByUpn.get(upn);
      if (!l) {
        result.notFound.push(upn);
        continue;
      }
      const e164 = lineUriToNumber(l.line_uri);
      const row = await s
        .insertInto(table)
        .values({
          site_id: siteId,
          upn: l.upn,
          ...(objectType === 'user' ? { discovery_user_id: linkByUpn.get(upn) ?? null } : { discovery_cap_id: linkByUpn.get(upn) ?? null, display_name: l.display_name }),
          e164,
          phone_number_id: e164 ? (inventoryByNumber.get(e164) ?? null) : null,
          number_type: e164 ? (numberTypes.get(e164) ?? defaultType) : null,
          policies: {},
          policy_ids: {},
          voicemail: l.voicemail_enabled === null ? {} : { enabled: l.voicemail_enabled, language: l.voicemail_prompt_language },
          call_forwarding: {},
          delegates: [],
          pickup_group: {},
          validation: {},
          status: {},
        } as never)
        .onConflict((oc) => oc.expression(sql`site_id, lower(upn)`).doNothing())
        .returning(['id', 'upn'])
        .executeTakeFirst();
      if (!row) {
        result.alreadyThere.push(l.upn);
        continue;
      }
      created.push({ id: row.id, upn: row.upn, policies: {}, policy_ids: {} });
      result.added.push({ id: row.id, upn: row.upn, displayName: l.display_name, number: e164 });
    }

    // The live policy assignments become the starting targets (the same backfill Validate uses).
    const backfills = await this.backfillPolicyTargets(t, created);
    for (const [id, patch] of backfills) await s.updateTable(table).set(patch as never).where('id', '=', id).execute();
    await this.applyLiveVoiceSettings(t, table, siteId, created.map((c) => c.upn));

    await this.audit.tenant(t.schema, `build.${objectType}s_quick_added`, {
      actor: actorOf(u),
      targetType: 'discovery_site',
      targetId: siteId,
      detail: { added: result.added.length, alreadyThere: result.alreadyThere.length, notFound: result.notFound.length },
    });
    return result;
  }

  /**
   * Starts a Design & Build row's call forwarding, delegates, call group and voicemail from what the tenant has for that user (the
   * sync reads Get-CsUserCallingSettings and the voicemail settings for voice-enabled users). Only what is still empty is filled: a
   * setting the engineer has designed is never replaced - unless `overwrite`, which takes every one of them from live (Accept
   * into design, for a drifted row). Returns how many rows changed and how many have nothing read yet.
   */
  async applyLiveVoiceSettings(t: TenantContext, table: 'build_users' | 'build_caps', siteId: string, onlyUpns?: string[], overwrite = false) {
    const s = this.s(t);
    let q = s.selectFrom(table).select(['id', 'upn', 'call_forwarding', 'delegates', 'pickup_group', 'voicemail']).where('site_id', '=', siteId);
    if (onlyUpns?.length) q = q.where(sql`lower(upn)`, 'in', onlyUpns.map((x) => x.toLowerCase()));
    const rows = await q.execute();
    if (!rows.length) return { updated: 0, rows: 0, notRead: 0 };
    const live = await s
      .selectFrom('tenant_users')
      .select(['upn', 'calling_settings', 'voicemail_enabled', 'voicemail_prompt_language'])
      .where('removed_at', 'is', null)
      .where(sql`lower(upn)`, 'in', rows.map((r) => r.upn.toLowerCase()))
      .execute();
    const byUpn = new Map(live.map((l) => [l.upn.toLowerCase(), l]));
    const empty = (v: unknown) => v == null || (Array.isArray(v) ? v.length === 0 : typeof v === 'object' && Object.keys(v as object).length === 0);
    let updated = 0;
    let notRead = 0;
    for (const r of rows) {
      const l = byUpn.get(r.upn.toLowerCase());
      const calling = l?.calling_settings as LiveCallingSettings | null | undefined;
      if (!l || !calling) {
        notRead += 1;
        continue;
      }
      const patch: Record<string, unknown> = {};
      if (overwrite) {
        // empty is '{}' / '[]' in these columns (NOT NULL), the same as a row that never designed the setting
        patch.call_forwarding = calling.callForwarding ?? {};
        patch.delegates = JSON.stringify(calling.delegates ?? []);
        patch.pickup_group = calling.pickupGroup ?? {};
        if (l.voicemail_enabled !== null) patch.voicemail = { enabled: l.voicemail_enabled, language: l.voicemail_prompt_language };
      }
      if (empty(r.call_forwarding) && !empty(calling.callForwarding)) patch.call_forwarding = calling.callForwarding;
      if (empty(r.delegates) && calling.delegates.length) patch.delegates = JSON.stringify(calling.delegates);
      if (empty(r.pickup_group) && calling.pickupGroup) patch.pickup_group = calling.pickupGroup;
      if (empty(r.voicemail) && l.voicemail_enabled !== null) patch.voicemail = { enabled: l.voicemail_enabled, language: l.voicemail_prompt_language };
      if (Object.keys(patch).length) {
        await s.updateTable(table).set({ ...patch, updated_at: new Date().toISOString() } as never).where('id', '=', r.id).execute();
        updated += 1;
      }
    }
    return { updated, rows: rows.length, notRead };
  }

  /** Stores an uploaded audio prompt (voice_audio_files); the worker imports it to Teams in the live run that uses it. */
  async uploadAudioFile(t: TenantContext, u: AuthedUser, file: { originalname: string; mimetype: string; buffer: Buffer; size: number } | undefined) {
    if (!file?.size) throw new BadRequestException('Choose an audio file to upload.');
    if (file.size > VOICE_AUDIO_MAX_BYTES) throw new BadRequestException('Teams takes audio prompts up to 5 MB.');
    const okType = (VOICE_AUDIO_TYPES as readonly string[]).includes(file.mimetype.toLowerCase()) || /\.(wav|mp3|wma)$/i.test(file.originalname);
    if (!okType) throw new BadRequestException('Teams plays WAV, MP3 or WMA audio prompts.');
    const filename = file.originalname.replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'prompt.wav';
    const row = await this.s(t)
      .insertInto('voice_audio_files')
      .values({ filename, content_type: file.mimetype || 'application/octet-stream', byte_size: file.size, content: file.buffer, uploaded_by: u.id })
      .returning(['id', 'filename', 'byte_size'])
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'build.audio_file_uploaded', { actor: actorOf(u), targetType: 'voice_audio_file', targetId: row.id, detail: { filename, bytes: file.size } });
    return row;
  }

  /**
   * Accept into design, for a drifted row (drift.ts): take what Teams has now. An auto attendant or call queue is refreshed from
   * its discovered object (as Refresh from Teams does); a user or common area phone takes its live calling settings and voicemail.
   * A number, Enterprise Voice or policy difference is left to the engineer, since numbers go through the number inventory: the
   * answer lists what still differs. Rechecks the site's drift afterwards.
   */
  async acceptDrift(t: TenantContext, u: AuthedUser, body: BuildDriftAcceptInput) {
    const s = this.s(t);
    let siteId: string;
    let name: string;
    if (body.object_type === 'auto_attendant' || body.object_type === 'call_queue') {
      const table = body.object_type === 'auto_attendant' ? 'build_auto_attendants' : 'build_call_queues';
      const row = await s.selectFrom(table).select(['site_id', 'name']).where('id', '=', body.row_id).executeTakeFirst();
      if (!row) throw new NotFoundException('row not found');
      await this.refreshVoiceAppFromLive(t, u, body.object_type, body.row_id);
      siteId = row.site_id;
      name = row.name;
    } else {
      await this.assertNotSrLocked(t, [body.row_id]);
      const table = body.object_type === 'user' ? 'build_users' : 'build_caps';
      const row = await s.selectFrom(table).select(['site_id', 'upn']).where('id', '=', body.row_id).executeTakeFirst();
      if (!row) throw new NotFoundException('row not found');
      const res = await this.applyLiveVoiceSettings(t, table, row.site_id, [row.upn], true);
      if (res.notRead) throw new BadRequestException('Discovery has not read this account\'s calling settings yet. Run a Discovery sync, then try again.');
      siteId = row.site_id;
      name = row.upn;
    }
    const drift = await computeSiteDrift(s, siteId);
    const still = drift.rows.find((r) => r.rowId === body.row_id);
    const remaining = still ? (body.object_type === 'user' || body.object_type === 'cap' ? identityDriftNotAccepted(still.cmdlets) : still.cmdlets) : [];
    await this.audit.tenant(t.schema, 'build.drift_accepted', {
      actor: actorOf(u),
      targetType: body.object_type,
      targetId: body.row_id,
      detail: { name, remaining },
    });
    return { remaining };
  }

  async importVoiceSettings(t: TenantContext, u: AuthedUser, kind: 'users' | 'caps', siteId: string) {
    const res = await this.applyLiveVoiceSettings(t, kind === 'users' ? 'build_users' : 'build_caps', siteId);
    await this.audit.tenant(t.schema, `build.${kind}_voice_settings_imported`, { actor: actorOf(u), targetType: 'discovery_site', targetId: siteId, detail: res });
    return res;
  }

  /**
   * "Add to site" for objects picked on a Discovery tab: Site Data first (TenantDiscoveryService.captureSelected, which
   * matches on UPN / tenant object id, never on a name), then - unless switched off - the Design & Build row, filled from the
   * discovered data the same way Quick add and Populate do. An account is routed to Users or Common area phones.
   */
  async addFromDiscovery(t: TenantContext, u: AuthedUser, input: AddFromDiscoveryInput): Promise<AddFromDiscoveryItemResult[]> {
    const s = this.s(t);
    // siteOf covers every result, including the voice apps a picked one routes to (they were not in the request)
    const { results, dcIds, raIds, siteOf } = await this.discovery.captureSelected(t, u, input.kind, input.items);
    if (!input.alsoBuild) return results;
    // dcIds only holds items that really are on this site's record; a note (say, a number that could not be attached) does not stop the Design & Build row
    const eligible = results.filter((r) => dcIds.has(r.id) && (r.dataCollection === 'added' || r.dataCollection === 'already_on_site'));
    for (const r of results) if (!eligible.includes(r)) r.designAndBuild = 'not_added';

    if (input.kind === 'account') {
      for (const as of ['user', 'cap'] as const) {
        const bySite = new Map<string, AddFromDiscoveryItemResult[]>();
        for (const r of eligible.filter((x) => x.as === as)) bySite.set(siteOf.get(r.id)!, [...(bySite.get(siteOf.get(r.id)!) ?? []), r]);
        for (const [siteId, group] of bySite) {
          const res = await this.quickAddIdentity(t, u, as === 'user' ? 'build_users' : 'build_caps', as, siteId, group.map((g) => g.key));
          const already = new Set(res.alreadyThere.map((x) => x.toLowerCase()));
          const added = new Set(res.added.map((x) => x.upn.toLowerCase()));
          for (const g of group) {
            const k = g.key.toLowerCase();
            g.designAndBuild = added.has(k) ? 'added' : already.has(k) ? 'already_on_site' : 'not_added';
            if (g.designAndBuild === 'not_added') g.note = 'Not found in the discovered data for Design & Build.';
          }
        }
      }
      return results;
    }

    // Voice apps and resource accounts: a Design & Build row for each, matched by id. A voice app brings its resource accounts.
    const bySite = new Map<string, AddFromDiscoveryItemResult[]>();
    for (const r of eligible) bySite.set(siteOf.get(r.id)!, [...(bySite.get(siteOf.get(r.id)!) ?? []), r]);
    for (const [siteId, group] of bySite) {
      const appIds = input.kind === 'resource_account' ? [] : group.map((g) => dcIds.get(g.id)!);
      const raOf = (g: AddFromDiscoveryItemResult) => raIds.get(g.id) ?? [];
      const allRaIds = [...new Set(group.flatMap(raOf))];
      // what each item has in Design & Build now, to tell added from already there
      const snapshot = async () => {
        const [aa, cq, ra] = await Promise.all([
          appIds.length ? s.selectFrom('build_auto_attendants').select('discovery_voice_app_id').where('discovery_voice_app_id', 'in', appIds).execute() : [],
          appIds.length ? s.selectFrom('build_call_queues').select('discovery_voice_app_id').where('discovery_voice_app_id', 'in', appIds).execute() : [],
          allRaIds.length ? s.selectFrom('build_resource_accounts').select('discovery_resource_account_id').where('discovery_resource_account_id', 'in', allRaIds).execute() : [],
        ]);
        return { apps: new Set([...aa, ...cq].map((r) => r.discovery_voice_app_id)), ras: new Set(ra.map((r) => r.discovery_resource_account_id)) };
      };
      const before = await snapshot();
      if (appIds.length) await this.populateVoiceApps(t, u, siteId, appIds);
      if (allRaIds.length) await this.populateResourceAccounts(t, u, siteId, allRaIds);
      const after = await snapshot();
      for (const g of group) {
        const id = dcIds.get(g.id)!;
        const own = input.kind === 'resource_account' ? [id] : raOf(g);
        const newRas = own.filter((r) => after.ras.has(r) && !before.ras.has(r)).length;
        if (input.kind === 'resource_account') g.designAndBuild = before.ras.has(id) ? 'already_on_site' : after.ras.has(id) ? 'added' : 'not_added';
        else g.designAndBuild = !before.apps.has(id) && after.apps.has(id) ? 'added' : before.apps.has(id) ? (newRas > 0 ? 'added' : 'already_on_site') : 'not_added';
      }
    }
    return results;
  }

  quickAddUsers(t: TenantContext, u: AuthedUser, siteId: string, upns: string[]) {
    return this.quickAddIdentity(t, u, 'build_users', 'user', siteId, upns);
  }
  quickAddCaps(t: TenantContext, u: AuthedUser, siteId: string, upns: string[]) {
    return this.quickAddIdentity(t, u, 'build_caps', 'cap', siteId, upns);
  }
  async populateUsers(t: TenantContext, u: AuthedUser, siteId: string) {
    const s = this.s(t);
    await this.assertCallingPoliciesMapped(t, siteId, 'discovery_users', 'build_users', 'discovery_user_id');
    // Site Data's Users tab assigns a real phone_numbers claim (the
    // picker, not the free-text requested_number). Design & Build imports a
    // *copy* of that number as this row's starting target - Site Data
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
        // any); a user with a Site Data calling policy set gets that
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
    // The CAP-only columns. createIdentity writes the shared identity fields;
    // these have to be passed through or the Add dialog's values are lost.
    const { function: fn, display_name, phone_model, device_config_profile, mac_address, serial_number, phone_location, lan_jack, ...identity } = body;
    return this.createIdentity(t, u, 'build_caps', 'cap', identity, {
      function: fn || null,
      display_name: display_name || null,
      phone_model: phone_model || null,
      device_config_profile: device_config_profile || null,
      mac_address: mac_address || null,
      serial_number: serial_number || null,
      phone_location: phone_location || null,
      lan_jack: lan_jack || null,
    });
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
      skip: (d) => !d.upn, // a CAP row with no UPN yet can't be provisioned in Teams; leave it in Site Data
    });
  }

  /* ======================= users/caps - shared core ======================= */

  private async listIdentity(t: TenantContext, table: 'build_users' | 'build_caps', q: BuildListQuery) {
    const s = this.s(t);
    let base = s.selectFrom(table).where('site_id', '=', q.siteId);
    // A service request's Design tab lists only the rows designed for it.
    if (q.serviceRequestId) base = base.where('id', 'in', s.selectFrom('service_request_items').select('row_id').where('request_id', '=', q.serviceRequestId));
    if (q.hidden !== undefined) base = base.where('hidden', '=', q.hidden);
    else base = base.where('hidden', '=', false);
    if (q.q) {
      // The UPN, the number and the person's name. A row has no name of its own (a CAP does), so the name is looked up from the
      // tenant user with that UPN and from the Site Data record the row was populated from.
      const like = `%${q.q}%`;
      const linkTable = table === 'build_users' ? 'discovery_users' : 'discovery_caps';
      const linkCol = table === 'build_users' ? 'discovery_user_id' : 'discovery_cap_id';
      base = base.where((eb) =>
        eb.or([
          eb('upn', 'ilike', like),
          eb('e164', 'ilike', like),
          eb('did', 'ilike', like),
          sql<boolean>`exists (select 1 from ${sql.table(`${t.schema}.tenant_users`)} tu where lower(tu.upn) = lower(${sql.ref(`${table}.upn`)}) and tu.removed_at is null and tu.display_name ilike ${like})`,
          sql<boolean>`exists (select 1 from ${sql.table(`${t.schema}.${linkTable}`)} d where d.id = ${sql.ref(`${table}.${linkCol}`)} and d.display_name ilike ${like})`,
          ...(table === 'build_caps' ? [sql<boolean>`${sql.ref('build_caps.display_name')} ilike ${like}`] : []),
        ]),
      );
    }
    const [{ n }] = await base.select((eb) => eb.fn.countAll<number>().as('n')).execute();
    const rows = await base
      .selectAll()
      .orderBy('upn')
      .limit(q.limit)
      .offset((q.page - 1) * q.limit)
      .execute();
    const names = await this.nameLookup(t, table, rows);
    const validated = await this.validation.validateRows(
      t,
      rows as {
        id: string;
        upn: string;
        e164: string | null;
        number_type: string | null;
        policies: Record<string, string | null> | null;
        policy_ids: Record<string, string | null> | null;
        discovery_user_id?: string | null;
        discovery_cap_id?: string | null;
        number_decision?: unknown;
      }[],
    );
    // phone_number_id is a native column now (see 0017_build_phone_number_id) -
    // no separate holder lookup needed to know "what number is this row's".
    const items = await this.withSrRefs(
      t,
      rows.map((r) => ({
        ...r,
        // the person's name, so a search by name shows who matched (a CAP keeps the name it was given)
        display_name: ('display_name' in r && (r as { display_name?: string | null }).display_name) || names.get(r.id) || null,
        validation: validated.get(r.id) ?? null,
      })),
    );
    return { items, total: Number(n), page: q.page, limit: q.limit } satisfies Paginated<unknown>;
  }

  /** Each row's person name: the tenant user with that UPN, else the Site Data record the row came from. */
  private async nameLookup(
    t: TenantContext,
    table: 'build_users' | 'build_caps',
    rows: { id: string; upn: string; discovery_user_id?: string | null; discovery_cap_id?: string | null }[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (rows.length === 0) return out;
    const s = this.s(t);
    const upns = [...new Set(rows.map((r) => r.upn.toLowerCase()))];
    const tenant = new Map(
      (await s.selectFrom('tenant_users').select(['upn', 'display_name']).where('removed_at', 'is', null).where(sql`lower(upn)`, 'in', upns).execute()).map((r) => [r.upn.toLowerCase(), r.display_name]),
    );
    const linkIds = [...new Set(rows.map((r) => (table === 'build_users' ? r.discovery_user_id : r.discovery_cap_id)).filter((v): v is string => !!v))];
    const linked = new Map<string, string>();
    if (linkIds.length) {
      const found =
        table === 'build_users'
          ? await s.selectFrom('discovery_users').select(['id', 'display_name']).where('id', 'in', linkIds).execute()
          : await s.selectFrom('discovery_caps').select(['id', 'display_name']).where('id', 'in', linkIds).execute();
      for (const f of found) if (f.display_name) linked.set(f.id, f.display_name);
    }
    for (const r of rows) {
      const link = table === 'build_users' ? r.discovery_user_id : r.discovery_cap_id;
      const name = tenant.get(r.upn.toLowerCase()) || (link ? linked.get(link) : undefined);
      if (name) out.set(r.id, name);
    }
    return out;
  }

  private async getIdentity(t: TenantContext, table: 'build_users' | 'build_caps', id: string) {
    const row = await this.s(t).selectFrom(table).selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    const validated = await this.validation.validateRows(t, [row]);
    return { ...row, validation: validated.get(id) ?? null };
  }

  async deleteIdentity(t: TenantContext, u: AuthedUser, table: 'build_users' | 'build_caps', id: string) {
    await this.assertNotSrLocked(t, [id]);
    await this.inTx(t, async () => {
      await this.releaseHolder(t, holderTypeOf(table), id);
      const row = await this.s(t).deleteFrom(table).where('id', '=', id).returningAll().executeTakeFirst();
      if (!row) throw new NotFoundException('row not found');
    });
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
    // One transaction: if the number can't be claimed (taken a moment ago),
    // the row isn't left behind either.
    const row = await this.inTx(t, async () => {
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
      // The number can only be claimed once the row exists (it's the holder).
      const number = await this.setSingleNumber(t, holderTypeOf(table), row.id, phone_number_id);
      row = await this.s(t)
        .updateTable(table)
        .set({ e164: number?.e164 ?? null, phone_number_id: number?.id ?? null } as never)
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    return row;
    });
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
    await this.assertNotSrLocked(t, [id]);
    const { phone_number_id, policy_ids, ...rest } = body;
    const patch: Record<string, unknown> = { ...rest, updated_at: new Date().toISOString() };
    // pg serialises a plain object to jsonb fine, but a top-level array value
    // gets bound as a native Postgres array instead of JSON text unless
    // stringified first (see schema.ts) - delegates is the one array-shaped
    // field here (call_forwarding/pickup_group are plain objects).
    if (patch.delegates !== undefined) patch.delegates = JSON.stringify(patch.delegates);
    // One transaction: a number change only sticks if the row update does too.
    const row = await this.inTx(t, async () => {
      if (phone_number_id !== undefined) {
        Object.assign(patch, await this.applyNumberChange(t, table, holderType, id, phone_number_id, 'number_type' in rest));
      }
      if (policy_ids !== undefined) {
        Object.assign(patch, await this.resolvePolicyIds(t, policy_ids));
      }
      const updated = await this.s(t)
        .updateTable(table)
        .set(patch as never)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst()
        .catch((err) => {
          throw isUniqueViolation(err) ? new ConflictException('That UPN is already on this site’s Build grid.') : err;
        });
      if (!updated) throw new NotFoundException('row not found');
      return updated;
    });
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
    await this.assertNotSrLocked(t, ids);
    const { policy_ids, ...rest } = body;
    const patch: Record<string, unknown> = { ...rest };
    // Same as updateIdentity: an array bound as-is becomes a Postgres array,
    // which the jsonb column rejects (a bulk edit with delegates used to 500).
    if (patch.delegates !== undefined) patch.delegates = JSON.stringify(patch.delegates);
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
    await this.applyLiveVoiceSettings(t, opts.table, opts.siteId);
    return { created, skipped, total: source.length };
  }

  /* ======================== resource accounts ======================== */

  async listResourceAccounts(t: TenantContext, q: BuildListQuery) {
    const s = this.s(t);
    let base = s.selectFrom('build_resource_accounts').where('site_id', '=', q.siteId);
    // A service request's Design tab lists only the rows designed for it.
    if (q.serviceRequestId) base = base.where('id', 'in', s.selectFrom('service_request_items').select('row_id').where('request_id', '=', q.serviceRequestId));
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
    const items = await this.withSrRefs(t, rows);
    return { items, total: Number(n), page: q.page, limit: q.limit } satisfies Paginated<unknown>;
  }

  async getResourceAccount(t: TenantContext, id: string) {
    const row = await this.s(t).selectFrom('build_resource_accounts').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    return row;
  }

  /**
   * Deletes the build row, and - the "disassociate from a site" path for a
   * resource account picked by mistake via "Link discovered resource
   * account" (BuildService.importAndLinkResourceAccount) - also removes its
   * underlying Site Data row (discovery_resource_accounts), but only
   * when that row is still the empty shell Populate/Link created (every
   * narrative field null). A Site Data row a human has since filled
   * in with real content is left alone, exactly as this always behaved:
   * deleting the build row must not silently destroy hand-entered Data
   * Collection content. Any build_auto_attendants/build_call_queues row
   * Populate seeded alongside it is untouched - its own discovery_resource_account_id
   * just goes null (ON DELETE SET NULL), leaving whatever call-flow design
   * exists in place, deletable separately if that's really the intent too.
   */
  async deleteResourceAccount(t: TenantContext, u: AuthedUser, id: string) {
    await this.assertNotSrLocked(t, [id]);
    const row = await this.inTx(t, async () => {
      await this.releaseHolder(t, 'resource_account', id);
      const deleted = await this.s(t).deleteFrom('build_resource_accounts').where('id', '=', id).returningAll().executeTakeFirst();
      if (!deleted) throw new NotFoundException('row not found');
      // Auto attendants and call queues list their resource accounts by id
      // in a jsonb array (no foreign key), so a deleted account used to stay
      // there and show up at deploy time as an account that isn't live.
      for (const table of ['build_auto_attendants', 'build_call_queues'] as const) {
        await this.s(t)
          .updateTable(table)
          .set({ resource_accounts: sql`${sql.ref('resource_accounts')} - ${id}::text` } as never)
          .where(sql<boolean>`${sql.ref('resource_accounts')} ? ${id}::text`)
          .execute();
      }
      return deleted;
    });
    let unlinkedFromSite = false;
    if (row.discovery_resource_account_id) {
      const discoveryRow = await this.s(t)
        .selectFrom('discovery_resource_accounts')
        .selectAll()
        .where('id', '=', row.discovery_resource_account_id)
        .executeTakeFirst();
      // an empty shell: Populate or Link made it and nobody has added anything to it since
      if (discoveryRow && (!discoveryRow.comments || discoveryRow.comments === 'Added from Discovery.')) {
        await this.releaseHolder(t, 'resource_account', discoveryRow.id);
        await this.s(t).deleteFrom('discovery_resource_accounts').where('id', '=', discoveryRow.id).execute();
        unlinkedFromSite = true;
      }
    }
    await this.audit.tenant(t.schema, 'build.resource_account_deleted', {
      actor: actorOf(u),
      targetType: 'build_resource_account',
      targetId: id,
      detail: { unlinkedFromSite },
    });
    return { ok: true, unlinkedFromSite };
  }

  async createResourceAccount(t: TenantContext, u: AuthedUser, body: BuildResourceAccountCreateInput) {
    const resolved = body.voice_routing_policy_id
      ? await this.resolvePolicyIds(t, { voice_routing_policy: body.voice_routing_policy_id })
      : null;
    // Same reasoning as createIdentity - default number_type when a number is
    // being assigned right here and the caller didn't say what type it is.
    const number_type =
      body.number_type ?? (body.phone_number_id ? await this.siteNumberTypeDefault(t, body.site_id) : null);
    const row = await this.inTx(t, async () => {
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
      // Same transaction: a failed claim leaves no row behind.
      const number = await this.setSingleNumber(t, 'resource_account', row.id, body.phone_number_id);
      row = await this.s(t)
        .updateTable('build_resource_accounts')
        .set({ phone_number: number?.e164 ?? null, phone_number_id: number?.id ?? null })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    return row;
    });
    await this.audit.tenant(t.schema, 'build.resource_account_created', {
      actor: actorOf(u),
      targetType: 'build_resource_account',
      targetId: row.id,
    });
    return row;
  }

  async updateResourceAccount(t: TenantContext, u: AuthedUser, id: string, body: BuildResourceAccountPatchInput) {
    await this.assertNotSrLocked(t, [id]);
    const { phone_number_id, created, voice_routing_policy_id, ...rest } = body;
    const patch: Record<string, unknown> = { ...rest, updated_at: new Date().toISOString() };
    const row = await this.inTx(t, async () => {
      const existing = await this.getResourceAccount(t, id);
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
      // The application id follows the account's kind (auto attendant vs call
      // queue). It used to come from the stored kind only, so changing the kind
      // - alone, or in the same save as "created" - kept the old kind's id and
      // the account would be created as the wrong type.
      const kind = rest.kind ?? existing.kind;
      const isCreated = created ?? !!existing.application_id;
      if (created !== undefined || (rest.kind !== undefined && rest.kind !== existing.kind)) {
        patch.application_id = isCreated ? RESOURCE_ACCOUNT_APPLICATION_IDS[kind] : null;
      }
      const updated = await this.s(t)
        .updateTable('build_resource_accounts')
        .set(patch as never)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new NotFoundException('row not found');
      return updated;
    });
    await this.audit.tenant(t.schema, 'build.resource_account_updated', {
      actor: actorOf(u),
      targetType: 'build_resource_account',
      targetId: id,
      detail: { fields: Object.keys(patch) },
    });
    return row;
  }

  /* shared calling policies */

  async listSharedCallingPolicies(t: TenantContext, q: BuildListQuery) {
    const s = this.s(t);
    let base = s.selectFrom('build_shared_calling_policies').where('site_id', '=', q.siteId);
    // A service request's Design tab lists only the rows designed for it.
    if (q.serviceRequestId) base = base.where('id', 'in', s.selectFrom('service_request_items').select('row_id').where('request_id', '=', q.serviceRequestId));
    if (q.q) base = base.where('name', 'ilike', `%${q.q}%`);
    const [{ n }] = await base.select((eb) => eb.fn.countAll<number>().as('n')).execute();
    const rows = await base
      .selectAll()
      .orderBy('name')
      .limit(q.limit)
      .offset((q.page - 1) * q.limit)
      .execute();
    return { items: await this.withSrRefs(t, rows), total: Number(n), page: q.page, limit: q.limit } satisfies Paginated<unknown>;
  }

  async getSharedCallingPolicy(t: TenantContext, id: string) {
    const row = await this.s(t).selectFrom('build_shared_calling_policies').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    return row;
  }

  async createSharedCallingPolicy(t: TenantContext, u: AuthedUser, body: BuildSharedCallingPolicyCreateInput) {
    const row = await this.s(t)
      .insertInto('build_shared_calling_policies')
      .values({
        site_id: body.site_id,
        name: body.name,
        resource_account_id: body.resource_account_id ?? null,
        emergency_numbers: JSON.stringify(body.emergency_numbers ?? []),
        description: body.description ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'build.shared_calling_policy_created', {
      actor: actorOf(u),
      targetType: 'build_shared_calling_policy',
      targetId: row.id,
    });
    return row;
  }

  async updateSharedCallingPolicy(t: TenantContext, u: AuthedUser, id: string, body: BuildSharedCallingPolicyPatchInput) {
    await this.assertNotSrLocked(t, [id]);
    const { emergency_numbers, ...rest } = body;
    const patch: Record<string, unknown> = { ...rest, updated_at: new Date().toISOString() };
    if (emergency_numbers !== undefined) patch.emergency_numbers = JSON.stringify(emergency_numbers);
    const row = await this.s(t)
      .updateTable('build_shared_calling_policies')
      .set(patch as never)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    await this.audit.tenant(t.schema, 'build.shared_calling_policy_updated', {
      actor: actorOf(u),
      targetType: 'build_shared_calling_policy',
      targetId: id,
      detail: { fields: Object.keys(patch) },
    });
    return row;
  }

  async deleteSharedCallingPolicy(t: TenantContext, u: AuthedUser, id: string) {
    await this.assertNotSrLocked(t, [id]);
    const row = await this.s(t).deleteFrom('build_shared_calling_policies').where('id', '=', id).returningAll().executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    await this.audit.tenant(t.schema, 'build.shared_calling_policy_deleted', {
      actor: actorOf(u),
      targetType: 'build_shared_calling_policy',
      targetId: id,
    });
    return { ok: true };
  }

  /**
   * Populate, Site Data -> Design & Build. Voice apps and resource accounts are two different things (a voice app has its own
   * name and settings; a resource account its own UPN and number; a voice app lists its resource accounts), so each has its own
   * Populate, and a final step lists the resource accounts on the voice app they answer for. `populateVoiceApps` and
   * `populateResourceAccounts` can each be run on their own; the Resource accounts tab's button runs both.
   */
  async populateAll(t: TenantContext, u: AuthedUser, siteId: string) {
    const voiceApps = await this.populateVoiceApps(t, u, siteId);
    const resourceAccounts = await this.populateResourceAccounts(t, u, siteId);
    return { created: voiceApps.created + resourceAccounts.created, skipped: voiceApps.skipped + resourceAccounts.skipped, total: voiceApps.total + resourceAccounts.total, voiceApps, resourceAccounts };
  }

  /**
   * Each Site Data voice app becomes an auto attendant or call queue row, named with the voice app's own name, and the narrative
   * fields (business_hours/who_answers/...) are kept so they don't vanish (only `comments` maps onto call queues, as notes). A voice
   * app linked to a discovered one is then filled in from that live voice app; a designed one with no live object is linked to a live
   * voice app of the same kind and exact name when there is exactly one (the design and the live object are the same thing).
   */
  async populateVoiceApps(t: TenantContext, u: AuthedUser, siteId: string, onlyIds?: string[]) {
    const s = this.s(t);
    let sourceQ = s.selectFrom('discovery_voice_apps').selectAll().where('site_id', '=', siteId);
    if (onlyIds) sourceQ = sourceQ.where('id', 'in', onlyIds.length ? onlyIds : ['00000000-0000-0000-0000-000000000000']);
    const source = await sourceQ.execute();
    const [existingAa, existingCq] = await Promise.all([
      s.selectFrom('build_auto_attendants').select('discovery_voice_app_id').where('site_id', '=', siteId).execute(),
      s.selectFrom('build_call_queues').select('discovery_voice_app_id').where('site_id', '=', siteId).execute(),
    ]);
    const linked = new Set([...existingAa, ...existingCq].map((e) => e.discovery_voice_app_id).filter(Boolean));
    let created = 0;
    const createdIds: string[] = [];
    for (const d of source) {
      if (linked.has(d.id)) continue;
      // a Design & Build row the Call flow's Import already made for this voice app is linked, not copied
      const flowRow = await s.selectFrom('discovery_flows').select(['build_auto_attendant_id', 'build_call_queue_id']).where('voice_app_id', '=', d.id).executeTakeFirst();
      const madeBy = d.kind === 'auto_attendant' ? flowRow?.build_auto_attendant_id : flowRow?.build_call_queue_id;
      if (madeBy) {
        await s.updateTable(d.kind === 'auto_attendant' ? 'build_auto_attendants' : 'build_call_queues').set({ discovery_voice_app_id: d.id }).where('id', '=', madeBy).where('discovery_voice_app_id', 'is', null).execute();
        await this.adoptLiveVoiceApp(s, d);
        continue;
      }
      await this.adoptLiveVoiceApp(s, d);
      if (d.kind === 'auto_attendant') {
        const notes = [d.exception_conditions, d.exception_action].filter(Boolean).join(' / ') || null;
        await s
          .insertInto('build_auto_attendants')
          .values({
            site_id: siteId,
            discovery_voice_app_id: d.id,
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
            discovery_voice_app_id: d.id,
            name: d.name,
            resource_accounts: JSON.stringify([]),
            agents: JSON.stringify([]),
            overflow: {},
            timeout: {},
            notes: d.comments,
          })
          .execute();
      }
      await this.linkDiscoveredFlow(s, d.id);
      created += 1;
      createdIds.push(d.id);
    }
    if (createdIds.length > 0) await this.populateStructuredFromLive(s, siteId, createdIds);
    await this.linkResourceAccountsToVoiceApps(s, siteId);
    await this.audit.tenant(t.schema, 'build.voice_apps_populated', { actor: actorOf(u), targetType: 'discovery_site', targetId: siteId, detail: { created, total: source.length } });
    return { created, skipped: source.length - created, total: source.length };
  }

  /**
   * A designed voice app (no discovered object behind it) is linked to a live voice app of the same kind and exact name when exactly
   * one exists and nothing else has claimed it. Several with that name are never guessed between.
   */
  private async adoptLiveVoiceApp(s: Scoped, d: { id: string; kind: 'auto_attendant' | 'call_queue'; name: string; tenant_object_id: string | null }) {
    if (d.tenant_object_id) return;
    const candidates = await s
      .selectFrom('tenant_objects')
      .select('id')
      .where('object_type', '=', d.kind)
      .where('removed_at', 'is', null)
      .where(sql`lower(display_name)`, '=', d.name.toLowerCase())
      .where('id', 'not in', s.selectFrom('discovery_voice_apps').select('tenant_object_id').where('tenant_object_id', 'is not', null))
      .execute();
    if (candidates.length !== 1) return;
    await s.updateTable('discovery_voice_apps').set({ tenant_object_id: candidates[0]!.id }).where('id', '=', d.id).execute();
    await s.updateTable('discovery_flows').set({ tenant_object_id: candidates[0]!.id }).where('voice_app_id', '=', d.id).where('tenant_object_id', 'is', null).execute();
    d.tenant_object_id = candidates[0]!.id;
  }

  /**
   * Each Site Data resource account becomes a Design & Build resource account row: its own name and UPN (blank until the account
   * exists), its kind, and its number - from what Teams has live, else the number chosen for it in Site Data. A row for the same
   * UPN made by hand is linked, not duplicated.
   */
  async populateResourceAccounts(t: TenantContext, u: AuthedUser, siteId: string, onlyIds?: string[]) {
    const s = this.s(t);
    let sourceQ = s.selectFrom('discovery_resource_accounts').selectAll().where('site_id', '=', siteId);
    if (onlyIds) sourceQ = sourceQ.where('id', 'in', onlyIds.length ? onlyIds : ['00000000-0000-0000-0000-000000000000']);
    const source = await sourceQ.execute();
    const existing = await s.selectFrom('build_resource_accounts').select(['id', 'upn', 'discovery_resource_account_id']).where('site_id', '=', siteId).execute();
    const linked = new Set(existing.map((e) => e.discovery_resource_account_id).filter(Boolean));
    const objIds = source.map((d) => d.tenant_object_id).filter((v): v is string => !!v);
    const objs = objIds.length ? await s.selectFrom('tenant_objects').select(['id', 'data']).where('id', 'in', objIds).execute() : [];
    const liveById = new Map(objs.map((o) => [o.id, (o.data ?? {}) as Record<string, unknown>]));
    const held = source.length ? await s.selectFrom('phone_numbers').select(['id', 'e164', 'holder_id']).where('holder_type', '=', 'resource_account').where('holder_id', 'in', source.map((d) => d.id)).orderBy('e164').execute() : [];
    const heldBy = new Map<string, { id: string; e164: string }>();
    for (const h of held) if (!heldBy.has(h.holder_id as string)) heldBy.set(h.holder_id as string, { id: h.id, e164: h.e164 });
    const defaultType = await this.siteNumberTypeDefault(t, siteId);
    const liveTypes = await resolveLiveNumberTypes(s, [...liveById.values()].map((d) => (typeof d.PhoneNumber === 'string' ? d.PhoneNumber.replace(/^tel:/i, '').split(';')[0]!.trim() : null)));

    let created = 0;
    for (const d of source) {
      if (linked.has(d.id)) continue;
      const live = d.tenant_object_id ? liveById.get(d.tenant_object_id) : undefined;
      const liveUpn = live && typeof live.UserPrincipalName === 'string' ? live.UserPrincipalName : undefined;
      const upn = d.upn ?? liveUpn ?? '';
      const byUpn = upn ? existing.find((e) => e.upn.toLowerCase() === upn.toLowerCase() && !e.discovery_resource_account_id) : undefined;
      if (byUpn) {
        await s.updateTable('build_resource_accounts').set({ discovery_resource_account_id: d.id }).where('id', '=', byUpn.id).execute();
        continue;
      }
      const livePhone = live && typeof live.PhoneNumber === 'string' ? live.PhoneNumber.replace(/^tel:/i, '').split(';')[0]!.trim() : null;
      const phone = livePhone || heldBy.get(d.id)?.e164 || null;
      const inventory = phone ? await s.selectFrom('phone_numbers').select('id').where('e164', '=', phone).executeTakeFirst() : undefined;
      await s
        .insertInto('build_resource_accounts')
        .values({
          site_id: siteId,
          discovery_resource_account_id: d.id,
          display_name: d.name,
          kind: d.kind,
          upn,
          application_id: liveUpn ? RESOURCE_ACCOUNT_APPLICATION_IDS[d.kind] : null,
          phone_number: phone,
          phone_number_id: inventory?.id ?? null,
          number_type: phone ? (liveTypes.get(phone) ?? defaultType) : null,
          status: {},
        } as never)
        .execute();
      created += 1;
    }
    await this.linkResourceAccountsToVoiceApps(s, siteId);
    await this.audit.tenant(t.schema, 'build.resource_accounts_populated', { actor: actorOf(u), targetType: 'discovery_site', targetId: siteId, detail: { created, total: source.length } });
    return { created, skipped: source.length - created, total: source.length };
  }

  /**
   * Lists each Design & Build resource account on the auto attendant or call queue it answers for (the voice app its Site Data
   * row belongs to). Safe to run again: it only adds what is missing.
   */
  private async linkResourceAccountsToVoiceApps(s: Scoped, siteId: string) {
    const rows = await s
      .selectFrom('build_resource_accounts as b')
      .innerJoin('discovery_resource_accounts as d', 'd.id', 'b.discovery_resource_account_id')
      .select(['b.id as id', 'd.voice_app_id as voice_app_id', 'd.kind as kind'])
      .where('b.site_id', '=', siteId)
      .where('d.voice_app_id', 'is not', null)
      .execute();
    const byApp = new Map<string, string[]>();
    for (const r of rows) byApp.set(r.voice_app_id as string, [...(byApp.get(r.voice_app_id as string) ?? []), r.id]);
    for (const [appId, raIds] of byApp) {
      for (const table of ['build_auto_attendants', 'build_call_queues'] as const) {
        const app = await s.selectFrom(table).select(['id', 'resource_accounts']).where('discovery_voice_app_id', '=', appId).executeTakeFirst();
        if (!app) continue;
        const have = Array.isArray(app.resource_accounts) ? (app.resource_accounts as string[]) : [];
        const all = [...new Set([...have, ...raIds])];
        if (all.length !== have.length) await s.updateTable(table).set({ resource_accounts: JSON.stringify(all) } as never).where('id', '=', app.id).execute();
      }
    }
  }

  /**
   * "Link discovered resource account" - lets an engineer pull one specific live resource account (`tenant_objects.id`) straight into
   * this site without visiting Site Data first: the resource account row in Site Data, then its Design & Build row. It
   * brings only the resource account; the voice app it answers for is added with Add to site (the result says which one).
   */
  async importAndLinkResourceAccount(t: TenantContext, u: AuthedUser, objectId: string, siteId: string, canReview: boolean) {
    const { results, dcIds } = await this.discovery.captureSelected(t, u, 'resource_account', [{ id: objectId, siteId }]);
    const raId = dcIds.get(objectId);
    const populated = raId ? await this.populateResourceAccounts(t, u, siteId, [raId]) : { created: 0, skipped: 0, total: 0 };
    return { imported: { created: results.filter((r) => r.dataCollection === 'added').length, skipped: results.filter((r) => r.dataCollection !== 'added').length }, populated, results };
  }

  /**
   * Second pass of populateResourceAccounts: best-effort pre-fills the
   * structured AA/CQ columns (Workstream 1/2's real Set-CsAutoAttendant/
   * Set-CsCallQueue shape) from Discovery's live tenant_objects snapshot,
   * matched to the just-created rows by name (case-insensitive) - the same
   * matching key resolveLiveCallQueueState already uses (deployment.service.ts),
   * since discovery_resource_accounts carries no live object id. Anything
   * that can't be confidently mapped (no live match, an unresolvable call
   * target, a truncated CallTarget placeholder string) is left null/absent
   * for the engineer to complete in the Design & Build UI - never guessed.
   */
  private async populateStructuredFromLive(s: Scoped, siteId: string, createdDiscoveryIds: string[]) {
    const [createdAa, createdCq] = await Promise.all([
      s.selectFrom('build_auto_attendants').select(['id', 'name', 'discovery_voice_app_id']).where('discovery_voice_app_id', 'in', createdDiscoveryIds).execute(),
      s.selectFrom('build_call_queues').select(['id', 'name', 'discovery_voice_app_id']).where('discovery_voice_app_id', 'in', createdDiscoveryIds).execute(),
    ]);
    if (createdAa.length === 0 && createdCq.length === 0) return;

    // Every live auto attendant and call queue: a voice app is matched to its live object by the exact object (the Site Data
    // voice app's tenant_object_id), never by a name that two of them could share.
    const [liveApps, liveSchedules, liveUsers, voiceApps] = await Promise.all([
      s.selectFrom('tenant_objects').select(['id', 'object_type', 'data']).where('object_type', 'in', ['auto_attendant', 'call_queue']).where('removed_at', 'is', null).execute(),
      // Schedules are looked up by ScheduleId (an arbitrary tenant-wide GUID), not name, so all of them are fetched.
      s.selectFrom('tenant_objects').select(['object_key', 'data']).where('object_type', '=', 'schedule').where('removed_at', 'is', null).execute(),
      // entra_id, not object_id (our own internal tenant_objects.id row
      // reference) - the real Entra GUID that a live CallTarget/Agents
      // ObjectId matches (confirmed against OVP012's real data this session,
      // same bug just fixed in resolveLiveIdentityState).
      s.selectFrom('tenant_users').select(['entra_id', 'upn']).where('entra_id', 'is not', null).execute(),
      s.selectFrom('discovery_voice_apps').select(['id', 'tenant_object_id']).where('site_id', '=', siteId).where('tenant_object_id', 'is not', null).execute(),
    ]);
    const liveByObject = new Map(liveApps.map((o) => [o.id, (o.data ?? {}) as Record<string, unknown>]));
    const idLive = new Map<string, Record<string, unknown>>(); // discovery_voice_apps.id -> its live voice app
    for (const v of voiceApps) {
      const data = liveByObject.get(v.tenant_object_id as string);
      if (data) idLive.set(v.id, data);
    }
    const liveFor = (row: { discovery_voice_app_id: string | null }) => (row.discovery_voice_app_id ? idLive.get(row.discovery_voice_app_id) : undefined);
    const scheduleByGuid = new Map(liveSchedules.map((r) => [r.object_key, r.data as Record<string, unknown>]));
    const upnByObjectId = new Map(liveUsers.map((r) => [r.entra_id!.toLowerCase(), r.upn]));

    // Live Identity GUID -> this site's own build row, so a menu option that
    // transfers to another AA/CQ on the same site resolves to a same-site
    // buildId (deployment.ts's app-enforced reference), not a dangling GUID.
    // Every voice app on the site that has a live object counts, not only the ones just made.
    const siteApps = await Promise.all([
      s.selectFrom('build_auto_attendants').select(['id', 'discovery_voice_app_id']).where('site_id', '=', siteId).where('discovery_voice_app_id', 'is not', null).execute(),
      s.selectFrom('build_call_queues').select(['id', 'discovery_voice_app_id']).where('site_id', '=', siteId).where('discovery_voice_app_id', 'is not', null).execute(),
    ]);
    const liveIdToBuild = new Map<string, { kind: 'auto_attendant' | 'call_queue'; buildId: string }>();
    siteApps.forEach((rows, i) => {
      for (const row of rows) {
        const live = liveFor(row);
        if (live && typeof live.Identity === 'string') liveIdToBuild.set(live.Identity.toLowerCase(), { kind: i === 0 ? 'auto_attendant' : 'call_queue', buildId: row.id });
      }
    });

    // A transfer to a resource account (ApplicationEndpoint) reaches the
    // AA/CQ that account is associated with - same mapping
    // resolveAutoAttendantDeepContext uses at deploy time.
    const ownerByInstance = new Map<string, string>();
    const liveKindByIdentity = new Map<string, 'auto_attendant' | 'call_queue'>();
    for (const o of liveApps) {
      const d = (o.data ?? {}) as Record<string, unknown>;
      if (typeof d.Identity !== 'string') continue;
      liveKindByIdentity.set(d.Identity.toLowerCase(), o.object_type as 'auto_attendant' | 'call_queue');
      if (!Array.isArray(d.ApplicationInstances)) continue;
      for (const i of d.ApplicationInstances as unknown[]) if (typeof i === 'string') ownerByInstance.set(i.toLowerCase(), d.Identity.toLowerCase());
    }
    const resolveTarget = makeAutoAttendantTargetResolver({ upnByEntraId: upnByObjectId, ownerByInstance, liveIdToBuild, liveKindByIdentity });
    // Live access lists (Entra ids) as the design's UPNs. If anyone cannot be named, the list is left unmanaged (null) rather than
    // imported short - a short list would remove that person at the next deployment.
    const accessUpns = (ids: string[] | undefined): string | null => {
      if (!ids) return null;
      const upns = ids.map((id) => upnByObjectId.get(id.toLowerCase()));
      return upns.every((u): u is string => !!u) ? JSON.stringify(upns) : null;
    };

    // Same conversion the deployment planner runs fresh at preview/execute
    // time (see resolveAutoAttendantDeepContext in
    // apps/api/.../deployment.service.ts) - using it here too means a row
    // Populate just wrote is guaranteed to already match what that diff
    // sees, instead of two independent implementations that could quietly
    // drift and make every freshly-populated row look "changed".
    for (const row of createdAa) {
      const live = liveFor(row);
      if (!live) continue;
      const structured = liveAutoAttendantToStructured(live, scheduleByGuid, resolveTarget);
      const patch: Record<string, unknown> = {
        language_id: structured.languageId ?? null,
        time_zone_id: structured.timeZoneId ?? null,
        voice_id: structured.voiceId ?? null,
        voice_response_enabled: structured.enableVoiceResponse ?? false,
        operator: structured.operator ?? null,
        default_call_flow: structured.defaultCallFlow ?? null,
        after_hours_call_flow: structured.afterHoursCallFlow ?? null,
        schedule: structured.schedule ?? null,
        authorized_users: accessUpns(structured.authorizedUsers),
        hide_authorized_users: accessUpns(structured.hideAuthorizedUsers),
        user_name_extension: structured.userNameExtension ?? null,
      };
      if (structured.holidayCallFlows.length > 0) patch.holiday_call_flows = JSON.stringify(structured.holidayCallFlows);
      await s.updateTable('build_auto_attendants').set(patch as never).where('id', '=', row.id).execute();
    }

    for (const row of createdCq) {
      const live = liveFor(row);
      if (!live) continue;
      const agentUpns = Array.isArray(live.Agents)
        ? (live.Agents as Record<string, unknown>[])
            .map((a) => (typeof a?.ObjectId === 'string' ? upnByObjectId.get(a.ObjectId.toLowerCase()) : undefined))
            .filter((v): v is string => !!v)
        : [];
      // A SharedVoicemail/Forward target that isn't a resolvable user (e.g. an
      // M365 group's object id - Get-CsCallQueue never returns a display name
      // for one, and Discovery doesn't capture groups at all yet, see the bug
      // report) falls back to the raw id rather than being silently dropped -
      // visible-but-unfriendly beats blank.
      const targetOf = (t: unknown): string | null => {
        const o = t as Record<string, unknown> | null;
        if (!o || typeof o.Id !== 'string') return null;
        // A PSTN target's Id already comes back tel:-prefixed (e.g.
        // 'tel:+442071234567') - the exact shape normalizePstnTarget
        // (packages/shared/src/deployment.ts) and the AA path's own
        // parseLiveCallTarget (packages/shared/src/aa-live-parse.ts) both
        // expect, so it's returned as-is rather than dropped. Confirmed
        // live: a Forward-to-number Call Queue lost its destination on
        // every populate-from-live before this fix.
        if (o.Id.startsWith('tel:')) return o.Id;
        return upnByObjectId.get(o.Id.toLowerCase()) ?? o.Id;
      };
      const patch: Record<string, unknown> = {
        language_id: typeof live.LanguageId === 'string' ? live.LanguageId : null,
        routing_method: decodeCallQueueEnum(live.RoutingMethod, CALL_QUEUE_ROUTING_METHODS) ?? 'Attendant',
        agent_alert_time: typeof live.AgentAlertTime === 'number' ? live.AgentAlertTime : 30,
        presence_based_routing: typeof live.PresenceBasedRouting === 'boolean' ? live.PresenceBasedRouting : true,
        agents: JSON.stringify(agentUpns),
        overflow: {
          action: decodeCallQueueEnum(live.OverflowAction, CALL_QUEUE_OVERFLOW_ACTIONS),
          threshold: typeof live.OverflowThreshold === 'number' ? live.OverflowThreshold : undefined,
          target: targetOf(live.OverflowActionTarget),
          ...liveCallQueueActionExtras('Overflow', live, decodeCallQueueEnum(live.OverflowAction, CALL_QUEUE_OVERFLOW_ACTIONS)),
        },
        timeout: {
          action: decodeCallQueueEnum(live.TimeoutAction, CALL_QUEUE_TIMEOUT_ACTIONS),
          threshold: typeof live.TimeoutThreshold === 'number' ? live.TimeoutThreshold : undefined,
          target: targetOf(live.TimeoutActionTarget),
          ...liveCallQueueActionExtras('Timeout', live, decodeCallQueueEnum(live.TimeoutAction, CALL_QUEUE_TIMEOUT_ACTIONS)),
        },
        no_agent_action: {
          action: decodeCallQueueEnum(live.NoAgentAction, CALL_QUEUE_NO_AGENT_ACTIONS),
          target: targetOf(live.NoAgentActionTarget),
          ...liveCallQueueActionExtras('NoAgent', live, decodeCallQueueEnum(live.NoAgentAction, CALL_QUEUE_NO_AGENT_ACTIONS)),
        },
        // Without this a populated queue never matches live (live 'AllCalls'
        // vs a null row) and gets re-Set on every deployment.
        no_agent_apply_to: decodeCallQueueEnum(live.NoAgentApplyTo, CALL_QUEUE_NO_AGENT_APPLY_TO) ?? null,
        authorized_users: accessUpns(liveIdList(live.AuthorizedUsers)),
        hide_authorized_users: accessUpns(liveIdList(live.HideAuthorizedUsers)),
        voicemail_triage_template_id: typeof live.SharedVoicemailTriageSettingsTemplateId === 'string' && live.SharedVoicemailTriageSettingsTemplateId ? live.SharedVoicemailTriageSettingsTemplateId : null,
      };
      await s.updateTable('build_call_queues').set(patch as never).where('id', '=', row.id).execute();
    }
  }

  /* ========================== call queues ========================== */

  async listCallQueues(t: TenantContext, q: BuildListQuery) {
    const s = this.s(t);
    let base = s.selectFrom('build_call_queues').where('site_id', '=', q.siteId);
    // A service request's Design tab lists only the rows designed for it.
    if (q.serviceRequestId) base = base.where('id', 'in', s.selectFrom('service_request_items').select('row_id').where('request_id', '=', q.serviceRequestId));
    if (q.q) base = base.where('name', 'ilike', `%${q.q}%`);
    const [{ n }] = await base.select((eb) => eb.fn.countAll<number>().as('n')).execute();
    const items = await this.withSrRefs(t, await base.selectAll().orderBy('name').limit(q.limit).offset((q.page - 1) * q.limit).execute());
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
        authorized_users: body.authorized_users ? JSON.stringify(body.authorized_users) : null,
        hide_authorized_users: body.hide_authorized_users ? JSON.stringify(body.hide_authorized_users) : null,
        voicemail_triage_template_id: body.voicemail_triage_template_id ?? null,
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
    await this.assertNotSrLocked(t, [id]);
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
    for (const k of ['authorized_users', 'hide_authorized_users'] as const) if (body[k] !== undefined) patch[k] = body[k] === null ? null : JSON.stringify(body[k]);
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
    await this.assertNotSrLocked(t, [id]);
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
    // A service request's Design tab lists only the rows designed for it.
    if (q.serviceRequestId) base = base.where('id', 'in', s.selectFrom('service_request_items').select('row_id').where('request_id', '=', q.serviceRequestId));
    if (q.q) base = base.where('name', 'ilike', `%${q.q}%`);
    const [{ n }] = await base.select((eb) => eb.fn.countAll<number>().as('n')).execute();
    const items = await this.withSrRefs(t, await base.selectAll().orderBy('name').limit(q.limit).offset((q.page - 1) * q.limit).execute());
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
        resource_accounts: JSON.stringify(body.resource_accounts ?? []),
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
        authorized_users: body.authorized_users ? JSON.stringify(body.authorized_users) : null,
        hide_authorized_users: body.hide_authorized_users ? JSON.stringify(body.hide_authorized_users) : null,
        user_name_extension: body.user_name_extension ?? null,
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

  /**
   * Re-reads an auto attendant or call queue that was made from a discovered voice app from what Teams has now, replacing its
   * settings (call flows, schedules, targets, agents...). For a row imported before an import fix, or one whose live settings have
   * changed since. Anything edited in Design & Build on the row is overwritten, which the button says before it runs.
   */
  async refreshVoiceAppFromLive(t: TenantContext, u: AuthedUser, kind: 'auto_attendant' | 'call_queue', id: string) {
    await this.assertNotSrLocked(t, [id]);
    const s = this.s(t);
    const table = kind === 'auto_attendant' ? 'build_auto_attendants' : 'build_call_queues';
    const row = await s.selectFrom(table).select(['id', 'name', 'site_id', 'discovery_voice_app_id']).where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    if (!row.discovery_voice_app_id) throw new BadRequestException('This row was not made from a discovered voice app, so there is nothing to refresh it from. Add the discovered one to the site first.');
    const app = await s.selectFrom('discovery_voice_apps').select('tenant_object_id').where('id', '=', row.discovery_voice_app_id).executeTakeFirst();
    if (!app?.tenant_object_id) throw new BadRequestException('Its Site Data voice app is not linked to a discovered object, so there is nothing to refresh it from.');
    await this.populateStructuredFromLive(s, row.site_id, [row.discovery_voice_app_id]);
    await this.audit.tenant(t.schema, 'build.voice_app_refreshed', { actor: actorOf(u), targetType: table, targetId: id, detail: { name: row.name } });
    return { ok: true };
  }

  async updateAutoAttendant(t: TenantContext, u: AuthedUser, id: string, body: BuildAutoAttendantPatchInput) {
    await this.assertNotSrLocked(t, [id]);
    const { holiday_call_flows, resource_accounts, ...rest } = body;
    const patch: Record<string, unknown> = { ...rest, updated_at: new Date().toISOString() };
    // pg binds a plain array as a native Postgres array, not jsonb, unless
    // stringified first (see schema.ts) - holiday_call_flows and
    // resource_accounts are the array-shaped fields here (operator/
    // default_call_flow/after_hours_call_flow/schedule are plain objects).
    if (holiday_call_flows !== undefined) patch.holiday_call_flows = JSON.stringify(holiday_call_flows);
    if (resource_accounts !== undefined) patch.resource_accounts = JSON.stringify(resource_accounts);
    for (const k of ['authorized_users', 'hide_authorized_users'] as const) if (body[k] !== undefined) patch[k] = body[k] === null ? null : JSON.stringify(body[k]);
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
    await this.assertNotSrLocked(t, [id]);
    const row = await this.s(t).deleteFrom('build_auto_attendants').where('id', '=', id).returningAll().executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    await this.audit.tenant(t.schema, 'build.auto_attendant_deleted', {
      actor: actorOf(u),
      targetType: 'build_auto_attendant',
      targetId: id,
    });
    return { ok: true };
  }

  /**
   * Stamps a Call flows row that is the capture of a voice app with the Design & Build row Populate made for that voice app, so the tab
   * shows it as already in Design & Build and "Import" never makes a second row. Only rows with a discovered object behind them are
   * touched: a hand-made wizard capture is imported deliberately, not linked.
   */
  private async linkDiscoveredFlow(s: Scoped, dcVoiceAppId: string) {
    const flow = await s
      .selectFrom('discovery_flows')
      .select(['id', 'kind', 'build_auto_attendant_id', 'build_call_queue_id'])
      .where('voice_app_id', '=', dcVoiceAppId)
      .where('tenant_object_id', 'is not', null)
      .executeTakeFirst();
    if (!flow || flow.build_auto_attendant_id || flow.build_call_queue_id) return flow ?? null;
    const buildId =
      flow.kind === 'auto_attendant'
        ? (await s.selectFrom('build_auto_attendants').select('id').where('discovery_voice_app_id', '=', dcVoiceAppId).executeTakeFirst())?.id
        : flow.kind === 'call_queue'
          ? (await s.selectFrom('build_call_queues').select('id').where('discovery_voice_app_id', '=', dcVoiceAppId).executeTakeFirst())?.id
          : undefined;
    if (!buildId) return flow;
    await s
      .updateTable('discovery_flows')
      .set({ imported_at: new Date().toISOString(), build_auto_attendant_id: flow.kind === 'auto_attendant' ? buildId : null, build_call_queue_id: flow.kind === 'call_queue' ? buildId : null })
      .where('id', '=', flow.id)
      .execute();
    return flow;
  }

  /* ==================== import wizard capture into Design & Build =================== */

  /**
   * "Import to Design & Build" (Site Data's Call flows tab). Converts
   * the AA/CQ creation wizard's plain-language capture
   * (discovery_flows.wizard_answers) into a real build_auto_attendants/
   * build_call_queues row via the same create/update methods the
   * hand-entry editors already use above - no separate insert logic - then
   * stamps the link back onto the discovery_flows row so re-importing is a
   * no-op the UI can detect (imported_at set).
   */
  async importFlowWizard(t: TenantContext, u: AuthedUser, flowId: string) {
    const s = this.s(t);
    const flow = await s.selectFrom('discovery_flows').selectAll().where('id', '=', flowId).executeTakeFirst();
    if (!flow) throw new NotFoundException('flow not found');
    // A Call flows row made from a discovered voice app already IS what Teams has: Populate builds its Design & Build row from
    // the live settings (more fully than the wizard can say them), so "Import" links that row - making it first if needed -
    // instead of converting the wizard's answers into a second, thinner one.
    if (flow.tenant_object_id && flow.voice_app_id && flow.site_id && !flow.build_auto_attendant_id && !flow.build_call_queue_id) {
      await this.populateVoiceApps(t, u, flow.site_id, [flow.voice_app_id]);
      await this.linkDiscoveredFlow(s, flow.voice_app_id);
      const linked = await s.selectFrom('discovery_flows').selectAll().where('id', '=', flowId).executeTakeFirstOrThrow();
      const rowId = linked.build_auto_attendant_id ?? linked.build_call_queue_id;
      if (!rowId) throw new BadRequestException('This discovered voice app could not be added to Design & Build.');
      return { row: { id: rowId }, flow: linked, warnings: [] as string[] };
    }
    if (!flow.wizard_answers) throw new BadRequestException('This call flow has no wizard capture to import.');
    if (!flow.site_id) throw new BadRequestException('This call flow has no site.');
    const siteId = flow.site_id;

    // Best-effort free-text-name -> UPN matching against the tenant's live
    // synced users (tenant_users) or - failing that - this site's own Data
    // Collection Users tab (discovery_users), the same two sources the
    // wizard's own UpnAutocomplete field suggests from
    // (apps/web/src/components/UpnAutocomplete.tsx) - a single
    // case-insensitive match on UPN or display name resolves. A
    // discovery_users match already linked to a live user (tenant_user_id,
    // set by "Link to tenant") resolves to that user's real UPN; otherwise
    // it resolves to the UPN the customer typed into Site Data
    // themselves - not yet confirmed live, but a deliberate answer, not a
    // guess. Anything matching neither source is carried through as typed
    // rather than dropped (a typed-but-unmatched name used to vanish
    // entirely from the created row - confirmed live) and listed in the
    // returned warnings so it's easy to find and fix.
    const [tenantUsers, siteUsers] = await Promise.all([
      s.selectFrom('tenant_users').select(['id', 'upn', 'display_name']).where('removed_at', 'is', null).execute(),
      s.selectFrom('discovery_users').select(['upn', 'display_name', 'tenant_user_id']).where('site_id', '=', siteId).execute(),
    ]);
    const tenantUserUpnById = new Map(tenantUsers.map((u) => [u.id, u.upn]));
    const resolvePerson = (label: string): string | undefined => {
      const needle = label.trim().toLowerCase();
      if (!needle) return undefined;
      const liveMatches = tenantUsers.filter((p) => p.upn.toLowerCase() === needle || (p.display_name ?? '').toLowerCase() === needle);
      if (liveMatches.length === 1) return liveMatches[0].upn;
      if (liveMatches.length > 1) return undefined;
      const collectedMatches = siteUsers.filter((p) => p.upn.toLowerCase() === needle || (p.display_name ?? '').toLowerCase() === needle);
      if (collectedMatches.length !== 1) return undefined;
      const match = collectedMatches[0];
      return (match.tenant_user_id && tenantUserUpnById.get(match.tenant_user_id)) || match.upn;
    };

    // Same idea for "a department/team" - an exact match against this
    // site's own already-built Call Queues/Auto Attendants links it for
    // real (New-CsAutoAttendantCallableEntity -Type ApplicationEndpoint)
    // instead of always leaving it unresolved.
    const [existingCqs, existingAas] = await Promise.all([
      s.selectFrom('build_call_queues').select(['id', 'name']).where('site_id', '=', siteId).execute(),
      s.selectFrom('build_auto_attendants').select(['id', 'name']).where('site_id', '=', siteId).execute(),
    ]);
    const resolveTeam = (label: string): { kind: 'call_queue' | 'auto_attendant'; buildId: string } | undefined => {
      const needle = label.trim().toLowerCase();
      if (!needle) return undefined;
      const cq = existingCqs.find((c) => c.name.toLowerCase() === needle);
      if (cq) return { kind: 'call_queue', buildId: cq.id };
      const aa = existingAas.find((a) => a.name.toLowerCase() === needle);
      if (aa) return { kind: 'auto_attendant', buildId: aa.id };
      return undefined;
    };

    // A target set via "Set up a new call queue" (TargetPicker.tsx) carries
    // the discovery_flows id it was created as directly, rather than a name
    // to match - a hard link, immune to renames, that only resolves once
    // that capture has itself been imported to Design & Build.
    const siteFlows = await s
      .selectFrom('discovery_flows')
      .select(['id', 'kind', 'build_call_queue_id', 'build_auto_attendant_id'])
      .where('site_id', '=', siteId)
      .execute();
    const siteFlowsById = new Map(siteFlows.map((f) => [f.id, f]));
    const resolveFlow = (flowId: string): { kind: 'call_queue' | 'auto_attendant'; buildId: string } | undefined => {
      const f = siteFlowsById.get(flowId);
      if (f?.kind === 'call_queue' && f.build_call_queue_id) return { kind: 'call_queue', buildId: f.build_call_queue_id };
      if (f?.kind === 'auto_attendant' && f.build_auto_attendant_id) return { kind: 'auto_attendant', buildId: f.build_auto_attendant_id };
      return undefined;
    };

    const resolvers = { resolvePerson, resolveTeam, resolveFlow };

    // A second "Import" click after the wizard capture has been edited
    // (see FlowImportButton's "Update Design & Build" state) re-syncs the
    // row it already created instead of making a duplicate - every field
    // the wizard owns is overwritten with the freshly-converted answers,
    // but anything the converter doesn't produce (resource_accounts is only
    // ever touched by the block below) is left exactly as an engineer may
    // have hand-adjusted it in Design & Build since the last sync.
    let warnings: string[];
    let result: { id: string };
    if (flow.kind === 'auto_attendant') {
      const { value, warnings: w } = convertAutoAttendantWizard(flow.wizard_answers as AutoAttendantWizardAnswers, { siteId, name: flow.name, resolvers });
      warnings = w;
      if (flow.build_auto_attendant_id) {
        const { site_id: _site, ...patch } = value;
        result = await this.updateAutoAttendant(t, u, flow.build_auto_attendant_id, patch);
      } else {
        result = await this.createAutoAttendant(t, u, value);
      }
    } else if (flow.kind === 'call_queue') {
      const { value, warnings: w } = convertCallQueueWizard(flow.wizard_answers as CallQueueWizardAnswers, { siteId, name: flow.name, resolvers });
      warnings = w;
      if (flow.build_call_queue_id) {
        const { site_id: _site, ...patch } = value;
        result = await this.updateCallQueue(t, u, flow.build_call_queue_id, patch);
      } else {
        result = await this.createCallQueue(t, u, value);
      }
    } else {
      throw new BadRequestException(`Call flows of kind "${flow.kind}" can't be imported.`);
    }

    // The row now belongs to the flow's voice app, so Populate and the deployment find the one row (and the live object behind it)
    // instead of making a second one.
    if (flow.voice_app_id) {
      const table = flow.kind === 'auto_attendant' ? 'build_auto_attendants' : 'build_call_queues';
      await s.updateTable(table).set({ discovery_voice_app_id: flow.voice_app_id }).where('id', '=', result.id).where('discovery_voice_app_id', 'is', null).execute();
    }

    // If the wizard also named a phone identity (discovery_resource_accounts),
    // link it once Populate has already turned it into a
    // build_resource_accounts row - the same discovery_resource_account_id
    // correlation populateResourceAccounts itself relies on. Not an error
    // if it hasn't been populated yet, just a warning.
    if (flow.resource_account_id) {
      const ra = await s
        .selectFrom('build_resource_accounts')
        .select('id')
        .where('site_id', '=', siteId)
        .where('discovery_resource_account_id', '=', flow.resource_account_id)
        .executeTakeFirst();
      if (ra) {
        if (flow.kind === 'auto_attendant') await this.updateAutoAttendant(t, u, result.id, { resource_accounts: [ra.id] });
        else await this.updateCallQueue(t, u, result.id, { resource_accounts: [ra.id] });
      } else {
        warnings.push("The chosen resource account hasn't been populated into Design & Build yet - link it manually once it has (Resource accounts → Populate).");
      }
    }

    // Deliberately NOT touching updated_at here - "in sync" means
    // imported_at is at least as recent as the last real edit, and
    // imported_at = now() is always >= whatever updated_at already holds.
    // A later edit through the normal updateFlow path (PATCH .../flows/:id)
    // stamps a strictly-later updated_at on its own, which is what flips
    // the row back to "out of date" until the next import - see the web
    // app's `stale` check (updated_at > imported_at).
    const updatedFlow = await s
      .updateTable('discovery_flows')
      .set({
        imported_at: new Date().toISOString(),
        build_auto_attendant_id: flow.kind === 'auto_attendant' ? result.id : null,
        build_call_queue_id: flow.kind === 'call_queue' ? result.id : null,
      })
      .where('id', '=', flowId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.audit.tenant(t.schema, 'build.flow_wizard_imported', {
      actor: actorOf(u),
      targetType: flow.kind === 'auto_attendant' ? 'build_auto_attendant' : 'build_call_queue',
      targetId: result.id,
      detail: { flowId, warnings: warnings.length, resynced: !!(flow.build_auto_attendant_id || flow.build_call_queue_id) },
    });

    return { row: result, flow: updatedFlow, warnings };
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
    const cooling = await coolingUntil(this.s(t), numberId);
    if (cooling) throw new ConflictException(coolingMessage(cooling));
    const res = await this.s(t)
      .updateTable('phone_numbers')
      .set({ holder_type: holderType, holder_id: holderId, status: 'assigned', live_only: false })
      .where('id', '=', numberId)
      .where('holder_id', 'is', null)
      // free, or assigned only because Teams has it (number-reconcile.ts): a holder in Site Data takes it over, and any clash with Teams is flagged
      .where((eb) => eb.or([eb.and([eb('status', '=', 'available'), eb('live_status', 'is', null)]), eb('live_only', '=', true)]))
      .executeTakeFirst();
    if (!Number(res.numUpdatedRows)) {
      const n = await this.s(t).selectFrom('phone_numbers').select(['status', 'live_status', 'live_holder_name', 'live_holder_upn']).where('id', '=', numberId).executeTakeFirst();
      if (!n) throw new NotFoundException('phone number not found');
      throw new ConflictException(n.status === 'reserved' ? 'That number is reserved.' : n.status === 'parked' ? PARKED_NUMBER_MESSAGE : n.live_status ? `That number is in use in Teams (${n.live_holder_name ?? n.live_holder_upn ?? 'another object'}).` : 'That number is already assigned.');
    }
    await refreshNumberConflict(this.s(t), numberId);
  }

  /**
   * The number a discovery_users/discovery_caps row currently has claimed in
   * the shared `phone_numbers` inventory (via Site Data's own picker) -
   * read-only. Populate from Site Data copies both the id and the e164 onto
   * the new build row (phone_number_id, e164) as a real reference, not just
   * text - see 0017_build_phone_number_id.sql. Site Data's own claim
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
    // Free the number this holder has now. (This used to call releaseHolder
    // with the *number's* id as the holder id, which matched nothing - so a
    // changed number stayed 'assigned' to the row forever and leaked.)
    if (current) {
      await this.s(t)
        .updateTable('phone_numbers')
        .set({ holder_type: null, holder_id: null, status: 'available' })
        .where('id', '=', current.id)
        .execute();
    }
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

  /* ===================== resource account request ===================== */

  /**
   * The "design process for greenfield resource accounts": generate a
   * customer-facing document listing not-yet-live `build_resource_accounts`
   * rows (application_id still null) to create and license, and stamp
   * `requested_at` on each so the row's status moves from "Designed" to
   * "Requested" and Discovery's post-sync reconciliation
   * (linkRequestedResourceAccounts, apps/worker/src/discovery/run.ts) knows
   * to watch for it. Mirrors DeploymentService.generateChangeDocument end to
   * end - same FilesService.store() call, new `resource_account_request`
   * category.
   */
  async generateResourceAccountRequestDocument(t: TenantContext, u: AuthedUser, siteId: string, rowIds?: string[]) {
    const s = this.s(t);
    const site = await s.selectFrom('discovery_sites').select(['id', 'sitecode', 'name']).where('id', '=', siteId).executeTakeFirst();
    if (!site) throw new NotFoundException('site not found');

    let q = s
      .selectFrom('build_resource_accounts')
      .select(['id', 'display_name', 'upn', 'kind', 'phone_number', 'number_type'])
      .where('site_id', '=', siteId)
      .where('application_id', 'is', null);
    if (rowIds?.length) q = q.where('id', 'in', rowIds);
    const rows = await q.execute();

    const generatedAt = new Date();
    const data = await this.documentBuilder.buildResourceAccountRequest({
      tenantName: t.name,
      siteName: site.name ?? site.sitecode,
      sitecode: site.sitecode,
      generatedBy: u.displayName,
      generatedAt,
      accounts: rows.map((r) => ({
        displayName: r.display_name ?? r.upn,
        kind: r.kind,
        upn: r.upn,
        phoneNumber: r.phone_number,
        numberType: r.number_type,
        provisioningCommand: renderCommand({
          cmdlet: 'New-CsOnlineApplicationInstance',
          objectType: 'resource_account',
          objectId: r.id,
          parameters: {
            UserPrincipalName: r.upn,
            ApplicationId: RESOURCE_ACCOUNT_APPLICATION_IDS[r.kind],
            DisplayName: r.display_name ?? r.upn,
          },
        }),
      })),
    });

    const file = await this.files.store(t, {
      category: 'resource_account_request',
      sourceType: 'build_site',
      sourceId: siteId,
      siteId,
      filename: `${site.sitecode}-resource-account-request-${generatedAt.toISOString().slice(0, 10)}.docx`,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data,
      uploadedBy: u.id,
      metadata: { rowCount: rows.length, rowIds: rowIds ?? null },
    });

    if (rows.length) {
      await s
        .updateTable('build_resource_accounts')
        .set({ requested_at: generatedAt.toISOString() })
        .where(
          'id',
          'in',
          rows.map((r) => r.id),
        )
        .where('requested_at', 'is', null)
        .execute();
    }

    await this.audit.tenant(t.schema, 'build.resource_account_request_generated', {
      actor: actorOf(u),
      targetType: 'file',
      targetId: file.id,
      detail: { siteId, rowCount: rows.length },
    });

    return file;
  }

  /**
   * The engineer's answer to a number change (see BuildRowValidation.numberChange). Remembers the numbers it was
   * decided against, so a later change to any of them asks again. 'reset' withdraws the answer.
   */
  async decideNumberChange(t: TenantContext, u: AuthedUser, table: 'build_users' | 'build_caps', id: string, decision: 'accepted' | 'rejected' | 'reset') {
    const s = this.s(t);
    const row = await s.selectFrom(table).selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('row not found');
    await this.assertNotSrLocked(t, [id]);
    if (decision === 'reset') {
      await s.updateTable(table).set({ number_decision: null }).where('id', '=', id).execute();
    } else {
      const v = (await this.validation.validateRows(t, [row])).get(id);
      const change = v?.numberChange;
      if (!change) throw new BadRequestException('There is no number change to decide on this row.');
      const decided = { decision, designed: change.designed, live: change.live, dataCollection: change.dataCollection, by: u.id, byName: u.displayName || u.email, at: new Date().toISOString() };
      await s.updateTable(table).set({ number_decision: decided }).where('id', '=', id).execute();
    }
    await this.audit.tenant(t.schema, 'build.number_change_decided', {
      actor: actorOf(u),
      targetType: table,
      targetId: id,
      detail: { upn: row.upn, decision, designed: row.e164 },
    });
    return this.getIdentity(t, table, id);
  }

  /* ============================== validate ============================== */

  /**
   * Every validation issue on a site's users, common area phones and resource accounts, flattened to one
   * list for the Validation issues tab. Computed fresh from the synced tenant data (nothing is stored),
   * so it always matches the per-row badges.
   */
  async siteIssues(t: TenantContext, siteId: string): Promise<BuildIssueRow[]> {
    if (!/^[0-9a-f-]{36}$/i.test(siteId)) throw new BadRequestException('siteId must be a site id');
    const s = this.s(t);
    const [users, caps, ras] = await Promise.all([
      s.selectFrom('build_users').select(['id', 'site_id', 'upn', 'e164', 'number_type', 'policies', 'policy_ids', 'discovery_user_id', 'number_decision']).where('site_id', '=', siteId).where('hidden', '=', false).execute(),
      s.selectFrom('build_caps').select(['id', 'site_id', 'upn', 'e164', 'number_type', 'policies', 'policy_ids', 'discovery_cap_id', 'number_decision', 'display_name']).where('site_id', '=', siteId).where('hidden', '=', false).execute(),
      s.selectFrom('build_resource_accounts').select(['id', 'upn', 'display_name', 'phone_number', 'number_type', 'voice_routing_policy', 'voice_routing_policy_id', 'application_id']).where('site_id', '=', siteId).execute(),
    ]);
    const raRows = ras.map((r) => ({
      id: r.id,
      upn: r.upn,
      e164: r.phone_number,
      number_type: r.number_type,
      policies: { voice_routing_policy: r.voice_routing_policy },
      policy_ids: { voice_routing_policy: r.voice_routing_policy_id },
      site_id: siteId,
      needsPhoneLicence: !!r.phone_number,
    }));
    const [userV, capV, raV, userNames, capNames] = await Promise.all([
      this.validation.validateRows(t, users),
      this.validation.validateRows(t, caps.map((c) => ({ ...c }))),
      raRows.length ? this.validation.validateRows(t, raRows) : Promise.resolve(new Map<string, BuildRowValidation>()),
      this.nameLookup(t, 'build_users', users),
      this.nameLookup(t, 'build_caps', caps),
    ]);
    const out: BuildIssueRow[] = [];
    for (const r of users) for (const issue of validationIssues(userV.get(r.id))) out.push({ sheet: 'users', rowId: r.id, upn: r.upn, displayName: userNames.get(r.id) ?? null, issue });
    for (const r of caps) for (const issue of validationIssues(capV.get(r.id))) out.push({ sheet: 'caps', rowId: r.id, upn: r.upn, displayName: r.display_name || capNames.get(r.id) || null, issue });
    for (const r of ras) {
      const created = !!r.application_id && !!r.upn;
      for (const issue of validationIssues(raV.get(r.id))) {
        if (!created && !DESIGN_ONLY_ISSUE_CODES.includes(issue.code)) continue;
        out.push({ sheet: 'resource-accounts', rowId: r.id, upn: r.upn, displayName: r.display_name, issue });
      }
    }
    const rank = { blocking: 0, warning: 1, info: 2 } as const;
    return out.sort((a, b) => rank[a.issue.severity] - rank[b.issue.severity] || a.upn.localeCompare(b.upn));
  }


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
    const [users, caps, resourceAccounts, autoAttendants, callQueues] = await Promise.all([
      s.selectFrom('build_users').select(['id', 'site_id', 'upn', 'e164', 'number_type', 'policies', 'policy_ids', 'discovery_user_id', 'number_decision']).where('site_id', '=', siteId).execute(),
      s.selectFrom('build_caps').select(['id', 'site_id', 'upn', 'e164', 'number_type', 'policies', 'policy_ids', 'discovery_cap_id', 'number_decision']).where('site_id', '=', siteId).execute(),
      s.selectFrom('build_resource_accounts').select(['id', 'upn', 'phone_number', 'number_type', 'voice_routing_policy', 'voice_routing_policy_id', 'application_id']).where('site_id', '=', siteId).execute(),
      s.selectFrom('build_auto_attendants').select(['id', 'name', 'default_call_flow']).where('site_id', '=', siteId).execute(),
      s.selectFrom('build_call_queues').select(['id', 'name', 'routing_method']).where('site_id', '=', siteId).execute(),
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

    // Resource accounts are identity rows under their own UPN, same as
    // Users/CAPs - reuse validateRows rather than new comparison logic
    // (was previously skipped entirely - the "no validation coverage for
    // AA/CQ/resource accounts" gap found while auditing the greenfield
    // path). voice_routing_policy is the one policy a resource account has,
    // mapped into the same policies/policy_ids shape validateRows expects.
    const raRows = resourceAccounts.map((r) => ({
      id: r.id,
      upn: r.upn,
      e164: r.phone_number,
      number_type: r.number_type,
      policies: { voice_routing_policy: r.voice_routing_policy },
      policy_ids: { voice_routing_policy: r.voice_routing_policy_id },
      created: !!r.application_id,
      site_id: siteId,
      needsPhoneLicence: !!r.phone_number,
    }));
    const raValidated = raRows.length ? await this.validation.validateRows(t, raRows) : new Map<string, BuildRowValidation>();
    for (const row of raRows) {
      const v = raValidated.get(row.id);
      if (!v) continue;
      if (row.created && row.upn) {
        if (hasIssue(v)) issues += 1;
        if (!v.existsInTenant) unmatchedUpns.push(row.upn);
      } else if (v.numberConflict || v.numberTypeMissing || v.unknownPolicies.length > 0) {
        // Not created yet: it can't exist in the tenant or match live policy,
        // so only design problems count. These used to be counted as issues,
        // and a blank UPN was sent to the live check.
        issues += 1;
      }
    }

    // AA/CQ: existence-only for now (does this name resolve live at all) -
    // the Deployment preview already surfaces full structural mismatches
    // via autoAttendantMatchesLive/planCallQueueRow's own diffing; this
    // just stops a hand-built, never-checked AA/CQ from being invisible to
    // "Validate against tenant" the way it was before this fix. Only rows
    // with real content configured are checked - an empty stub row isn't a
    // validation issue, it's just not designed yet.
    const configuredAas = autoAttendants.filter((r) => r.default_call_flow);
    const configuredCqs = callQueues.filter((r) => !!r.routing_method);
    if (configuredAas.length || configuredCqs.length) {
      const liveNames = new Set(
        (
          await s
            .selectFrom('tenant_objects')
            .select('display_name')
            .where('object_type', 'in', ['auto_attendant', 'call_queue'])
            .where('removed_at', 'is', null)
            .execute()
        )
          .map((r) => (r.display_name ?? '').toLowerCase())
          .filter(Boolean),
      );
      for (const r of configuredAas) if (!liveNames.has(r.name.toLowerCase())) issues += 1;
      for (const r of configuredCqs) if (!liveNames.has(r.name.toLowerCase())) issues += 1;
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
   * so Populate from Site Data can start fresh. Releases any phone_numbers
   * those rows held back to 'available' first - this never touches the
   * customer tenant itself, only Voxshift's own draft configuration, and
   * discovery_users/discovery_caps in Site Data (the source data) are
   * untouched, so re-populating recovers everything.
   */
  async resetSite(t: TenantContext, u: AuthedUser, siteId: string) {
    const s = this.s(t);
    const [users, caps, ras, cqs, aas] = await Promise.all([
      s.selectFrom('build_users').select('id').where('site_id', '=', siteId).execute(),
      s.selectFrom('build_caps').select('id').where('site_id', '=', siteId).execute(),
      s.selectFrom('build_resource_accounts').select('id').where('site_id', '=', siteId).execute(),
      s.selectFrom('build_call_queues').select('id').where('site_id', '=', siteId).execute(),
      s.selectFrom('build_auto_attendants').select('id').where('site_id', '=', siteId).execute(),
    ]);
    await this.assertNotSrLocked(t, [...users, ...caps, ...ras, ...cqs, ...aas].map((r) => r.id));
    const releaseAll = async (x: Scoped, holderType: NumberHolderType, ids: string[]) => {
      if (ids.length === 0) return;
      await x
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
    // All or nothing: a reset that failed part-way used to leave numbers
    // freed for rows that still existed, or half the grids deleted.
    await this.inTx(t, async () => {
      const x = this.s(t);
      await releaseAll(x, 'user', users.map((r) => r.id));
      await releaseAll(x, 'cap', caps.map((r) => r.id));
      await releaseAll(x, 'resource_account', ras.map((r) => r.id));
      for (const table of ['build_users', 'build_caps', 'build_resource_accounts', 'build_call_queues', 'build_auto_attendants'] as const) {
        await x.deleteFrom(table).where('site_id', '=', siteId).execute();
      }
    });
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
    await this.assertNotSrLocked(t, ids);
    const table = template.kind === 'user' ? 'build_users' : 'build_caps';
    const patch: Record<string, unknown> = { policy_ids: template.policy_ids, policies: template.policies };
    // Only the voicemail half the template actually sets, merged in - a
    // template with just "voicemail on" used to wipe each row's language too.
    const voicemail: Record<string, unknown> = {};
    if (template.voicemail_enabled !== null) voicemail.enabled = template.voicemail_enabled;
    if (template.voicemail_language !== null) voicemail.language = template.voicemail_language;
    if (Object.keys(voicemail).length) patch.voicemail = voicemail;
    const { updated, appliedPatch } = await applyBulkPatch(this.s(t), table, ids, patch, ['policy_ids', 'policies', 'voicemail']);
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

const hasIssue = hasValidationIssue;

/** Postgres unique_violation (23505) - the (site_id, lower(upn)) index tripped. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
