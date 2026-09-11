import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { tenantDb } from '@tvmf/db';
import {
  planIdentityRow,
  planResourceAccountRow,
  renderCommand,
  type CreateDeploymentInput,
  type DeploymentPreviewQuery,
  type DeploymentPreviewRow,
  type DeploymentSiteRollup,
  type FileRow,
  type GenerateDeploymentDocumentInput,
  type LiveIdentityState,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { InjectDeployQueue, type Queue } from '../../queue/queue.module';
import { assertSiteInScope } from '../data-collection/site-scope';
import { FilesService } from '../files/files.service';
import { DeploymentDocumentService } from './deployment-document.service';

type Scoped = ReturnType<typeof tenantDb>;

/**
 * Batch-resolves tenant_policies ids to their *current* live name, so a
 * preview/deployment always shows whatever the tenant calls that policy
 * right now - not a stale copy from whenever the engineer last saved the
 * row in Design & Build. Duplicated from apps/worker/src/main.ts's
 * resolveLivePolicyNames rather than shared - api and worker don't share a
 * DB-access layer beyond @tvmf/db's Kysely types.
 */
async function resolveLivePolicyNames(scoped: Scoped, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  const rows = await scoped
    .selectFrom('tenant_policies')
    .select(['id', 'name'])
    .where('id', 'in', wanted)
    .where('removed_at', 'is', null)
    .execute();
  for (const r of rows) out.set(r.id, r.name);
  return out;
}

/**
 * Batch-fetches what Discovery's live-tenant snapshot (tenant_users) knows
 * about a set of UPNs, keyed by lowercased UPN - the same data
 * BuildValidationService compares against for Design & Build's amber
 * "pending change" badge (apps/api/src/modules/build/build-validation.service.ts),
 * reused here so a deployment only issues a cmdlet when it would actually
 * change something live. Resource accounts appear in tenant_users too (a
 * normal Entra/Teams identity under its own UPN), so this covers all three
 * sheets. Duplicated from apps/worker/src/main.ts's equivalent rather than
 * shared - api and worker don't share a DB-access layer beyond @tvmf/db's
 * Kysely types.
 */
async function resolveLiveIdentityState(scoped: Scoped, upns: string[]) {
  const wanted = [...new Set(upns.map((u) => u.toLowerCase()))];
  const out = new Map<string, LiveIdentityState>();
  if (wanted.length === 0) return out;
  const rows = await scoped
    .selectFrom('tenant_users')
    .select(['upn', 'enterprise_voice_enabled', 'line_uri', 'policies'])
    .where('removed_at', 'is', null)
    .where(sql`lower(upn)`, 'in', wanted)
    .execute();
  for (const r of rows) {
    out.set(r.upn.toLowerCase(), {
      enterpriseVoiceEnabled: r.enterprise_voice_enabled,
      lineUri: r.line_uri,
      policies: (r.policies as Record<string, string | null>) ?? {},
    });
  }
  return out;
}

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
      s
        .selectFrom('deployments')
        .select(['id', 'mode', 'status', 'created_at', sql<string>`scope->>'siteId'`.as('site_id')])
        .orderBy('created_at', 'desc')
        .limit(500)
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
          ? { id: last.id, mode: last.mode as 'dry_run' | 'execute', status: last.status, createdAt: String(last.created_at) }
          : null,
      };
    });
  }

  /* ============================== preview =============================== */

  /**
   * Read-only "what would this deploy right now" preview: reuses
   * planIdentityRow/planResourceAccountRow directly against the DB, with no
   * connection and no worker/queue involvement - see apps/worker/src/main.ts's
   * handleDeploymentRun for the live-execution counterpart this mirrors.
   */
  async previewChanges(t: TenantContext, query: DeploymentPreviewQuery): Promise<DeploymentPreviewRow[]> {
    assertSiteInScope(t, query.siteId);
    const s = tenantDb(this.db, t.schema);
    const out: DeploymentPreviewRow[] = [];

    if (query.sheets.includes('users') || query.sheets.includes('caps')) {
      for (const [sheet, table, objectType] of [
        ['users', 'build_users', 'user'],
        ['caps', 'build_caps', 'cap'],
      ] as const) {
        if (!query.sheets.includes(sheet)) continue;
        let q = s.selectFrom(table).selectAll().where('site_id', '=', query.siteId).where('hidden', '=', false);
        if (query.rowIds?.length) q = q.where('id', 'in', query.rowIds);
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
            },
            objectType,
            liveState.get(row.upn.toLowerCase()),
          );
          if (calls.length === 0) continue;
          out.push({ rowId: row.id, objectType, upn: row.upn, calls, renderedCommands: calls.map(renderCommand) });
        }
      }
    }

    if (query.sheets.includes('resource_accounts')) {
      let q = s.selectFrom('build_resource_accounts').selectAll().where('site_id', '=', query.siteId);
      if (query.rowIds?.length) q = q.where('id', 'in', query.rowIds);
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
        if (calls.length === 0) continue;
        out.push({
          rowId: row.id,
          objectType: 'resource_account',
          upn: row.upn,
          calls,
          renderedCommands: calls.map(renderCommand),
        });
      }
    }

    return out;
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
      sheets: ['users', 'caps', 'resource_accounts'],
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
        scopes: process.env.MS_GRAPH_SCOPES ?? null,
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
    const conn = await this.getConnection(t, input.connectionId);
    if (conn.started_by !== user.id && user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'This customer-tenant session belongs to another engineer. Start your own connection, or ask a Super Admin.',
      );
    }
    if (conn.status !== 'active') {
      throw new ForbiddenException('Connection is not active - sign in to the customer tenant first');
    }

    const dep = await tenantDb(this.db, t.schema)
      .insertInto('deployments')
      .values({
        connection_id: conn.id,
        mode: input.mode,
        scope: input.scope,
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
      scope: input.scope,
      operatorUserId: user.id,
    });

    await this.audit.tenant(t.schema, 'deployment.queued', {
      actor: { id: user.id, email: user.email },
      targetType: 'deployment',
      targetId: dep.id,
      detail: { mode: input.mode, scope: input.scope },
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

  listDeployments(t: TenantContext) {
    return tenantDb(this.db, t.schema)
      .selectFrom('deployments')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();
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
