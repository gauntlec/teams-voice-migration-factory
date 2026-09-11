import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { platformDb, tenantDb, type DB } from '@tvmf/db';
import {
  TENANT_OBJECT_TYPES,
  type Paginated,
  type TenantConnectionInfo,
  type TenantDiscoverySummary,
  type TenantEndpoint,
  type TenantObjectType,
  type TenantObjectVersion,
  type TenantObjectsQuery,
  type TenantUsersImportInput,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { InjectDeployQueue, type Queue } from '../../queue/queue.module';
import { DataCollectionService } from '../data-collection/data-collection.service';
import { assertSiteInScope } from '../data-collection/site-scope';
import { DeploymentService } from '../deployment/deployment.service';

type Scoped = ReturnType<typeof tenantDb>;
const actorOf = (u: AuthedUser) => ({ id: u.id, email: u.email });

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

  /** A connection may only be read by the engineer who established it or a SUPER_ADMIN. */
  async getConnection(t: TenantContext, id: string, user: AuthedUser) {
    const row = await this.deployments.getConnection(t, id);
    if (row.started_by !== user.id && user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('This customer-tenant session belongs to another engineer.');
    }
    return row;
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
    const CAP_PLAN = /MCOCAP|COMMON_?AREA/i;
    const num = (v: unknown): string | null => {
      const raw = String(v ?? '').replace(/^tel:/i, '').trim();
      return raw || null;
    };

    const users = await s
      .selectFrom('tenant_users')
      .select(['upn', 'display_name', 'line_uri', 'account_enabled', 'policies', 'assigned_plans', 'telephone_numbers'])
      .where('removed_at', 'is', null)
      .execute();
    const caps = users
      .filter((u) => {
        const plans = Array.isArray(u.assigned_plans) ? (u.assigned_plans as Record<string, unknown>[]) : [];
        return plans.some(
          (p) =>
            CAP_PLAN.test(String(p?.Capability ?? '')) &&
            ['Enabled', 'Warning'].includes(String(p?.CapabilityStatus ?? '')),
        );
      })
      .map((u) => {
        const nums = Array.isArray(u.telephone_numbers)
          ? (u.telephone_numbers as { number?: string }[])
          : [];
        const pol = (u.policies ?? {}) as Record<string, string | null>;
        return {
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
      .select(['display_name', 'data'])
      .where('object_type', '=', 'resource_account')
      .where('removed_at', 'is', null)
      .execute();
    const raEndpoints = ras
      .map((r) => {
        const d = (r.data ?? {}) as Record<string, unknown>;
        const n = num(d.PhoneNumber);
        return n
          ? {
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
    const running = await this.s(t)
      .selectFrom('tenant_discovery_runs')
      .select('id')
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst();
    if (running) throw new BadRequestException('A discovery is already running for this customer');

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
      .executeTakeFirstOrThrow();

    await this.queue.add('tenant_discovery.run', {
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
      .values({ connection_id: conn.id, status: 'queued', started_by: user.id, scope_types: ['user'] })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.queue.add('tenant_discovery.run', {
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
   * Delete every discovered object, the Users/Policies projections and the run
   * history for this customer. `tenant_users` / `tenant_policies` cascade from
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
        | 'tenant_discovery_runs',
    ) => {
      const [{ n }] = await s
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .execute();
      return Number(n);
    };
    const [objects, versions, users, policies, runs, linkedRow] = await Promise.all([
      count('tenant_objects'),
      count('tenant_object_versions'),
      count('tenant_users'),
      count('tenant_policies'),
      count('tenant_discovery_runs'),
      s
        .selectFrom('discovery_users')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('tenant_user_id', 'is not', null)
        .executeTakeFirst(),
    ]);
    const dataCollectionLinksCleared = Number(linkedRow?.n ?? 0);

    // tenant_objects first: cascades to tenant_users + tenant_policies +
    // tenant_object_versions, and clears discovery_users.tenant_user_id (SET
    // NULL). Then the now-unreferenced runs.
    await s.deleteFrom('tenant_objects').execute();
    await s.deleteFrom('tenant_object_versions').execute();
    await s.deleteFrom('tenant_users').execute();
    await s.deleteFrom('tenant_policies').execute();
    await s.deleteFrom('tenant_discovery_runs').execute();

    const result = { objects, versions, users, policies, runs, dataCollectionLinksCleared };
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

  /**
   * Create Data Collection users for discovered tenant users that aren't captured
   * yet (matched on lower(upn)), and link any existing unlinked matches.
   */
  async importUsers(
    t: TenantContext,
    user: AuthedUser,
    input: TenantUsersImportInput,
    canReview: boolean,
  ) {
    await this.dataCollection.assertEditable(t, canReview);
    const s = this.s(t);
    const site = await s
      .selectFrom('discovery_sites')
      .select('id')
      .where('id', '=', input.siteId)
      .executeTakeFirst();
    if (!site) throw new BadRequestException('Unknown site for this customer.');
    assertSiteInScope(t, site.id);

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
    for (const r of rows) {
      await s
        .insertInto('discovery_users')
        .values({
          site_id: site.id,
          upn: r.upn,
          display_name: r.display_name,
          calling_policy_id: input.calling_policy_id ?? null,
          tenant_user_id: r.id,
        })
        .execute();
      created += 1;
    }

    const result = {
      created,
      linked: Number(relinked?.numUpdatedRows ?? 0),
      skippedExisting: undefined as number | undefined,
    };
    await this.audit.tenant(t.schema, 'discovery.users_imported', {
      actor: actorOf(user),
      targetType: 'discovery_site',
      targetId: site.id,
      detail: { created, linked: result.linked, onlyEnterpriseVoice: input.onlyEnterpriseVoice },
    });
    return result;
  }

  /** How many tenant users an import would create right now (for the dialog). */
  async importPreview(t: TenantContext, onlyEnterpriseVoice: boolean) {
    let cand = this.s(t)
      .selectFrom('tenant_users as u')
      .select((eb) => eb.fn.count<number>('u.id').as('n'))
      .where('u.removed_at', 'is', null)
      .where((eb) => eb.or([eb('u.account_type', '=', 'User'), eb('u.account_type', 'is', null)]))
      .where(
        sql<boolean>`NOT EXISTS (SELECT 1 FROM ${sql.table(`${t.schema}.discovery_users`)} d
                         WHERE lower(d.upn) = lower(u.upn))`,
      );
    if (onlyEnterpriseVoice) cand = cand.where('u.enterprise_voice_enabled', '=', true);
    const row = await cand.executeTakeFirst();
    return { wouldCreate: Number(row?.n ?? 0) };
  }
}
