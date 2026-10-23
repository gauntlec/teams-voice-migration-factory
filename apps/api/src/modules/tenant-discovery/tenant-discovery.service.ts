import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { platformDb, tenantDb, type DB } from '@tvmf/db';
import {
  matchSitecodeFromName,
  RESOURCE_ACCOUNT_APPLICATION_IDS,
  TENANT_OBJECT_TYPES,
  type Paginated,
  type TenantConnectionInfo,
  type TenantDiscoverySummary,
  type TenantEndpoint,
  type TenantGroupsQuery,
  type TenantGroupSummary,
  type TenantObjectType,
  type TenantObjectVersion,
  type TenantObjectsQuery,
  type TenantResourceAccountsImportInput,
  type TenantUsersImportInput,
  type AddFromDiscoveryItemResult,
  autoAttendantFields,
  autoAttendantToWizard,
  callQueueFields,
  callQueueToWizard,
  isCommonAreaPhone,
  liveAutoAttendantToStructured,
  parseLiveCallTarget,
  type AutoAttendantCallableEntity,
  type LiveCallableEntityRef,
  type VoiceAppFields,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import { assertNoMaintenanceFreeze, currentMaintenance } from '../../platform-ops/maintenance';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { InjectDeployQueue, type Queue } from '../../queue/queue.module';
import { DataCollectionService } from '../data-collection/data-collection.service';
import { assertSiteInScope } from '../data-collection/site-scope';
import { TelephonyService } from '../data-collection/data-collection.telephony.service';
import { DeploymentService } from '../deployment/deployment.service';

type Scoped = ReturnType<typeof tenantDb>;
const actorOf = (u: AuthedUser) => ({ id: u.id, email: u.email });
const stripTel = (v: string | null | undefined): string | null => {
  const raw = String(v ?? '').replace(/^tel:/i, '').trim();
  return raw || null;
};

/** Columns the UI needs from `tenant_users` (never the raw object). */
const USER_COLS = [
  'u.id',
  'u.object_id',
  'u.upn',
  'u.entra_id',
  'u.display_name',
  'u.account_type',
  'u.account_enabled',
  'u.enterprise_voice_enabled',
  'u.line_uri',
  'u.telephone_numbers',
  'u.feature_types',
  'u.assigned_plans',
  'u.usage_location',
  'u.department',
  'u.job_title',
  'u.interpreted_user_type',
  'u.policies',
  'u.effective_policy_assignments',
  'u.when_changed',
  'u.last_seen_run_id',
  'u.removed_at',
] as const;

/**
 * Discovery: a point-in-time inventory of the customer's live Teams tenant.
 * The API only orchestrates (connection -> run -> queue) and serves the stored
 * snapshot; the worker does the actual sign-in and PowerShell queries.
 * See docs/DISCOVERY.md.
 */
@Injectable()
export class TenantDiscoveryService {
  constructor(
    @InjectDb() private readonly db: Db,
    @InjectDeployQueue() private readonly queue: Queue,
    private readonly audit: AuditService,
    private readonly deployments: DeploymentService,
    private readonly dataCollection: DataCollectionService,
    private readonly telephony: TelephonyService,
  ) {}

  private s(t: TenantContext): Scoped {
    return tenantDb(this.db as Kysely<DB>, t.schema);
  }

  /* ============================ connections ============================ */

  /** Same live device-code connection Deployment uses (tenant `connections` table). */
  async startConnection(t: TenantContext, user: AuthedUser, tenantDomain?: string) {
    const conn = await this.deployments.startConnection(t, user, tenantDomain);
    await this.audit.tenant(t.schema, 'tenant_discovery.connection_started', {
      actor: actorOf(user),
      targetType: 'connection',
      targetId: conn.id,
    });
    return conn;
  }

  /** A group-lookup sign-in that outlived its code is over: mark it failed so the screen shows why and the session is free again. */
  private async expireStaleGraph(t: TenantContext) {
    await this.s(t)
      .updateTable('connections')
      .set({
        graph_status: 'failed',
        graph_user_code: null,
        graph_error: 'The sign-in code expired before the sign-in was completed. Add group lookup again.',
      })
      .where('graph_status', '=', 'pending')
      .where('graph_expires_at', '<', new Date().toISOString())
      .execute();
  }

  /** A connection may only be read by the engineer who established it or a SUPER_ADMIN. */
  async getConnection(t: TenantContext, id: string, user: AuthedUser) {
    await this.expireStaleGraph(t);
    const row = await this.deployments.getConnection(t, id);
    if (row.started_by !== user.id && user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('This customer-tenant session belongs to another engineer.');
    }
    return row;
  }

  /**
   * Optional second sign-in on an already-active connection, to Microsoft
   * Graph (`Group.Read.All`, read-only) - lets Design & Build search M365
   * groups by name for the Shared Voicemail `groupId` field instead of an
   * engineer typing a raw Object ID. Same ownership rule as `getConnection`;
   * the primary Teams sign-in must already be `active`.
   */
  async connectGraph(t: TenantContext, id: string, user: AuthedUser) {
    const conn = await this.getConnection(t, id, user);
    if (conn.status !== 'active') {
      throw new ForbiddenException('Connection is not active - sign in to the customer tenant first');
    }
    if (conn.graph_status === 'pending') {
      throw new BadRequestException('A group lookup sign-in is already waiting for its code. Finish it, or wait for it to expire.');
    }
    // The sign-in and a sync share one PowerShell session that runs one command at a time: started now it would sit behind the
    // sync (or hold the sync up) with no code shown.
    const running = await this.s(t)
      .selectFrom('tenant_discovery_runs')
      .select('id')
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst();
    if (running) {
      throw new BadRequestException('A sync is running on this session. Add group lookup when it has finished.');
    }
    await this.s(t)
      .updateTable('connections')
      .set({
        graph_status: 'pending',
        graph_user_code: null,
        graph_verification_uri: null,
        graph_upn: null,
        // Replaced by the code's own expiry once it is shown; until then this stops a lost request leaving the sign-in pending forever.
        graph_expires_at: new Date(Date.now() + 17 * 60_000).toISOString(),
        graph_error: null,
      })
      .where('id', '=', id)
      .execute();
    await this.queue.add('graph.connect', {
      kind: 'graph.connect',
      tenantId: t.id,
      schema: t.schema,
      connectionId: id,
      operatorUserId: user.id,
    });
    await this.audit.tenant(t.schema, 'tenant_discovery.graph_connect_started', {
      actor: actorOf(user),
      targetType: 'connection',
      targetId: id,
    });
    return this.getConnection(t, id, user);
  }

  /**
   * SUPER_ADMIN: every recent session for this customer, with its owner.
   * Everyone else: only their own.
   */
  async listConnections(t: TenantContext, user: AuthedUser): Promise<TenantConnectionInfo[]> {
    let q = this.s(t)
      .selectFrom('connections')
      .select(['id', 'status', 'upn', 'tenant_domain', 'started_by', 'started_at', 'expires_at'])
      .orderBy('started_at', 'desc')
      .limit(50);
    if (user.role !== 'SUPER_ADMIN') q = q.where('started_by', '=', user.id);
    return this.attachOwners(await q.execute(), user.id);
  }

  /** Resolve `started_by` ids to the Voxshift user (name/email) from the platform schema. */
  private async attachOwners(
    rows: {
      id: string;
      status: TenantConnectionInfo['status'];
      upn: string | null;
      tenant_domain: string | null;
      started_by: string;
      started_at: string;
      expires_at: string | null;
    }[],
    meId: string,
  ): Promise<TenantConnectionInfo[]> {
    const ids = [...new Set(rows.map((r) => r.started_by))];
    const users = ids.length
      ? await platformDb(this.db as Kysely<DB>)
          .selectFrom('users')
          .select(['id', 'display_name', 'email'])
          .where('id', 'in', ids)
          .execute()
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => {
      const u = byId.get(r.started_by);
      return {
        id: r.id,
        status: r.status,
        upn: r.upn,
        tenant_domain: r.tenant_domain,
        started_at: r.started_at,
        expires_at: r.expires_at,
        owner: u ? { id: u.id, name: u.display_name, email: u.email } : null,
        isMine: r.started_by === meId,
      };
    });
  }

  /**
   * Shared phone endpoints derived from the current snapshot: Common Area Phone
   * accounts (`tenant_users` with a CAP service plan) and phone-enabled resource
   * accounts. Microsoft retired the Graph device-inventory API, so this is
   * "which phone endpoints exist" rather than hardware model / serial / firmware.
   */
  async listEndpoints(t: TenantContext): Promise<{ items: TenantEndpoint[] }> {
    const s = this.s(t);
    const num = (v: unknown): string | null => {
      const raw = String(v ?? '').replace(/^tel:/i, '').trim();
      return raw || null;
    };

    const users = await s
      .selectFrom('tenant_users')
      .select(['id', 'upn', 'display_name', 'line_uri', 'account_enabled', 'policies', 'assigned_plans', 'telephone_numbers'])
      .where('removed_at', 'is', null)
      .execute();
    const caps = users
      .filter((u) => isCommonAreaPhone(u.assigned_plans))
      .map((u) => {
        const nums = Array.isArray(u.telephone_numbers)
          ? (u.telephone_numbers as { number?: string }[])
          : [];
        const pol = (u.policies ?? {}) as Record<string, string | null>;
        return {
          id: u.id,
          kind: 'common_area_phone' as const,
          name: u.display_name,
          upn: u.upn,
          number: num(u.line_uri) ?? num(nums[0]?.number),
          callingPolicy: pol.TeamsCallingPolicy ?? null,
          ipPhonePolicy: pol.TeamsIPPhonePolicy ?? null,
          enabled: u.account_enabled,
        };
      });

    const ras = await s
      .selectFrom('tenant_objects')
      .select(['id', 'display_name', 'data'])
      .where('object_type', '=', 'resource_account')
      .where('removed_at', 'is', null)
      .execute();
    const raEndpoints = ras
      .map((r) => {
        const d = (r.data ?? {}) as Record<string, unknown>;
        const n = num(d.PhoneNumber);
        return n
          ? {
              id: r.id,
              kind: 'resource_account' as const,
              name: r.display_name,
              upn: (d.UserPrincipalName as string) ?? null,
              number: n,
              callingPolicy: null,
              ipPhonePolicy: null,
              enabled: null,
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return { items: [...caps, ...raEndpoints] };
  }

  /* ============================== settings ============================== */

  /** Per-customer Discovery settings (row seeded by tenant migration 0012). */
  async getSettings(t: TenantContext): Promise<{ filterUsers: boolean; notifyOnComplete: boolean }> {
    const row = await this.s(t)
      .selectFrom('tenant_discovery_config')
      .select(['filter_users', 'notify_on_complete'])
      .executeTakeFirst();
    return {
      filterUsers: row?.filter_users ?? true,
      notifyOnComplete: row?.notify_on_complete ?? true,
    };
  }

  async updateSettings(
    t: TenantContext,
    user: AuthedUser,
    patch: { filterUsers?: boolean; notifyOnComplete?: boolean },
  ): Promise<{ filterUsers: boolean; notifyOnComplete: boolean }> {
    const set: Record<string, unknown> = { updated_by: user.id, updated_at: new Date().toISOString() };
    if (patch.filterUsers !== undefined) set.filter_users = patch.filterUsers;
    if (patch.notifyOnComplete !== undefined) set.notify_on_complete = patch.notifyOnComplete;
    await this.s(t).updateTable('tenant_discovery_config').set(set).execute();
    await this.audit.tenant(t.schema, 'tenant_discovery.settings_updated', {
      actor: actorOf(user),
      targetType: 'tenant_discovery_config',
      detail: patch,
    });
    return this.getSettings(t);
  }

  /* ================================ runs ================================ */

  /**
   * Queue a discovery run. `scopeTypes` limits it to part of the tenant (omit
   * for a full run). The worker filters its cmdlets to the requested types and
   * only tombstones within them.
   */
  async startRun(
    t: TenantContext,
    user: AuthedUser,
    connectionId: string,
    scopeTypes?: TenantObjectType[],
    filters: { includeDisabled?: boolean; includeUnlicensed?: boolean } = {},
  ) {
    const conn = await this.deployments.getConnection(t, connectionId);
    const foreign = conn.started_by !== user.id;
    if (foreign && user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'This customer-tenant session belongs to another engineer. Start your own connection, or ask a Super Admin to run the sync.',
      );
    }
    if (conn.status !== 'active') {
      throw new ForbiddenException('Connection is not active - sign in to the customer tenant first');
    }
    // A run started now would be failed by the worker restart of a scheduled update.
    await assertNoMaintenanceFreeze(this.db, 'discovery run');
    // Counts both kinds: a Validate check holds the same pwsh session.
    const running = await this.s(t)
      .selectFrom('tenant_discovery_runs')
      .select(['id', 'kind'])
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst();
    if (running) {
      throw new BadRequestException(
        running.kind === 'targeted'
          ? 'A Design & Build validate check is running against this tenant - try again in a minute'
          : 'A discovery is already running for this customer',
      );
    }

    // The other way round: a pending group-lookup sign-in holds the session until its code is used or expires.
    await this.expireStaleGraph(t);
    const graph = await this.s(t).selectFrom('connections').select(['graph_status', 'graph_expires_at']).where('id', '=', conn.id).executeTakeFirst();
    if (graph?.graph_status === 'pending') {
      const mins = graph.graph_expires_at ? Math.max(1, Math.ceil((new Date(graph.graph_expires_at).getTime() - Date.now()) / 60_000)) : null;
      throw new BadRequestException(
        `The group lookup sign-in is waiting for its code. Finish it${mins ? `, or wait for it to expire (about ${mins} min)` : ''}, before running a sync.`,
      );
    }

    // de-dup + stable order; null = full run
    const scope = scopeTypes?.length
      ? TENANT_OBJECT_TYPES.filter((x) => scopeTypes.includes(x))
      : null;

    // Customer default (Discovery settings) unless this run widens it explicitly.
    const { filterUsers: customerFilterUsers } = await this.getSettings(t);
    const filterUsers = customerFilterUsers && !filters.includeUnlicensed;

    const run = await this.s(t)
      .insertInto('tenant_discovery_runs')
      .values({ connection_id: conn.id, status: 'queued', started_by: user.id, scope_types: scope })
      .returningAll()
      .executeTakeFirstOrThrow()
      .catch((err) => {
        // idx_tenant_discovery_runs_one_in_flight: another start got in first
        if (isUniqueViolation(err)) throw new BadRequestException('A discovery is already running for this customer');
        throw err;
      });

    await this.enqueueRun(t, run.id, {
      kind: 'tenant_discovery.run',
      tenantId: t.id,
      schema: t.schema,
      runId: run.id,
      connectionId: conn.id,
      operatorUserId: user.id,
      scopeTypes: scope ?? undefined,
      includeDisabled: filters.includeDisabled || undefined,
      includeUnlicensed: filters.includeUnlicensed || undefined,
      filterUsers,
    });

    const scopeLabel =
      (scope ? scope.join(', ') : 'full') +
      (filters.includeDisabled ? ' +disabled' : '') +
      (filters.includeUnlicensed ? ' +unlicensed' : '') +
      (filterUsers ? '' : ' +allusers');
    const sessionOwner = foreign ? { ranAs: conn.upn, sessionOwnerId: conn.started_by } : {};
    await this.audit.tenant(t.schema, 'tenant_discovery.run_started', {
      actor: actorOf(user),
      targetType: 'tenant_discovery_run',
      targetId: run.id,
      detail: { connectionId: conn.id, upn: conn.upn, scope: scopeLabel, ...sessionOwner },
    });
    await this.audit.platform('tenant_discovery.run_started', {
      actor: actorOf(user),
      tenantId: t.id,
      targetType: 'tenant_discovery_run',
      targetId: run.id,
      detail: { scope: scopeLabel, ...sessionOwner },
    });
    return run;
  }

  /**
   * A narrow, users-only sync for exactly the given UPNs - not a full
   * environment sweep. Used by Design & Build's "Validate against tenant"
   * for rows that have no stored tenant_users match (either nothing has
   * synced yet, or a real sync ran but missed that specific person).
   * Fails silently (returns null, never throws): this is a bonus check on
   * top of an already-useful DB-only validation result, not something the
   * caller should have to handle as an error.
   */
  async startTargetedUserRun(t: TenantContext, user: AuthedUser, upns: string[]) {
    const conns = await this.deployments.listConnections(t);
    const conn = conns.find((c) => c.status === 'active' && (c.started_by === user.id || user.role === 'SUPER_ADMIN'));
    if (!conn) return null; // no eligible live session - caller falls back to the DB-only result
    // A pending group-lookup sign-in holds the session: fall back to the DB-only result rather than queue behind it.
    await this.expireStaleGraph(t);
    const graph = await this.s(t).selectFrom('connections').select('graph_status').where('id', '=', conn.id).executeTakeFirst();
    if (graph?.graph_status === 'pending') return null;
    // An update is minutes away: fall back to the DB-only result rather than start a run it would kill.
    if ((await currentMaintenance(this.db))?.phase === 'freeze') return null;

    const running = await this.s(t)
      .selectFrom('tenant_discovery_runs')
      .select('id')
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst();
    if (running) return null; // a real sync (or another targeted check) is already in flight

    // Bounds worst-case job runtime - one pwsh session, so identities are
    // checked serially (~1-3s each).
    const capped = upns.slice(0, 50);
    const run = await this.s(t)
      .insertInto('tenant_discovery_runs')
      .values({ connection_id: conn.id, status: 'queued', kind: 'targeted', started_by: user.id, scope_types: ['user'] })
      .returningAll()
      .executeTakeFirst()
      .catch((err) => {
        if (isUniqueViolation(err)) return undefined; // a run got in first - fall back to the DB-only result
        throw err;
      });
    if (!run) return null;

    await this.enqueueRun(t, run.id, {
      kind: 'tenant_discovery.run',
      tenantId: t.id,
      schema: t.schema,
      runId: run.id,
      connectionId: conn.id,
      operatorUserId: user.id,
      scopeTypes: ['user'],
      targetedUpns: capped,
    });

    await this.audit.tenant(t.schema, 'tenant_discovery.targeted_user_check_started', {
      actor: actorOf(user),
      targetType: 'tenant_discovery_run',
      targetId: run.id,
      detail: { upns: capped, count: capped.length },
    });
    return run;
  }

  /**
   * Hand a just-inserted run to the worker. If the queue is unreachable the
   * row would sit at 'queued' and block every later run, Validate check and
   * purge for this customer until the worker restarted - so mark it failed.
   */
  private async enqueueRun(t: TenantContext, runId: string, data: Record<string, unknown>) {
    try {
      await this.queue.add('tenant_discovery.run', data);
    } catch (err) {
      await this.s(t)
        .updateTable('tenant_discovery_runs')
        .set({ status: 'failed', finished_at: new Date().toISOString(), error: 'Could not hand the run to the worker - try again.' })
        .where('id', '=', runId)
        .execute();
      throw err;
    }
  }

  listRuns(t: TenantContext) {
    return this.s(t)
      .selectFrom('tenant_discovery_runs')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();
  }

  async getRun(t: TenantContext, id: string) {
    const row = await this.s(t)
      .selectFrom('tenant_discovery_runs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('discovery run not found');
    return row;
  }

  /* ============================ version history ============================ */

  /** Change timeline for one discovered object, newest first. */
  async listObjectVersions(t: TenantContext, objectId: string): Promise<TenantObjectVersion[]> {
    const obj = await this.s(t)
      .selectFrom('tenant_objects')
      .select('id')
      .where('id', '=', objectId)
      .executeTakeFirst();
    if (!obj) throw new NotFoundException('object not found');
    return this.s(t)
      .selectFrom('tenant_object_versions')
      .selectAll()
      .where('object_id', '=', objectId)
      .orderBy('changed_at', 'desc')
      .limit(200)
      .execute() as unknown as Promise<TenantObjectVersion[]>;
  }

  /** Everything a given run added / changed / removed (the "what changed in this sync" log). */
  async listRunChanges(
    t: TenantContext,
    runId: string,
    q: TenantObjectsQuery,
  ): Promise<Paginated<TenantObjectVersion>> {
    const run = await this.s(t)
      .selectFrom('tenant_discovery_runs')
      .select('id')
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!run) throw new NotFoundException('discovery run not found');

    let base = this.s(t).selectFrom('tenant_object_versions').where('run_id', '=', runId);
    if (q.type) base = base.where('object_type', '=', q.type);
    if (q.q) {
      const like = `%${q.q}%`;
      base = base.where((eb) =>
        eb.or([eb('object_key', 'ilike', like), eb('display_name', 'ilike', like)]),
      );
    }
    const [{ n }] = await base.select((eb) => eb.fn.countAll<number>().as('n')).execute();
    const items = (await base
      .selectAll()
      .orderBy('object_type')
      .orderBy(sql`coalesce(display_name, object_key)`)
      .limit(q.limit)
      .offset((q.page - 1) * q.limit)
      .execute()) as unknown as TenantObjectVersion[];
    return { items, total: Number(n), page: q.page, limit: q.limit };
  }

  /* =============================== purge =============================== */

  /**
   * Delete every discovered object, the Users/Policies projections, the M365
   * group cache and the run history for this customer. `tenant_users` / `tenant_policies` cascade from
   * `tenant_objects.object_id`; Data Collection users are kept but their
   * `tenant_user_id` link is cleared (FK is ON DELETE SET NULL). Blocked while a
   * discovery is queued or running. Not reversible - re-run discovery to rebuild.
   */
  async purge(t: TenantContext, user: AuthedUser) {
    const s = this.s(t);

    const running = await s
      .selectFrom('tenant_discovery_runs')
      .select('id')
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst();
    if (running) {
      throw new BadRequestException(
        'A discovery is running - wait for it to finish before deleting the data.',
      );
    }

    const count = async (
      table:
        | 'tenant_objects'
        | 'tenant_object_versions'
        | 'tenant_users'
        | 'tenant_policies'
        | 'tenant_discovery_runs'
        | 'tenant_groups',
    ) => {
      const [{ n }] = await s
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .execute();
      return Number(n);
    };
    const [objects, versions, users, policies, runs, groups, linkedRow] = await Promise.all([
      count('tenant_objects'),
      count('tenant_object_versions'),
      count('tenant_users'),
      count('tenant_policies'),
      count('tenant_discovery_runs'),
      count('tenant_groups'),
      s
        .selectFrom('discovery_users')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('tenant_user_id', 'is not', null)
        .executeTakeFirst(),
    ]);
    const dataCollectionLinksCleared = Number(linkedRow?.n ?? 0);

    // A calling-policy mapping (Design & Build) points at a discovered policy with ON DELETE RESTRICT, which would stop the delete below
    // ("violates foreign key constraint calling_policy_site_map_tenant_policy_id_fkey"). It cannot outlive the policy it names, so it goes
    // first; the site and the calling policy it joined are the customer's own design data and stay.
    const mappingRows = await s.selectFrom('calling_policy_site_map').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst();
    const callingPolicyMappingsRemoved = Number(mappingRows?.n ?? 0);
    await s.deleteFrom('calling_policy_site_map').execute();

    // tenant_objects first: cascades to tenant_users + tenant_policies +
    // tenant_object_versions, and clears discovery_users.tenant_user_id (SET
    // NULL). Then the now-unreferenced runs.
    await s.deleteFrom('tenant_objects').execute();
    await s.deleteFrom('tenant_object_versions').execute();
    await s.deleteFrom('tenant_users').execute();
    await s.deleteFrom('tenant_policies').execute();
    await s.deleteFrom('tenant_discovery_runs').execute();
    // The M365 group cache is discovered data too (Graph sign-in / each run).
    await s.deleteFrom('tenant_groups').execute();

    const result = { objects, versions, users, policies, runs, groups, dataCollectionLinksCleared, callingPolicyMappingsRemoved };
    await this.audit.tenant(t.schema, 'tenant_discovery.purged', {
      actor: actorOf(user),
      targetType: 'tenant',
      targetId: t.id,
      detail: result,
    });
    await this.audit.platform('tenant_discovery.purged', {
      actor: actorOf(user),
      tenantId: t.id,
      targetType: 'tenant',
      targetId: t.id,
      detail: result,
    });
    return result;
  }

  /* =============================== summary =============================== */

  async summary(t: TenantContext, user: AuthedUser): Promise<TenantDiscoverySummary> {
    const s = this.s(t);
    const isAdmin = user.role === 'SUPER_ADMIN';
    // Sequential on purpose: the Discovery page polls this while a run may be
    // hammering the same Postgres, so it must never hold more than one pooled
    // connection at a time (a Promise.all here starved the pool on big tenants).
    const tenantObj = await s
      .selectFrom('tenant_objects')
      .select(['object_key', 'display_name', 'data'])
      .where('object_type', '=', 'tenant')
      .where('removed_at', 'is', null)
      .orderBy('discovered_at', 'desc')
      .executeTakeFirst();
    const lastRun = await s
      .selectFrom('tenant_discovery_runs')
      .selectAll()
      .where('status', 'in', ['completed', 'failed', 'running', 'queued'])
      // a Validate check is not "the latest discovery run"
      .where('kind', '=', 'sync')
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    // Live sessions. A SUPER_ADMIN sees every engineer's; anyone else only their
    // own — an engineer must never adopt or run on a colleague's session.
    let activeQ = s
      .selectFrom('connections')
      .select(['id', 'status', 'upn', 'tenant_domain', 'started_by', 'started_at', 'expires_at'])
      .where('status', 'in', ['active', 'pending'])
      // a session past its expiry is dead even if the row was never flipped
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date().toISOString())]))
      .orderBy('started_at', 'desc');
    if (!isAdmin) activeQ = activeQ.where('started_by', '=', user.id);
    const activeConnections = await this.attachOwners(await activeQ.execute(), user.id);
    const myConn = activeConnections.find((c) => c.isMine) ?? null;
    const countRows = await s
      .selectFrom('tenant_objects')
      .select(['object_type', (eb) => eb.fn.countAll<number>().as('n')])
      .where('removed_at', 'is', null)
      .groupBy('object_type')
      .execute();
    const linked = await s
      .selectFrom('discovery_users')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('tenant_user_id', 'is not', null)
      .executeTakeFirst();
    const groupsCount = await s
      .selectFrom('tenant_groups')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirst();
    const cfg = await s
      .selectFrom('tenant_discovery_config')
      .select(['filter_users', 'notify_on_complete'])
      .executeTakeFirst();

    const counts: Partial<Record<TenantObjectType, number>> = {};
    for (const r of countRows) {
      if ((TENANT_OBJECT_TYPES as readonly string[]).includes(r.object_type)) {
        counts[r.object_type as TenantObjectType] = Number(r.n);
      }
    }
    const td = (tenantObj?.data ?? {}) as Record<string, unknown>;
    return {
      tenant: tenantObj
        ? {
            id: tenantObj.object_key,
            displayName: tenantObj.display_name,
            domains: Array.isArray(td.domains) ? (td.domains as string[]) : [],
          }
        : null,
      lastRun: lastRun ?? null,
      activeConnection: myConn,
      activeConnections,
      canManageConnections: isAdmin,
      counts,
      linkedDiscoveryUsers: Number(linked?.n ?? 0),
      groupsCount: Number(groupsCount?.n ?? 0),
      settings: {
        filterUsers: cfg?.filter_users ?? true,
        notifyOnComplete: cfg?.notify_on_complete ?? true,
      },
    };
  }

  /* =============================== objects =============================== */

  async listObjects(t: TenantContext, q: TenantObjectsQuery): Promise<Paginated<unknown>> {
    let base = this.s(t).selectFrom('tenant_objects');
    if (!q.includeRemoved) base = base.where('removed_at', 'is', null);
    if (q.type) base = base.where('object_type', '=', q.type);
    if (q.q) {
      const like = `%${q.q}%`;
      const term = q.q;
      base = base.where((eb) =>
        eb.or([
          eb('display_name', 'ilike', like),
          eb('object_key', 'ilike', like),
          sql<boolean>`search @@ plainto_tsquery('simple', ${term})`,
        ]),
      );
    }
    const [{ n }] = await base.select((eb) => eb.fn.countAll<number>().as('n')).execute();
    const items = await base
      .select([
        'id',
        'object_type',
        'object_key',
        'display_name',
        'data',
        'first_seen_run_id',
        'last_seen_run_id',
        'discovered_at',
        'removed_at',
      ])
      .orderBy('object_type')
      .orderBy(sql`coalesce(display_name, object_key)`)
      .limit(q.limit)
      .offset((q.page - 1) * q.limit)
      .execute();
    return { items, total: Number(n), page: q.page, limit: q.limit };
  }

  async getObject(t: TenantContext, id: string) {
    const row = await this.s(t)
      .selectFrom('tenant_objects')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('object not found');
    return row;
  }

  /* ================================ users ================================ */

  async listUsers(t: TenantContext, q: TenantObjectsQuery): Promise<Paginated<unknown>> {
    let base = this.s(t)
      .selectFrom('tenant_users as u')
      .leftJoin('discovery_users as d', 'd.tenant_user_id', 'u.id');
    if (!q.includeRemoved) base = base.where('u.removed_at', 'is', null);
    if (q.ev) base = base.where('u.enterprise_voice_enabled', '=', true);
    if (q.accountType) base = base.where('u.account_type', '=', q.accountType);
    if (q.q) {
      const like = `%${q.q}%`;
      base = base.where((eb) =>
        eb.or([
          eb('u.upn', 'ilike', like),
          eb('u.display_name', 'ilike', like),
          eb('u.line_uri', 'ilike', like),
          eb('u.department', 'ilike', like),
        ]),
      );
    }
    const [{ n }] = await base.select((eb) => eb.fn.count<number>('u.id').as('n')).execute();
    // real, voice-enabled users first; leavers / ineligible accounts sink to the end
    const items = await base
      .select([...USER_COLS, 'd.id as discovery_user_id'])
      .orderBy(sql`(u.account_type = 'User')`, 'desc')
      .orderBy('u.enterprise_voice_enabled', 'desc')
      .orderBy('u.display_name')
      .orderBy('u.upn')
      .limit(q.limit)
      .offset((q.page - 1) * q.limit)
      .execute();
    return { items, total: Number(n), page: q.page, limit: q.limit };
  }

  /* ================================ groups ================================ */

  /**
   * Search/browse this tenant's cached M365 groups (`tenant_groups`,
   * populated on Graph sign-in - see `connectGraph`/the worker's
   * `handleGraphConnect` - and kept fresh by every subsequent discovery run
   * on that connection while the Graph sub-session stays alive, see the
   * worker's `syncTenantGroups`/`handleTenantDiscoveryRun`). A normal fast
   * DB read, not a live round trip - drives both `GroupAutocomplete`'s
   * typeahead and Discovery's paginated "M365 groups" tab.
   */
  async listGroups(t: TenantContext, q: TenantGroupsQuery): Promise<Paginated<TenantGroupSummary>> {
    let base = this.s(t).selectFrom('tenant_groups');
    if (q.q) {
      const like = `%${q.q}%`;
      base = base.where((eb) =>
        eb.or([eb('display_name', 'ilike', like), eb('mail', 'ilike', like), eb('object_id', 'ilike', like)]),
      );
    }
    const [{ n }] = await base.select((eb) => eb.fn.countAll<number>().as('n')).execute();
    const items = await base
      .selectAll()
      .orderBy('display_name')
      .limit(q.limit)
      .offset((q.page - 1) * q.limit)
      .execute();
    return { items, total: Number(n), page: q.page, limit: q.limit };
  }

  /** Exact (case-insensitive) UPN match against the latest snapshot - drives autofill. */
  async lookupUser(t: TenantContext, upn: string) {
    const row = await this.s(t)
      .selectFrom('tenant_users as u')
      .leftJoin('discovery_users as d', 'd.tenant_user_id', 'u.id')
      .select([...USER_COLS, 'd.id as discovery_user_id'])
      .where(sql`lower(u.upn)`, '=', upn.trim().toLowerCase())
      .where('u.removed_at', 'is', null)
      .executeTakeFirst();
    return row ?? null;
  }

  /* =============================== policies =============================== */

  async listPolicies(t: TenantContext, q: TenantObjectsQuery): Promise<Paginated<unknown>> {
    let base = this.s(t).selectFrom('tenant_policies');
    if (!q.includeRemoved) base = base.where('removed_at', 'is', null);
    if (q.policyType) base = base.where('policy_type', '=', q.policyType);
    if (q.q) {
      const like = `%${q.q}%`;
      base = base.where((eb) => eb.or([eb('name', 'ilike', like), eb('identity', 'ilike', like)]));
    }
    const [{ n }] = await base.select((eb) => eb.fn.countAll<number>().as('n')).execute();
    const items = await base
      .selectAll()
      .orderBy('policy_type')
      .orderBy('is_global', 'desc')
      .orderBy('name')
      .limit(q.limit)
      .offset((q.page - 1) * q.limit)
      .execute();
    return { items, total: Number(n), page: q.page, limit: q.limit };
  }

  /* ============================ import to DC ============================ */

  /** Site id/sitecode list for this tenant, for suggestion matching and site-id validation. */
  private async siteLookup(t: TenantContext) {
    const sites = await this.s(t).selectFrom('discovery_sites').select(['id', 'sitecode']).execute();
    return { byId: new Map(sites.map((s) => [s.id, s.sitecode])), bySitecode: new Map(sites.map((s) => [s.sitecode, s.id])) };
  }

  /** Best-effort site suggestion for one candidate: phone-number match first, naming-convention second. */
  private suggestSiteId(
    name: string | null,
    phone: string | null,
    phoneSitecodes: Map<string, string>,
    sites: { bySitecode: Map<string, string> },
  ): string | null {
    const viaPhone = phone ? phoneSitecodes.get(phone) : undefined;
    const viaName = name ? matchSitecodeFromName(name, [...sites.bySitecode.keys()]) : null;
    const sitecode = viaPhone ?? viaName ?? null;
    return sitecode ? sites.bySitecode.get(sitecode) ?? null : null;
  }

  /** Validates every distinct siteId an import call references (fallback + per-row) belongs to this tenant and is in the caller's scope. */
  private async assertSitesUsable(t: TenantContext, siteIds: Set<string>) {
    if (!siteIds.size) return;
    const known = await this.s(t).selectFrom('discovery_sites').select('id').where('id', 'in', [...siteIds]).execute();
    if (known.length !== siteIds.size) throw new BadRequestException('Unknown site for this customer.');
    for (const id of siteIds) assertSiteInScope(t, id);
  }

  /**
   * Create Data Collection users for discovered tenant users that aren't captured
   * yet (matched on lower(upn)), and link any existing unlinked matches.
   * `input.assignments` gives each included candidate its own site; a
   * candidate not named there falls back to `input.siteId` (the "set all
   * to..." convenience), and is skipped if neither is given.
   */
  async importUsers(t: TenantContext, user: AuthedUser, input: TenantUsersImportInput, canReview: boolean) {
    const s = this.s(t);
    const assignmentMap = new Map(input.assignments.map((a) => [a.id, a.siteId]));
    await this.assertSitesUsable(t, new Set([...assignmentMap.values(), ...(input.siteId ? [input.siteId] : [])]));

    // 1. Link existing Data Collection users that match a tenant user but aren't linked yet.
    const relinked = await s
      .updateTable('discovery_users')
      .set({
        tenant_user_id: sql`(SELECT tu.id FROM ${sql.table(`${t.schema}.tenant_users`)} tu
                              WHERE lower(tu.upn) = lower(${sql.ref('discovery_users.upn')})
                                AND tu.removed_at IS NULL LIMIT 1)`,
      })
      .where('tenant_user_id', 'is', null)
      .where(
        sql<boolean>`EXISTS (SELECT 1 FROM ${sql.table(`${t.schema}.tenant_users`)} tu
                     WHERE lower(tu.upn) = lower(${sql.ref('discovery_users.upn')})
                       AND tu.removed_at IS NULL)`,
      )
      .executeTakeFirst();

    // 2. Candidates: live tenant users of type User (optionally EV-enabled) not yet captured.
    let cand = s
      .selectFrom('tenant_users as u')
      .select(['u.id', 'u.upn', 'u.display_name'])
      .where('u.removed_at', 'is', null)
      .where((eb) => eb.or([eb('u.account_type', '=', 'User'), eb('u.account_type', 'is', null)]))
      .where(
        sql<boolean>`NOT EXISTS (SELECT 1 FROM ${sql.table(`${t.schema}.discovery_users`)} d
                         WHERE lower(d.upn) = lower(u.upn))`,
      );
    if (input.onlyEnterpriseVoice) cand = cand.where('u.enterprise_voice_enabled', '=', true);
    const rows = await cand.orderBy('u.display_name').execute();

    let created = 0;
    let skipped = 0;
    const perSite = new Map<string, number>();
    for (const r of rows) {
      const siteId = assignmentMap.get(r.id) ?? input.siteId;
      if (!siteId) {
        skipped += 1;
        continue;
      }
      await s
        .insertInto('discovery_users')
        .values({
          site_id: siteId,
          upn: r.upn,
          display_name: r.display_name,
          calling_policy_id: input.calling_policy_id ?? null,
          tenant_user_id: r.id,
        })
        .execute();
      created += 1;
      perSite.set(siteId, (perSite.get(siteId) ?? 0) + 1);
    }

    const result = { created, skipped, linked: Number(relinked?.numUpdatedRows ?? 0) };
    await this.audit.tenant(t.schema, 'discovery.users_imported', {
      actor: actorOf(user),
      targetType: 'discovery_site',
      targetId: input.siteId,
      detail: { created, skipped, linked: result.linked, onlyEnterpriseVoice: input.onlyEnterpriseVoice },
    });
    for (const [siteId, n] of perSite) await this.dataCollection.trackChange(t, user, { siteId, entity: 'User', action: 'added', label: `${n} user${n === 1 ? '' : 's'} imported from the tenant` });
    return result;
  }

  /** Candidate tenant users an import would create, each with a best-effort suggested site (for the dialog). */
  async importPreview(t: TenantContext, onlyEnterpriseVoice: boolean) {
    const s = this.s(t);
    const [sites, phoneMap] = await Promise.all([this.siteLookup(t), this.telephony.listNumberSiteMap(t)]);
    const phoneSitecodes = new Map(phoneMap.filter((p) => p.sitecode).map((p) => [p.e164, p.sitecode as string]));

    let cand = s
      .selectFrom('tenant_users as u')
      .select(['u.id', 'u.upn', 'u.display_name', 'u.line_uri', 'u.telephone_numbers'])
      .where('u.removed_at', 'is', null)
      .where((eb) => eb.or([eb('u.account_type', '=', 'User'), eb('u.account_type', 'is', null)]))
      .where(
        sql<boolean>`NOT EXISTS (SELECT 1 FROM ${sql.table(`${t.schema}.discovery_users`)} d
                         WHERE lower(d.upn) = lower(u.upn))`,
      );
    if (onlyEnterpriseVoice) cand = cand.where('u.enterprise_voice_enabled', '=', true);
    const rows = await cand.orderBy('u.display_name').execute();

    const candidates = rows.map((r) => {
      const nums = Array.isArray(r.telephone_numbers) ? (r.telephone_numbers as { number?: string }[]) : [];
      const phone = stripTel(r.line_uri) ?? stripTel(nums[0]?.number ?? null);
      return {
        id: r.id,
        name: r.display_name,
        upn: r.upn,
        phone,
        suggestedSiteId: this.suggestSiteId(r.display_name, phone, phoneSitecodes, sites),
      };
    });
    return { candidates };
  }

  /**
   * Same idea as `importPreview`/`importUsers` but for discovered resource
   * accounts (`tenant_objects`, `object_type = 'resource_account'`) -
   * Data Collection's own import never covered these until now. Matched
   * on lower(name), same convention `BuildService.populateResourceAccounts`
   * already uses to correlate a Data Collection row to its live match.
   */
  async importResourceAccountsPreview(t: TenantContext) {
    const s = this.s(t);
    const [sites, phoneMap] = await Promise.all([this.siteLookup(t), this.telephony.listNumberSiteMap(t)]);
    const phoneSitecodes = new Map(phoneMap.filter((p) => p.sitecode).map((p) => [p.e164, p.sitecode as string]));
    const kindByAppId = new Map(Object.entries(RESOURCE_ACCOUNT_APPLICATION_IDS).map(([kind, id]) => [id, kind]));

    const rows = await s
      .selectFrom('tenant_objects as o')
      .select(['o.id', 'o.display_name', 'o.data'])
      .where('o.object_type', '=', 'resource_account')
      .where('o.removed_at', 'is', null)
      .where(
        // already on a site: by the exact object (names can repeat, so a name never counts)
        sql<boolean>`NOT EXISTS (SELECT 1 FROM ${sql.table(`${t.schema}.discovery_resource_accounts`)} d WHERE d.tenant_object_id = o.id)`,
      )
      .orderBy('o.display_name')
      .execute();

    const candidates = rows.map((r) => {
      const d = (r.data ?? {}) as Record<string, unknown>;
      const phone = stripTel(typeof d.PhoneNumber === 'string' ? d.PhoneNumber : null);
      const kind = typeof d.ApplicationId === 'string' ? kindByAppId.get(d.ApplicationId) ?? null : null;
      return {
        id: r.id,
        name: r.display_name,
        kind,
        phone,
        suggestedSiteId: this.suggestSiteId(r.display_name, phone, phoneSitecodes, sites),
      };
    });
    return { candidates };
  }

  /* ====== adding discovered voice apps and resource accounts to a site ====== */

  /**
   * What the live data says about voice apps and resource accounts, loaded once for a batch. Everything here is looked up by the
   * object's own key (GUID or UPN): a voice app lists its resource accounts' GUIDs in ApplicationInstances, which is how the two are
   * tied together. Names are only ever shown, never matched on.
   */
  async liveVoiceContext(t: TenantContext) {
    const s = this.s(t);
    const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '');
    const instancesOf = (d: unknown): string[] => {
      const v = (d as Record<string, unknown> | null)?.ApplicationInstances;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(lower) : [];
    };
    const [ras, apps, schedules, users, flows] = await Promise.all([
      s.selectFrom('tenant_objects').select(['id', 'object_key', 'display_name', 'data']).where('object_type', '=', 'resource_account').where('removed_at', 'is', null).execute(),
      s.selectFrom('tenant_objects').select(['id', 'object_type', 'object_key', 'display_name', 'data']).where('object_type', 'in', ['auto_attendant', 'call_queue']).where('removed_at', 'is', null).execute(),
      s.selectFrom('tenant_objects').select(['object_key', 'data']).where('object_type', '=', 'schedule').where('removed_at', 'is', null).execute(),
      s.selectFrom('tenant_users').select(['entra_id', 'upn']).where('entra_id', 'is not', null).execute(),
      s.selectFrom('discovery_flows').select(['id', 'tenant_object_id']).where('tenant_object_id', 'is not', null).execute(),
    ]);
    const raByKey = new Map(ras.map((r) => [lower(r.object_key), r]));
    const ownerOfRa = new Map<string, (typeof apps)[number]>();
    for (const a of apps) for (const k of instancesOf(a.data)) ownerOfRa.set(k, a);
    const appByIdentity = new Map(apps.map((a) => [lower((a.data as Record<string, unknown>)?.Identity ?? a.object_key), a]));
    return {
      lower,
      instancesOf,
      raByKey,
      ownerOfRa,
      appByIdentity,
      scheduleByKey: new Map(schedules.map((r) => [r.object_key, (r.data ?? {}) as Record<string, unknown>])),
      upnByEntra: new Map(users.map((u) => [u.entra_id!.toLowerCase(), u.upn])),
      flowIdByApp: new Map(flows.map((f) => [f.tenant_object_id!, f.id])),
    };
  }

  /** The resource accounts a discovered voice app lists. */
  private raObjectsOf(ctx: Awaited<ReturnType<TenantDiscoveryService['liveVoiceContext']>>, app: { data: unknown }) {
    return ctx.instancesOf(app.data).map((k) => ctx.raByKey.get(k)).filter((r): r is NonNullable<typeof r> => !!r);
  }

  /** What Teams holds about a discovered voice app, as the Voice apps record's text fields and the Call flow's wizard answers. */
  private voiceAppDetails(ctx: Awaited<ReturnType<TenantDiscoveryService['liveVoiceContext']>>, app: { id: string; object_type: string; object_key: string; display_name: string | null; data: unknown }) {
    const appData = (app.data ?? {}) as Record<string, unknown>;
    const nameOf = (id: string) => {
      const key = id.toLowerCase();
      return ctx.upnByEntra.get(key) ?? ctx.appByIdentity.get(key)?.display_name ?? ctx.ownerOfRa.get(key)?.display_name ?? undefined;
    };
    const wizardCtx = {
      personOf: (id: string) => ctx.upnByEntra.get(id.toLowerCase()),
      appOf: (id: string) => {
        const key = id.toLowerCase();
        const hit = ctx.appByIdentity.get(key) ?? ctx.ownerOfRa.get(key);
        if (!hit) return undefined;
        const flowId = ctx.flowIdByApp.get(hit.id);
        return { name: hit.display_name ?? hit.object_key, ...(flowId ? { flowId } : {}) };
      },
    };
    if (app.object_type === 'call_queue') {
      const w = callQueueToWizard(appData, wizardCtx);
      return { fields: callQueueFields(appData, nameOf), flow: { answers: w.answers, notes: w.notes } };
    }
    const resolveTarget = (ref: LiveCallableEntityRef | undefined): AutoAttendantCallableEntity | undefined => {
      if (!ref) return undefined;
      if (ref.kind === 'external' && ref.number) return { kind: 'external', number: ref.number };
      if (ref.kind === 'user' && ref.liveId) return { kind: 'user', upn: ctx.upnByEntra.get(ref.liveId.toLowerCase()) ?? ref.liveId };
      if (ref.kind === 'shared_voicemail' && ref.liveId) return { kind: 'shared_voicemail', groupId: ref.liveId };
      const target = ref.kind === 'voice_app' ? ctx.appByIdentity.get(ref.liveId?.toLowerCase() ?? '') : ref.kind === 'resource_account' && ref.liveId ? ctx.ownerOfRa.get(ref.liveId.toLowerCase()) : undefined;
      const identity = target ? ctx.lower((target.data as Record<string, unknown>)?.Identity ?? target.object_key) : undefined;
      return target && identity ? { kind: target.object_type as 'auto_attendant' | 'call_queue', buildId: identity } : undefined;
    };
    const structured = liveAutoAttendantToStructured(appData, ctx.scheduleByKey, resolveTarget);
    const w = autoAttendantToWizard(structured, wizardCtx);
    return { fields: autoAttendantFields(structured, nameOf), flow: { answers: w.answers, notes: w.notes } };
  }

  /**
   * Attaches the discovered numbers to a Data Collection resource account. A number in none of the ranges is first added to this
   * site's ranges (as a single-number "re-point" range, since it already exists live); one in another site's range, or already
   * assigned, is left alone. Returns what could not be attached, in words, for the result screen.
   */
  private async attachDiscoveredNumbers(t: TenantContext, user: AuthedUser, raId: string, siteId: string, numbers: string[]): Promise<string[]> {
    const s = this.s(t);
    const problems: string[] = [];
    const sitecode = (await this.siteLookup(t)).byId.get(siteId) ?? null;
    const find = (e164: string) =>
      s
        .selectFrom('phone_numbers as n')
        .innerJoin('discovery_number_ranges as r', 'r.id', 'n.range_id')
        .select(['n.id', 'n.status', 'n.holder_id', 'r.sitecode'])
        .where('n.e164', '=', e164)
        .executeTakeFirst();
    for (const raw of [...new Set(numbers)]) {
      const e164 = `+${raw.replace(/\D/g, '')}`;
      let row = await find(e164);
      if (!row && sitecode) {
        await this.telephony.addRange(t, user, { sitecode, range_start: e164, range_end: e164, kind: 'retain', comments: 'Added from Discovery: the number is already live in the tenant.' } as never, false);
        row = await find(e164);
      }
      if (!row) problems.push(`${e164} could not be added to a number range, so it was not attached.`);
      else if (row.sitecode !== sitecode) problems.push(row.sitecode ? `${e164} is in the number range of site ${row.sitecode}, so it was not attached.` : `${e164} is in a number range that has no site, so it was not attached.`);
      else if (row.holder_id === raId) continue;
      else if (row.holder_id) problems.push(`${e164} is already assigned in Data Collection, so it was not attached.`);
      else await this.telephony.attachRaNumber(t, user, raId, row.id, false);
    }
    return problems;
  }

  /**
   * One resource account on a site, from a discovered resource account. Found by the exact object; else a design row on this site
   * with the same UPN is linked to it (the design and the live account are the same thing); else a new row is made, with its number.
   * `voiceApp` is the Data Collection voice app it answers for, when that is on this site.
   */
  private async ensureResourceAccount(
    t: TenantContext,
    user: AuthedUser,
    ctx: Awaited<ReturnType<TenantDiscoveryService['liveVoiceContext']>>,
    siteId: string,
    ra: { id: string; object_key: string; display_name: string | null; data: unknown },
    voiceApp: { id: string; kind: 'auto_attendant' | 'call_queue' } | null,
  ): Promise<{ status: 'created' | 'existing' | 'matched' | 'other_site'; id: string; joined: boolean; problems: string[]; siteId?: string | null }> {
    const s = this.s(t);
    const d = (ra.data ?? {}) as Record<string, unknown>;
    const upn = typeof d.UserPrincipalName === 'string' ? d.UserPrincipalName.toLowerCase() : null;
    const number = typeof d.PhoneNumber === 'string' ? d.PhoneNumber.replace(/^tel:/i, '').split(';')[0]!.trim() : null;
    const kindByAppId = new Map(Object.entries(RESOURCE_ACCOUNT_APPLICATION_IDS).map(([k, v]) => [v, k]));
    const kind = ((typeof d.ApplicationId === 'string' ? kindByAppId.get(d.ApplicationId) : undefined) ?? voiceApp?.kind ?? (ctx.ownerOfRa.get(ctx.lower(ra.object_key))?.object_type as 'auto_attendant' | 'call_queue' | undefined) ?? 'auto_attendant') as 'auto_attendant' | 'call_queue';

    const existing = await s.selectFrom('discovery_resource_accounts').select(['id', 'site_id', 'voice_app_id']).where('tenant_object_id', '=', ra.id).executeTakeFirst();
    if (existing) {
      if (existing.site_id !== siteId) return { status: 'other_site', id: existing.id, joined: false, problems: [], siteId: existing.site_id };
      const joined = !!voiceApp && !existing.voice_app_id;
      if (joined) await s.updateTable('discovery_resource_accounts').set({ voice_app_id: voiceApp!.id, updated_at: new Date().toISOString() }).where('id', '=', existing.id).execute();
      return { status: 'existing', id: existing.id, joined, problems: [] };
    }
    if (upn) {
      const design = await s.selectFrom('discovery_resource_accounts').select(['id', 'voice_app_id']).where('site_id', '=', siteId).where('tenant_object_id', 'is', null).where(sql`lower(upn)`, '=', upn).executeTakeFirst();
      if (design) {
        await s.updateTable('discovery_resource_accounts').set({ tenant_object_id: ra.id, voice_app_id: design.voice_app_id ?? voiceApp?.id ?? null, updated_at: new Date().toISOString() }).where('id', '=', design.id).execute();
        const problems = await this.attachDiscoveredNumbers(t, user, design.id, siteId, number ? [number] : []);
        return { status: 'matched', id: design.id, joined: false, problems };
      }
    }
    const row = await s
      .insertInto('discovery_resource_accounts')
      .values({ site_id: siteId, voice_app_id: voiceApp?.id ?? null, name: ra.display_name ?? upn ?? ra.object_key, kind, upn, tenant_object_id: ra.id, comments: 'Added from Discovery.' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const problems = await this.attachDiscoveredNumbers(t, user, row.id, siteId, number ? [number] : []);
    return { status: 'created', id: row.id, joined: false, problems };
  }

  /**
   * One voice app on a site, from a discovered auto attendant or call queue: its record (named with its own name, with what Teams
   * holds), its Call flow, and a resource account row for each resource account it lists (none if it lists none - a nested voice app
   * needs no resource account). Found by the exact object; else a design voice app of the same kind and name on this site, if there
   * is exactly one, is linked to it. Several designs with that name are not guessed between.
   */
  private async ensureVoiceApp(
    t: TenantContext,
    user: AuthedUser,
    ctx: Awaited<ReturnType<TenantDiscoveryService['liveVoiceContext']>>,
    siteId: string,
    app: { id: string; object_type: string; object_key: string; display_name: string | null; data: unknown },
  ): Promise<{ status: 'created' | 'existing' | 'matched' | 'other_site' | 'ambiguous'; id?: string; raIds: string[]; newRas: number; problems: string[]; siteId?: string | null }> {
    const s = this.s(t);
    const kind = app.object_type as 'auto_attendant' | 'call_queue';
    const name = app.display_name ?? app.object_key;
    const details = this.voiceAppDetails(ctx, app);
    const problems: string[] = [];

    let id: string;
    let status: 'created' | 'existing' | 'matched' = 'existing';
    const existing = await s.selectFrom('discovery_voice_apps').select(['id', 'site_id']).where('tenant_object_id', '=', app.id).executeTakeFirst();
    if (existing) {
      if (existing.site_id !== siteId) return { status: 'other_site', id: existing.id, raIds: [], newRas: 0, problems, siteId: existing.site_id };
      id = existing.id;
    } else {
      const designs = await s.selectFrom('discovery_voice_apps').select('id').where('site_id', '=', siteId).where('kind', '=', kind).where('tenant_object_id', 'is', null).where(sql`lower(name)`, '=', name.toLowerCase()).execute();
      if (designs.length > 1) return { status: 'ambiguous', raIds: [], newRas: 0, problems };
      if (designs.length === 1) {
        id = designs[0]!.id;
        status = 'matched';
        await s.updateTable('discovery_voice_apps').set({ tenant_object_id: app.id, updated_at: new Date().toISOString() }).where('id', '=', id).execute();
        await s.updateTable('discovery_flows').set({ tenant_object_id: app.id }).where('voice_app_id', '=', id).where('tenant_object_id', 'is', null).execute();
      } else {
        status = 'created';
        id = (await s.insertInto('discovery_voice_apps').values({ site_id: siteId, name, kind, tenant_object_id: app.id, ...details.fields }).returning('id').executeTakeFirstOrThrow()).id;
      }
    }

    // its Call flow: the wizard's answers, read back from the live settings
    const hasFlow = await s.selectFrom('discovery_flows').select('id').where('voice_app_id', '=', id).executeTakeFirst();
    if (!hasFlow && status !== 'existing') {
      await s
        .insertInto('discovery_flows')
        .values({
          site_id: siteId,
          kind,
          name,
          description: ['Added from Discovery.', ...details.flow.notes].join(' '),
          wizard_answers: (details.flow.answers ?? null) as never,
          wizard_version: details.flow.answers ? 1 : null,
          voice_app_id: id,
          tenant_object_id: app.id,
        })
        .onConflict((oc) => oc.column('tenant_object_id').where('tenant_object_id', 'is not', null).doNothing())
        .execute();
      await this.dataCollection.trackChange(t, user, { siteId, entity: 'Call flow', action: 'added', label: name });
    }

    // its resource accounts
    const raIds: string[] = [];
    let newRas = 0;
    for (const ra of this.raObjectsOf(ctx, app)) {
      const r = await this.ensureResourceAccount(t, user, ctx, siteId, ra, { id, kind });
      if (r.status === 'other_site') {
        problems.push(`Resource account ${ra.display_name ?? ra.object_key} is on site ${(await this.siteLookup(t)).byId.get(r.siteId ?? '') ?? 'another site'}, so it was not added here.`);
        continue;
      }
      raIds.push(r.id);
      if (r.status === 'created' || r.status === 'matched' || r.joined) newRas += 1;
      problems.push(...r.problems);
    }
    // the Call flow names the first resource account that answers it
    if (raIds.length) await s.updateTable('discovery_flows').set({ resource_account_id: raIds[0] }).where('voice_app_id', '=', id).where('resource_account_id', 'is', null).execute();
    return { status, id, raIds, newRas, problems };
  }

  /**
   * The Data Collection half of "add to site" for objects picked on a Discovery tab. Every object is matched on its own key and
   * never on a display name, which can repeat: an account on its UPN, a resource account, auto attendant or call queue on its tenant
   * object id (the exact discovered object, which carries the Teams GUID). A voice app brings its own resource accounts; a resource
   * account brings only itself and joins the voice app that lists it when that voice app is already on the site. An object already on
   * the chosen site is left alone; one on another site is reported and not moved.
   * Returns each item's result, the Data Collection row it ended up on, and the resource account rows Design & Build should follow.
   */
  async captureSelected(
    t: TenantContext,
    user: AuthedUser,
    kind: 'account' | 'resource_account' | 'call_queue' | 'auto_attendant',
    items: { id: string; siteId: string; as?: 'user' | 'cap' }[],
  ): Promise<{ results: AddFromDiscoveryItemResult[]; dcIds: Map<string, string>; raIds: Map<string, string[]> }> {
    const s = this.s(t);
    await this.assertSitesUsable(t, new Set(items.map((i) => i.siteId)));
    const sites = await this.siteLookup(t);
    const siteCode = (id: string | null | undefined) => (id ? (sites.byId.get(id) ?? null) : null);
    const siteOf = new Map(items.map((i) => [i.id, i.siteId]));
    const ids = [...siteOf.keys()];
    const results: AddFromDiscoveryItemResult[] = [];
    const dcIds = new Map<string, string>();
    const raIds = new Map<string, string[]>();
    const added = new Map<string, number>(); // `${kind}:${siteId}` -> count, for the change log
    const off = 'off' as const;
    const missing = (id: string): AddFromDiscoveryItemResult => ({ id, label: id, key: id, dataCollection: 'not_found', designAndBuild: off, note: 'Not in the discovered data any more.' });

    if (kind === 'account') {
      // A common area phone is an account like any other in the tenant data, so each one is routed: to Users, or to Common area
      // phones. The engineer's choice (`as`) wins; otherwise it is detected from the licence plan.
      const found = await s.selectFrom('tenant_users').select(['id', 'upn', 'display_name', 'assigned_plans']).where('removed_at', 'is', null).where('id', 'in', ids).execute();
      const upns = found.map((f) => f.upn.toLowerCase());
      const [dcUsers, dcCaps] = upns.length
        ? await Promise.all([
            s.selectFrom('discovery_users').select(['id', 'upn', 'site_id']).where(sql`lower(upn)`, 'in', upns).execute(),
            s.selectFrom('discovery_caps').select(['id', 'upn', 'site_id']).where(sql`lower(upn)`, 'in', upns).execute(),
          ])
        : [[], []];
      const userByUpn = new Map(dcUsers.map((e) => [e.upn.toLowerCase(), e]));
      const capByUpn = new Map(dcCaps.map((e) => [(e.upn ?? '').toLowerCase(), e]));
      const asOf = new Map(items.map((i) => [i.id, i.as]));
      for (const id of ids) {
        const row = found.find((f) => f.id === id);
        if (!row) {
          results.push(missing(id));
          continue;
        }
        const label = row.display_name ?? row.upn;
        const siteId = siteOf.get(id)!;
        const as: 'user' | 'cap' = asOf.get(id) ?? (isCommonAreaPhone(row.assigned_plans) ? 'cap' : 'user');
        const key = row.upn.toLowerCase();
        const have = as === 'user' ? userByUpn.get(key) : capByUpn.get(key);
        const other = as === 'user' ? capByUpn.get(key) : userByUpn.get(key);
        if (have) {
          dcIds.set(id, have.id);
          const same = have.site_id === siteId;
          results.push({ id, label, key: row.upn, as, dataCollection: same ? 'already_on_site' : 'on_other_site', designAndBuild: off, otherSite: same ? null : siteCode(have.site_id) });
          continue;
        }
        if (other) {
          const same = other.site_id === siteId;
          results.push({
            id, label, key: row.upn, as,
            dataCollection: same ? 'already_on_site' : 'on_other_site',
            designAndBuild: off,
            otherSite: same ? null : siteCode(other.site_id),
            note: `Already in Data Collection as ${as === 'user' ? 'a common area phone' : 'a user'}. Remove it there first to add it as ${as === 'user' ? 'a user' : 'a common area phone'}.`,
          });
          continue;
        }
        const created =
          as === 'user'
            ? await s.insertInto('discovery_users').values({ site_id: siteId, upn: row.upn, display_name: row.display_name, tenant_user_id: row.id }).returning('id').executeTakeFirstOrThrow()
            : await s.insertInto('discovery_caps').values({ site_id: siteId, display_name: row.display_name ?? row.upn, upn: row.upn }).returning('id').executeTakeFirstOrThrow();
        dcIds.set(id, created.id);
        added.set(`${as}:${siteId}`, (added.get(`${as}:${siteId}`) ?? 0) + 1);
        results.push({ id, label, key: row.upn, as, dataCollection: 'added', designAndBuild: off });
      }
    } else {
      const ctx = await this.liveVoiceContext(t);
      const objectType = kind;
      const found = await s.selectFrom('tenant_objects').select(['id', 'object_type', 'object_key', 'display_name', 'data']).where('removed_at', 'is', null).where('object_type', '=', objectType).where('id', 'in', ids).execute();
      for (const id of ids) {
        const f = found.find((x) => x.id === id);
        if (!f) {
          results.push(missing(id));
          continue;
        }
        const label = f.display_name ?? f.object_key;
        const siteId = siteOf.get(id)!;
        if (kind === 'resource_account') {
          // the voice app that lists it, if that voice app is already on this site
          const owner = ctx.ownerOfRa.get(ctx.lower(f.object_key));
          const ownerRow = owner ? await s.selectFrom('discovery_voice_apps').select(['id', 'site_id', 'kind']).where('tenant_object_id', '=', owner.id).executeTakeFirst() : undefined;
          const voiceApp = ownerRow && ownerRow.site_id === siteId ? { id: ownerRow.id, kind: ownerRow.kind } : null;
          const r = await this.ensureResourceAccount(t, user, ctx, siteId, f, voiceApp);
          dcIds.set(id, r.id);
          raIds.set(id, [r.id]);
          if (r.status === 'other_site') {
            results.push({ id, label, key: f.object_key, dataCollection: 'on_other_site', designAndBuild: off, otherSite: siteCode(r.siteId) });
            continue;
          }
          const notes = [
            r.status === 'matched' ? 'Matched to your design with the same UPN and linked to the live account.' : null,
            r.joined ? `Now answers for ${owner?.display_name ?? 'its voice app'}.` : null,
            owner && !voiceApp ? `It answers for ${owner.display_name ?? owner.object_key}, which is not on this site yet: add that voice app to bring its call flow and settings.` : null,
            ...r.problems,
          ].filter(Boolean).join(' ');
          const isNew = r.status === 'created' || r.status === 'matched' || r.joined;
          if (isNew) added.set(`ra:${siteId}`, (added.get(`ra:${siteId}`) ?? 0) + 1);
          results.push({ id, label, key: f.object_key, dataCollection: isNew ? 'added' : 'already_on_site', designAndBuild: off, ...(notes ? { note: notes } : {}) });
          continue;
        }
        const v = await this.ensureVoiceApp(t, user, ctx, siteId, f);
        if (v.status === 'other_site') {
          if (v.id) dcIds.set(id, v.id);
          results.push({ id, label, key: f.object_key, dataCollection: 'on_other_site', designAndBuild: off, otherSite: siteCode(v.siteId) });
          continue;
        }
        if (v.status === 'ambiguous') {
          results.push({ id, label, key: f.object_key, dataCollection: 'ambiguous', designAndBuild: off, note: `More than one voice app on this site is designed with the name "${label}". Rename or remove the extras, then add it again, so it links to the right one.` });
          continue;
        }
        dcIds.set(id, v.id!);
        raIds.set(id, v.raIds);
        const isNew = v.status === 'created' || v.status === 'matched' || v.newRas > 0;
        if (isNew) added.set(`voice:${siteId}`, (added.get(`voice:${siteId}`) ?? 0) + 1);
        const notes = [v.status === 'matched' ? `Matched to your design "${label}" and linked to the live voice app.` : null, v.status === 'existing' && v.newRas > 0 ? 'Added its resource accounts.' : null, ...v.problems].filter(Boolean).join(' ');
        results.push({ id, label, key: f.object_key, dataCollection: isNew ? 'added' : 'already_on_site', designAndBuild: off, ...(notes ? { note: notes } : {}) });
      }
    }

    await this.audit.tenant(t.schema, 'discovery.added_to_site', {
      actor: actorOf(user),
      targetType: 'discovery_site',
      detail: { kind, requested: ids.length, added: results.filter((r) => r.dataCollection === 'added').length },
    });
    const entityOf = (k: string) => (k === 'user' ? 'User' : k === 'cap' ? 'Common area phone' : k === 'ra' ? 'Resource account' : 'Voice app');
    for (const [key, n] of added) {
      const [k, siteId] = key.split(':') as [string, string];
      await this.dataCollection.trackChange(t, user, { siteId, entity: entityOf(k), action: 'added', label: `${n} added from Discovery` });
    }
    return { results, dcIds, raIds };
  }

  /**
   * Bulk "Import into Data Collection" for discovered resource accounts: each candidate becomes a resource account on the site chosen
   * for it, tied to the voice app that lists it when that voice app is already there. A voice app itself is brought in with Add to site.
   */
  async importResourceAccounts(t: TenantContext, user: AuthedUser, input: TenantResourceAccountsImportInput, canReview: boolean) {
    const s = this.s(t);
    const assignmentMap = new Map(input.assignments.map((a) => [a.id, a.siteId]));
    await this.assertSitesUsable(t, new Set([...assignmentMap.values(), ...(input.siteId ? [input.siteId] : [])]));
    const ctx = await this.liveVoiceContext(t);
    const rows = await s
      .selectFrom('tenant_objects as o')
      .select(['o.id', 'o.object_key', 'o.display_name', 'o.data'])
      .where('o.object_type', '=', 'resource_account')
      .where('o.removed_at', 'is', null)
      .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM ${sql.table(`${t.schema}.discovery_resource_accounts`)} d WHERE d.tenant_object_id = o.id)`)
      .execute();

    let created = 0;
    let skipped = 0;
    const perSite = new Map<string, number>();
    for (const r of rows) {
      const siteId = assignmentMap.get(r.id) ?? input.siteId;
      if (!siteId) {
        skipped += 1;
        continue;
      }
      const owner = ctx.ownerOfRa.get(ctx.lower(r.object_key));
      const ownerRow = owner ? await s.selectFrom('discovery_voice_apps').select(['id', 'site_id', 'kind']).where('tenant_object_id', '=', owner.id).executeTakeFirst() : undefined;
      const res = await this.ensureResourceAccount(t, user, ctx, siteId, r, ownerRow && ownerRow.site_id === siteId ? { id: ownerRow.id, kind: ownerRow.kind } : null);
      if (res.status === 'created' || res.status === 'matched') {
        created += 1;
        perSite.set(siteId, (perSite.get(siteId) ?? 0) + 1);
      } else skipped += 1;
    }

    await this.audit.tenant(t.schema, 'discovery.resource_accounts_imported', {
      actor: actorOf(user),
      targetType: 'discovery_site',
      targetId: input.siteId,
      detail: { created, skipped },
    });
    for (const [siteId, n] of perSite) await this.dataCollection.trackChange(t, user, { siteId, entity: 'Resource account', action: 'added', label: `${n} imported from the tenant` });
    return { created, skipped };
  }
}

/** Postgres unique_violation (23505). */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}
