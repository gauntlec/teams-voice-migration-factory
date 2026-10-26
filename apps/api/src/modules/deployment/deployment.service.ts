import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import {
  annotateDrift,
  computeSiteDrift,
  expandScopeWithDependencies,
  previewSiteChanges,
  tenantDb,
} from '@tvmf/db';
import {
  DEPLOYMENT_SHEETS,
  renderRollbackScript,
  type CreateDeploymentInput,
  type DeploymentPreviewQuery,
  type DeploymentPreviewRow,
  type DeploymentSiteRollup,
  type SiteDriftSummary,
  type FileRow,
  type GenerateDeploymentDocumentInput,
} from '@tvmf/shared';
import { assertNoMaintenanceFreeze } from '../../platform-ops/maintenance';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { InjectDeployQueue, type Queue } from '../../queue/queue.module';
import { assertSiteInScope } from '../data-collection/site-scope';
import { FilesService } from '../files/files.service';
import { DeploymentDocumentService } from './deployment-document.service';

type SheetName = 'users' | 'caps' | 'resource_accounts' | 'shared_calling_policies' | 'call_queues' | 'auto_attendants';

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

    const [users, caps, ras, deployments, drift] = await Promise.all([
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
      s.selectFrom('deployment_drift').select(['site_id', 'drifted', 'awaiting_sync', 'computed_at']).execute(),
    ]);
    const driftBySite = new Map(drift.map((d) => [d.site_id, d]));

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
        drift: (() => {
          const d = driftBySite.get(site.id);
          return d ? { drifted: d.drifted, awaitingSync: d.awaiting_sync, computedAt: new Date(d.computed_at).toISOString() } : null;
        })(),
      };
    });
  }

  /* ============================== preview =============================== */

  /**
   * Read-only "what would this deploy right now" preview - see previewSiteChanges in @tvmf/db, shared with the worker's drift check.
   */
  async previewChanges(t: TenantContext, query: DeploymentPreviewQuery): Promise<DeploymentPreviewRow[]> {
    assertSiteInScope(t, query.siteId);
    const s = tenantDb(this.db, t.schema);
    const rows = await previewSiteChanges(s, query);
    await annotateDrift(s, rows);
    return rows;
  }

  /** A site's drift, worked out fresh from the stored live state (and saved, so the site card's count follows). */
  async siteDrift(t: TenantContext, siteId: string): Promise<SiteDriftSummary> {
    assertSiteInScope(t, siteId);
    return computeSiteDrift(tenantDb(this.db, t.schema), siteId);
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

    const rows = await this.previewChanges(t, {
      siteId,
      sheets: [...DEPLOYMENT_SHEETS],
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
    // A sign-in made now would die with the worker restart minutes later.
    await assertNoMaintenanceFreeze(this.db, 'customer-tenant sign-in');
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
    /** Set by a service request's Deploy tab: a clean live run moves that request to Deployed (see the worker). */
    link?: { serviceRequestId: string; agentId?: string; proposalId?: string },
  ) {
    if (input.mode === 'execute' && !can('deployment:execute')) {
      throw new ForbiddenException('Missing permission: deployment:execute');
    }
    // A run started now would be failed by the worker restart of a scheduled update.
    await assertNoMaintenanceFreeze(this.db, input.mode === 'execute' ? 'live deployment' : 'What-If run');
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
    const conn = await this.getConnection(t, input.connectionId);
    if (conn.started_by !== user.id && user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'This customer-tenant session belongs to another engineer. Start your own connection, or ask a Super Admin.',
      );
    }
    if (conn.status !== 'active') {
      throw new ForbiddenException('Connection is not active - sign in to the customer tenant first');
    }
    // A second live run on this connection would interleave with the first in
    // the shared pwsh session (the worker also serialises them, this just gives
    // an immediate answer, e.g. to a double-clicked Deploy).
    if (input.mode === 'execute') {
      const inFlight = await tenantDb(this.db, t.schema)
        .selectFrom('deployments')
        .select('id')
        .where('connection_id', '=', conn.id)
        .where('mode', '=', 'execute')
        .where('status', 'in', ['queued', 'running'])
        .executeTakeFirst();
      if (inFlight) {
        throw new ConflictException('A live deployment is already queued or running on this connection. Wait for it to finish, then deploy again.');
      }
    }

    const s = tenantDb(this.db, t.schema);
    const { sheets, rowIds, autoIncludedRowIds } = await expandScopeWithDependencies(
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
    // serviceRequestId likewise never comes from the client's own scope - only
    // ServiceRequestsService.deploy passes `link`, after its own checks.
    const scope = { ...input.scope, sheets, rowIds, autoIncludedRowIds, ...(link ? { serviceRequestId: link.serviceRequestId, ...(link.agentId ? { agentId: link.agentId, proposalId: link.proposalId } : {}) } : {}) };

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

  /**
   * The reverse PowerShell script for a live run, built from its
   * deployment_changes (renderRollbackScript). Only generated and handed over -
   * Voxshift never runs it. Offered for any live run that applied something,
   * including one that stopped part-way.
   */
  async rollbackScript(t: TenantContext, user: AuthedUser, id: string) {
    const s = tenantDb(this.db, t.schema);
    const dep = await this.getDeployment(t, id);
    assertSiteInScope(t, (dep.scope as { siteId?: string } | null)?.siteId ?? '');
    if (dep.mode !== 'execute') throw new BadRequestException('Only a live run changes the tenant, so only a live run has a rollback script.');
    if (dep.status !== 'completed' && dep.status !== 'failed') throw new ConflictException('This run has not finished yet.');
    const changes = await s
      .selectFrom('deployment_changes')
      .select(['seq', 'object_type', 'cmdlet', 'parameters', 'before', 'result'])
      .where('deployment_id', '=', id)
      .orderBy('seq')
      .execute();
    if (!changes.some((c) => c.result === 'applied')) throw new BadRequestException('Nothing in this run was applied, so there is nothing to roll back.');
    const content = renderRollbackScript(
      changes.map((c) => ({
        seq: c.seq,
        object_type: c.object_type,
        cmdlet: c.cmdlet,
        parameters: c.parameters as Record<string, unknown> | null,
        before: c.before as Record<string, unknown> | null,
        result: c.result,
      })),
      { deploymentId: id, finishedAt: dep.finished_at ? new Date(dep.finished_at).toISOString() : null },
    );
    await this.audit.tenant(t.schema, 'deployment.rollback_script_downloaded', {
      actor: { id: user.id, email: user.email },
      targetType: 'deployment',
      targetId: id,
      detail: { applied: changes.filter((c) => c.result === 'applied').length },
    });
    return { filename: `rollback-${id}.ps1`, content };
  }

  scripts(t: TenantContext, id: string) {
    return tenantDb(this.db, t.schema)
      .selectFrom('deployment_scripts')
      .selectAll()
      .where('deployment_id', '=', id)
      .execute();
  }
}
