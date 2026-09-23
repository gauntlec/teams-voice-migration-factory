import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import {
  buildAutoAttendantCrossRef,
  resolveAutoAttendantDeepContext,
  resolveLiveAutoAttendantState,
  resolveLiveCallQueueState,
  resolveLiveIdentityState,
  resolveLivePolicyNames,
  tenantDb,
  type Scoped,
} from '@tvmf/db';
import {
  autoAttendantRowWarnings,
  callQueueRowWarnings,
  collectAutoAttendantUserUpns,
  collectCallQueueTargetUpns,
  collectDependencyUserRowIds,
  identityRowWarnings,
  planAutoAttendantRow,
  planCallQueueRow,
  planIdentityRow,
  planResourceAccountRow,
  renderCommand,
  resourceAccountRowWarnings,
  type AutoAttendantCallableEntity,
  type AutoAttendantCallFlow,
  type AutoAttendantCrossRef,
  type AutoAttendantHolidayCallFlow,
  type AutoAttendantLiveState,
  type AutoAttendantSchedule,
  type BuildAutoAttendantRow,
  type CallDelegate,
  type CallForwardingSettings,
  type CallQueueActionSettings,
  type CallQueueLiveState,
  type CreateDeploymentInput,
  type DeploymentPreviewQuery,
  type DeploymentPreviewRow,
  type DeploymentSiteRollup,
  type FileRow,
  type GenerateDeploymentDocumentInput,
  type PickupGroupSettings,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { InjectDeployQueue, type Queue } from '../../queue/queue.module';
import { assertSiteInScope } from '../data-collection/site-scope';
import { FilesService } from '../files/files.service';
import { DeploymentDocumentService } from './deployment-document.service';

type SheetName = 'users' | 'caps' | 'resource_accounts' | 'call_queues' | 'auto_attendants';

/** Last-10-digits comparison key, matching the same check ImportUsersDialog and
 * SiteWorkspace's "Requested +N" badge use client-side - kept in sync by hand
 * since api and web don't share a UI-logic layer. */
const numKey = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(-10);

@Injectable()
export class DeploymentService {
  constructor(
    @InjectDb() private readonly db: Db,
    @InjectDeployQueue() private readonly queue: Queue,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly documentBuilder: DeploymentDocumentService,
  ) {}

  /* ============================ site rollup ============================ */

  async siteRollup(t: TenantContext): Promise<DeploymentSiteRollup[]> {
    const s = tenantDb(this.db, t.schema);
    const sites = await s.selectFrom('discovery_sites').select(['id', 'sitecode', 'name']).orderBy('sitecode').execute();
    if (sites.length === 0) return [];
    const siteIds = sites.map((si) => si.id);

    const [users, caps, ras, deployments] = await Promise.all([
      s.selectFrom('build_users').select(['id', 'site_id']).where('site_id', 'in', siteIds).execute(),
      s.selectFrom('build_caps').select(['id', 'site_id']).where('site_id', 'in', siteIds).execute(),
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

  /* ============================== preview =============================== */

  /**
   * Silently pulls in any build_users row a selected Call Queue's agents or
   * a selected Auto Attendant's -Operator/menu-option targets reference, so
   * that user's own Enterprise Voice/number/policy config deploys - in this
   * same run, before the queue/attendant that relies on it - without the
   * operator having to notice the dependency and select it separately. Only
   * applies when `rowIds` is a specific subset: a whole-site run (no rowIds
   * filter) already deploys every build_users row for any included sheet, so
   * there's nothing to add. Used by both previewChanges (so "Planned
   * changes" shows exactly what a real run would do) and createDeployment
   * (so it actually does). See collectDependencyUserRowIds.
   */
  private async expandScopeWithDependencies(
    s: Scoped,
    siteId: string,
    sheets: SheetName[],
    rowIds: string[] | undefined,
  ): Promise<{ sheets: SheetName[]; rowIds: string[] | undefined; autoIncludedRowIds: string[] }> {
    if (!rowIds?.length) return { sheets, rowIds, autoIncludedRowIds: [] };
    const needsCq = sheets.includes('call_queues');
    const needsAa = sheets.includes('auto_attendants');
    if (!needsCq && !needsAa) return { sheets, rowIds, autoIncludedRowIds: [] };

    const [cqRows, aaRows, siteUsers] = await Promise.all([
      needsCq
        ? s.selectFrom('build_call_queues').select('agents').where('site_id', '=', siteId).where('id', 'in', rowIds).execute()
        : Promise.resolve([]),
      needsAa
        ? s
            .selectFrom('build_auto_attendants')
            .select(['operator', 'default_call_flow', 'after_hours_call_flow', 'holiday_call_flows'])
            .where('site_id', '=', siteId)
            .where('id', 'in', rowIds)
            .execute()
        : Promise.resolve([]),
      s.selectFrom('build_users').select(['id', 'upn']).where('site_id', '=', siteId).where('hidden', '=', false).execute(),
    ]);

    const depIds = collectDependencyUserRowIds(
      cqRows.map((r) => ({ agents: (r.agents as string[] | null) ?? [] })),
      aaRows.map((r) => ({
        operator: (r.operator as AutoAttendantCallableEntity) ?? null,
        default_call_flow: (r.default_call_flow as AutoAttendantCallFlow) ?? null,
        after_hours_call_flow: (r.after_hours_call_flow as AutoAttendantCallFlow) ?? null,
        holiday_call_flows: (r.holiday_call_flows as AutoAttendantHolidayCallFlow[]) ?? [],
      })),
      siteUsers,
    );
    const missing = depIds.filter((id) => !rowIds.includes(id));
    if (missing.length === 0) return { sheets, rowIds, autoIncludedRowIds: [] };
    return {
      sheets: sheets.includes('users') ? sheets : [...sheets, 'users'],
      rowIds: [...rowIds, ...missing],
      autoIncludedRowIds: missing,
    };
  }

  /**
   * Read-only "what would this deploy right now" preview: reuses
   * planIdentityRow/planResourceAccountRow directly against the DB, with no
   * connection and no worker/queue involvement - see apps/worker/src/main.ts's
   * handleDeploymentRun for the live-execution counterpart this mirrors.
   */
  async previewChanges(t: TenantContext, query: DeploymentPreviewQuery): Promise<DeploymentPreviewRow[]> {
    assertSiteInScope(t, query.siteId);
    const s = tenantDb(this.db, t.schema);
    const { sheets, rowIds, autoIncludedRowIds } = await this.expandScopeWithDependencies(
      s,
      query.siteId,
      query.sheets,
      query.rowIds,
    );
    const autoIncluded = new Set(autoIncludedRowIds);
    const out: DeploymentPreviewRow[] = [];

    if (sheets.includes('users') || sheets.includes('caps')) {
      for (const [sheet, table, objectType] of [
        ['users', 'build_users', 'user'],
        ['caps', 'build_caps', 'cap'],
      ] as const) {
        if (!sheets.includes(sheet)) continue;
        let q = s.selectFrom(table).selectAll().where('site_id', '=', query.siteId).where('hidden', '=', false);
        if (rowIds?.length) q = q.where('id', 'in', rowIds);
        const rows = await q.execute();
        const [liveNames, liveState] = await Promise.all([
          resolveLivePolicyNames(
            s,
            rows.flatMap((row) => Object.values((row.policy_ids as Record<string, string | null>) ?? {})),
          ),
          resolveLiveIdentityState(s, rows.map((row) => row.upn)),
        ]);
        for (const row of rows) {
          const policyIds = (row.policy_ids as Record<string, string | null>) ?? {};
          const storedPolicies = (row.policies as Record<string, string | null>) ?? {};
          const policies: Record<string, string | null> = {};
          for (const key of Object.keys(storedPolicies)) {
            const linkedId = policyIds[key];
            policies[key] = (linkedId && liveNames.get(linkedId)) || storedPolicies[key];
          }
          const calls = planIdentityRow(
            {
              id: row.id,
              upn: row.upn,
              e164: row.e164,
              number_type: row.number_type,
              revoke_ev: row.revoke_ev,
              policies,
              voicemail: (row.voicemail as { enabled?: boolean | null; language?: string | null }) ?? null,
              call_forwarding: (row.call_forwarding as CallForwardingSettings) ?? null,
              pickup_group: (row.pickup_group as PickupGroupSettings) ?? null,
              delegates: (row.delegates as CallDelegate[]) ?? null,
            },
            objectType,
            liveState.get(row.upn.toLowerCase()),
          );
          const warnings = identityRowWarnings({ e164: row.e164, number_type: row.number_type, policies });
          if (calls.length === 0 && warnings.length === 0) continue;
          out.push({
            rowId: row.id,
            objectType,
            upn: row.upn,
            calls,
            renderedCommands: calls.map(renderCommand),
            warnings,
            autoIncluded: autoIncluded.has(row.id),
          });
        }
      }
    }

    if (sheets.includes('resource_accounts')) {
      let q = s.selectFrom('build_resource_accounts').selectAll().where('site_id', '=', query.siteId);
      if (rowIds?.length) q = q.where('id', 'in', rowIds);
      const rows = await q.execute();
      const [liveNames, liveState] = await Promise.all([
        resolveLivePolicyNames(s, rows.map((r) => r.voice_routing_policy_id)),
        resolveLiveIdentityState(s, rows.map((row) => row.upn)),
      ]);
      for (const row of rows) {
        const linkedId = row.voice_routing_policy_id;
        const calls = planResourceAccountRow(
          {
            id: row.id,
            upn: row.upn,
            display_name: row.display_name,
            kind: row.kind,
            location_id: row.location_id,
            phone_number: row.phone_number,
            number_type: row.number_type,
            voice_routing_policy: (linkedId && liveNames.get(linkedId)) || row.voice_routing_policy,
            application_id: row.application_id,
          },
          liveState.get(row.upn.toLowerCase()),
        );
        const warnings = resourceAccountRowWarnings({ phone_number: row.phone_number, number_type: row.number_type });
        if (calls.length === 0 && warnings.length === 0) continue;
        out.push({
          rowId: row.id,
          objectType: 'resource_account',
          upn: row.upn,
          calls,
          renderedCommands: calls.map(renderCommand),
          warnings,
        });
      }
    }

    if (sheets.includes('call_queues')) {
      let q = s.selectFrom('build_call_queues').selectAll().where('site_id', '=', query.siteId);
      if (rowIds?.length) q = q.where('id', 'in', rowIds);
      const rows = await q.execute();

      // A queue's agents and its linked resource accounts are both stored
      // as UPNs (agents) or an internal build_resource_accounts.id
      // (resource_accounts) - Set-CsCallQueue/the association cmdlet both
      // need live Entra object GUIDs, resolved via tenant_users.object_id
      // the same way resolveLiveIdentityState already resolves for
      // users/caps/resource-account diffing above.
      const raIds = [...new Set(rows.flatMap((r) => (r.resource_accounts as string[] | null) ?? []))];
      const ras = raIds.length
        ? await s.selectFrom('build_resource_accounts').select(['id', 'upn']).where('id', 'in', raIds).execute()
        : [];
      const cqTargetUpns = collectCallQueueTargetUpns(
        rows.map((r) => ({
          overflow: (r.overflow as CallQueueActionSettings | null) ?? null,
          timeout: (r.timeout as CallQueueActionSettings | null) ?? null,
          no_agent_action: (r.no_agent_action as CallQueueActionSettings | null) ?? null,
        })),
      );
      const allUpns = [...rows.flatMap((r) => (r.agents as string[] | null) ?? []), ...ras.map((r) => r.upn), ...cqTargetUpns];
      const [liveIdentity, liveQueues] = await Promise.all([
        resolveLiveIdentityState(s, allUpns),
        resolveLiveCallQueueState(s, rows.map((r) => r.name)),
      ]);
      const agentObjectIds = new Map<string, string>();
      for (const [upn, v] of liveIdentity) if (v.objectId) agentObjectIds.set(upn, v.objectId);
      const raObjectIds = new Map<string, string>();
      for (const ra of ras) {
        const oid = liveIdentity.get(ra.upn.toLowerCase())?.objectId;
        if (oid) raObjectIds.set(ra.id, oid);
      }

      for (const row of rows) {
        const agents = (row.agents as string[] | null) ?? [];
        const resourceAccounts = (row.resource_accounts as string[] | null) ?? [];
        const planRow = {
          id: row.id,
          name: row.name,
          routing_method: row.routing_method,
          agent_alert_time: row.agent_alert_time,
          presence_based_routing: row.presence_based_routing,
          agents,
          overflow: (row.overflow as CallQueueActionSettings) ?? null,
          timeout: (row.timeout as CallQueueActionSettings) ?? null,
          no_agent_action: (row.no_agent_action as CallQueueActionSettings) ?? null,
          no_agent_apply_to: row.no_agent_apply_to,
          language_id: row.language_id,
          resource_accounts: resourceAccounts,
        };
        const live: CallQueueLiveState | undefined = liveQueues.get(row.name.toLowerCase());
        const calls = planCallQueueRow(planRow, agentObjectIds, raObjectIds, live);
        const warnings = callQueueRowWarnings(planRow, agentObjectIds, raObjectIds);
        if (calls.length === 0 && warnings.length === 0) continue;
        out.push({
          rowId: row.id,
          objectType: 'call_queue',
          upn: row.name,
          calls,
          renderedCommands: calls.map(renderCommand),
          warnings,
        });
      }
    }

    if (sheets.includes('auto_attendants')) {
      let q = s.selectFrom('build_auto_attendants').selectAll().where('site_id', '=', query.siteId);
      if (rowIds?.length) q = q.where('id', 'in', rowIds);
      const rows = await q.execute();

      // A row's linked resource accounts resolve the same way a call
      // queue's do (raIds -> build_resource_accounts -> live Entra object
      // GUID) - an AA can have several resource accounts, or none yet,
      // exactly like a Call Queue.
      const raIds = [...new Set(rows.flatMap((r) => (r.resource_accounts as string[] | null) ?? []))];
      const [ras, crossRef] = await Promise.all([
        raIds.length
          ? s.selectFrom('build_resource_accounts').select(['id', 'upn']).where('id', 'in', raIds).execute()
          : Promise.resolve([]),
        buildAutoAttendantCrossRef(s, query.siteId),
      ]);
      const liveIdentity = await resolveLiveIdentityState(s, ras.map((r) => r.upn));
      const raObjectIds = new Map<string, string>();
      for (const ra of ras) {
        const oid = liveIdentity.get(ra.upn.toLowerCase())?.objectId;
        if (oid) raObjectIds.set(ra.id, oid);
      }
      const deep = await resolveAutoAttendantDeepContext(s, crossRef);
      const liveAutoAttendants = await resolveLiveAutoAttendantState(s, rows.map((r) => r.name), deep);

      const planRows: BuildAutoAttendantRow[] = rows.map((row) => ({
        id: row.id,
        name: row.name,
        language_id: row.language_id,
        time_zone_id: row.time_zone_id,
        voice_id: row.voice_id,
        voice_response_enabled: row.voice_response_enabled,
        operator: (row.operator as AutoAttendantCallableEntity) ?? null,
        default_call_flow: (row.default_call_flow as AutoAttendantCallFlow) ?? null,
        after_hours_call_flow: (row.after_hours_call_flow as AutoAttendantCallFlow) ?? null,
        holiday_call_flows: (row.holiday_call_flows as AutoAttendantHolidayCallFlow[]) ?? [],
        schedule: (row.schedule as AutoAttendantSchedule) ?? null,
        resource_accounts: (row.resource_accounts as string[] | null) ?? [],
      }));
      // 'user'-kind callable entities (operator / menu-option transfer
      // targets) need their own UPN -> live Entra Object ID resolution -
      // see buildCallableEntity's 'user' case.
      const userLiveIdentity = await resolveLiveIdentityState(s, collectAutoAttendantUserUpns(planRows));
      const userObjectIds = new Map<string, string>();
      for (const [upn, v] of userLiveIdentity) if (v.objectId) userObjectIds.set(upn, v.objectId);

      for (const planRow of planRows) {
        const live: AutoAttendantLiveState | undefined = liveAutoAttendants.get(planRow.name.toLowerCase());
        const calls = planAutoAttendantRow(planRow, crossRef, raObjectIds, userObjectIds, live);
        const warnings = autoAttendantRowWarnings(planRow, crossRef, raObjectIds, userObjectIds);
        if (calls.length === 0 && warnings.length === 0) continue;
        out.push({
          rowId: planRow.id,
          objectType: 'auto_attendant',
          upn: planRow.name,
          calls,
          renderedCommands: calls.map(renderCommand),
          warnings,
        });
      }
    }

    return out;
  }

  /**
   * Blocks generating the change document - the "about to deploy" checkpoint
   * for a site - while any user still has a requested number (from an Excel
   * import, or hand-typed) that doesn't match the number actually assigned
   * to them. Surfaced in the Users table as an amber "Requested +N" badge;
   * this is what makes that a hard stop rather than something easy to miss.
   */
  private async assertNoUnresolvedNumberMismatches(t: TenantContext, siteId: string) {
    const s = tenantDb(this.db, t.schema);
    const users = await s
      .selectFrom('discovery_users as u')
      .leftJoin('phone_numbers as n', (join) =>
        join.onRef('n.holder_id', '=', 'u.id').on('n.holder_type', '=', 'user'),
      )
      .select(['u.upn as upn', 'u.requested_number as requested_number', 'n.e164 as e164'])
      .where('u.site_id', '=', siteId)
      .where('u.requested_number', 'is not', null)
      .execute();
    const mismatched = users.filter((u) => {
      const req = numKey(u.requested_number);
      return req !== '' && req !== numKey(u.e164);
    });
    if (mismatched.length > 0) {
      throw new BadRequestException(
        `${mismatched.length} user(s) have a requested number that doesn't match the one assigned to them - resolve in the Users tab before deploying: ${mismatched
          .slice(0, 5)
          .map((u) => `${u.upn} (${u.requested_number})`)
          .join(', ')}${mismatched.length > 5 ? ', ...' : ''}`,
      );
    }
  }

  /**
   * Generates the branded "change recording" .docx for a site's planned
   * changes (per the user's own framing: "describes what the changes are
   * going to do and include the actual powershell commands") and stores it
   * via FilesService - not tied to any specific `deployments` row, since it
   * describes the live preview, generated before any run happens. rowIds
   * omitted = whole site.
   */
  async generateChangeDocument(
    t: TenantContext,
    user: AuthedUser,
    siteId: string,
    input: GenerateDeploymentDocumentInput,
  ): Promise<FileRow> {
    assertSiteInScope(t, siteId);
    const site = await tenantDb(this.db, t.schema)
      .selectFrom('discovery_sites')
      .select(['id', 'sitecode', 'name'])
      .where('id', '=', siteId)
      .executeTakeFirst();
    if (!site) throw new NotFoundException('site not found');

    await this.assertNoUnresolvedNumberMismatches(t, siteId);

    const rows = await this.previewChanges(t, {
      siteId,
      sheets: ['users', 'caps', 'resource_accounts', 'call_queues', 'auto_attendants'],
      rowIds: input.rowIds,
    });

    const generatedAt = new Date();
    const data = await this.documentBuilder.build({
      tenantName: t.name,
      siteName: site.name ?? site.sitecode,
      sitecode: site.sitecode,
      mode: 'dry_run',
      generatedBy: user.displayName,
      generatedAt,
      rows,
    });

    const file = await this.files.store(t, {
      category: 'deployment_change_document',
      sourceType: 'deployment_site',
      sourceId: siteId,
      siteId,
      filename: `${site.sitecode}-change-recording-${generatedAt.toISOString().slice(0, 10)}.docx`,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data,
      uploadedBy: user.id,
      metadata: { rowCount: rows.length, rowIds: input.rowIds ?? null },
    });

    await this.audit.tenant(t.schema, 'deployment.document_generated', {
      actor: { id: user.id, email: user.email },
      targetType: 'file',
      targetId: file.id,
      detail: { siteId, rowCount: rows.length },
    });

    return file;
  }

  /* ============================ connections ============================ */

  async startConnection(t: TenantContext, user: AuthedUser, tenantDomain?: string) {
    const conn = await tenantDb(this.db, t.schema)
      .insertInto('connections')
      .values({
        started_by: user.id,
        method: 'device_code',
        status: 'pending',
        tenant_domain: tenantDomain ?? null,
        // No Graph sign-in happens here (device-code auth goes straight into
        // the MicrosoftTeams PowerShell module - see docs/SECURITY.md), so
        // there's no meaningful scope list to record.
        scopes: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.queue.add('connection.start', {
      kind: 'connection.start',
      tenantId: t.id,
      schema: t.schema,
      connectionId: conn.id,
      operatorUserId: user.id,
      tenantDomain: tenantDomain ?? null,
    });

    await this.audit.tenant(t.schema, 'deployment.connection_started', {
      actor: { id: user.id, email: user.email },
      targetType: 'connection',
      targetId: conn.id,
      detail: { tenantDomain },
    });
    await this.audit.platform('deployment.connection_started', {
      actor: { id: user.id, email: user.email },
      tenantId: t.id,
      targetType: 'connection',
      targetId: conn.id,
    });
    return conn;
  }

  listConnections(t: TenantContext) {
    return tenantDb(this.db, t.schema)
      .selectFrom('connections')
      .selectAll()
      .orderBy('started_at', 'desc')
      .limit(50)
      .execute();
  }

  async getConnection(t: TenantContext, id: string) {
    const row = await tenantDb(this.db, t.schema)
      .selectFrom('connections')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('connection not found');
    return row;
  }

  async createDeployment(
    t: TenantContext,
    user: AuthedUser,
    input: CreateDeploymentInput,
    can: (p: 'deployment:execute') => boolean,
  ) {
    if (input.mode === 'execute' && !can('deployment:execute')) {
      throw new ForbiddenException('Missing permission: deployment:execute');
    }
    // A tenant property, not a role property - even a Super Admin with
    // deployment:execute must be blocked here. Re-checked independently in
    // the worker right before the cmdlet actually goes out - see docs/SECURITY.md.
    if (input.mode === 'execute' && t.teamsReadOnly) {
      throw new ForbiddenException(
        'This customer tenant is set to read-only - live changes are disabled. Run a dry run, or ask a Super Admin to turn off read-only mode first.',
      );
    }
    // Same hard stop generateChangeDocument already applies - a requested
    // number that doesn't match what's actually assigned must be resolved
    // before ANY deploy path runs, not just before the change document.
    await this.assertNoUnresolvedNumberMismatches(t, input.scope.siteId);
    const conn = await this.getConnection(t, input.connectionId);
    if (conn.started_by !== user.id && user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'This customer-tenant session belongs to another engineer. Start your own connection, or ask a Super Admin.',
      );
    }
    if (conn.status !== 'active') {
      throw new ForbiddenException('Connection is not active - sign in to the customer tenant first');
    }

    const s = tenantDb(this.db, t.schema);
    const { sheets, rowIds, autoIncludedRowIds } = await this.expandScopeWithDependencies(
      s,
      input.scope.siteId,
      input.scope.sheets,
      input.scope.rowIds,
    );
    // autoIncludedRowIds isn't part of createDeploymentSchema (the client
    // never sends it) - stashed onto the stored/queued scope purely so Run
    // History can show "+N rows included automatically" for this run. The
    // `deployments.scope` column is untyped jsonb, and this object is never
    // re-validated against the request schema, so the extra key is safe.
    const scope = { ...input.scope, sheets, rowIds, autoIncludedRowIds };

    const dep = await s
      .insertInto('deployments')
      .values({
        connection_id: conn.id,
        mode: input.mode,
        scope,
        status: 'queued',
        created_by: user.id,
        summary: {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.queue.add('deployment.run', {
      kind: 'deployment.run',
      tenantId: t.id,
      schema: t.schema,
      connectionId: conn.id,
      deploymentId: dep.id,
      mode: input.mode,
      scope,
      operatorUserId: user.id,
    });

    await this.audit.tenant(t.schema, 'deployment.queued', {
      actor: { id: user.id, email: user.email },
      targetType: 'deployment',
      targetId: dep.id,
      detail: { mode: input.mode, scope },
    });
    await this.audit.platform('deployment.queued', {
      actor: { id: user.id, email: user.email },
      tenantId: t.id,
      targetType: 'deployment',
      targetId: dep.id,
      detail: { mode: input.mode },
    });
    return dep;
  }

  listDeployments(t: TenantContext, siteId?: string) {
    let q = tenantDb(this.db, t.schema).selectFrom('deployments').selectAll();
    if (siteId) q = q.where(sql<boolean>`scope->>'siteId' = ${siteId}`);
    return q.orderBy('created_at', 'desc').limit(50).execute();
  }

  async getDeployment(t: TenantContext, id: string) {
    const row = await tenantDb(this.db, t.schema)
      .selectFrom('deployments')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('deployment not found');
    return row;
  }

  changes(t: TenantContext, id: string) {
    return tenantDb(this.db, t.schema)
      .selectFrom('deployment_changes')
      .selectAll()
      .where('deployment_id', '=', id)
      .orderBy('seq')
      .execute();
  }

  scripts(t: TenantContext, id: string) {
    return tenantDb(this.db, t.schema)
      .selectFrom('deployment_scripts')
      .selectAll()
      .where('deployment_id', '=', id)
      .execute();
  }
}
