import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { tenantDb } from '@tvmf/db';
import {
  can,
  deriveSiteProgress,
  progressShortDate,
  SR_OPEN_STATUSES,
  type CustomerProgress,
  type CustomerProgressItem,
  type DiscoveryStatus,
  type ProgressRun,
  type SiteProgressInput,
} from '@tvmf/shared';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { isSiteScoped } from '../data-collection/site-scope';
import { BuildService } from '../build/build.service';

/** Site build tables beyond users / phones / resource accounts - they count towards "Designed" and its last-change time. */
const OTHER_BUILD_TABLES = ['build_auto_attendants', 'build_call_queues', 'build_shared_calling_policies'] as const;
const COUNTED_BUILD_TABLES = ['build_users', 'build_caps', 'build_resource_accounts', ...OTHER_BUILD_TABLES] as const;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

interface PackSource {
  siteIds?: string[];
}

/**
 * The home-page dashboard: each site's stage in the migration, derived from
 * what Data Collection, Design & Build, Deployment, Handover and the site's
 * mode already store (deriveSiteProgress in @tvmf/shared holds the rules).
 * Read-only, and readable by every role - what each role is shown is cut down
 * here, not by the route's permission. See docs/PROGRESS.md.
 */
@Injectable()
export class ProgressService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly build: BuildService,
  ) {}

  async progress(t: TenantContext, user: AuthedUser): Promise<CustomerProgress> {
    const s = tenantDb(this.db, t.schema);
    const fullView = can(user.role, 'build:read') && can(user.role, 'deployment:read');

    let sitesQ = s.selectFrom('discovery_sites').select(['id', 'sitecode', 'name', 'mode']).orderBy('sitecode');
    if (isSiteScoped(t)) sitesQ = sitesQ.where('id', 'in', t.siteScope);
    const [discovery, sites] = await Promise.all([s.selectFrom('discovery').select('status').executeTakeFirst(), sitesQ.execute()]);
    const discoveryStatus: DiscoveryStatus = discovery?.status ?? 'draft';
    const siteIds = sites.map((x) => x.id);

    const items: CustomerProgressItem[] = [];
    if (discoveryStatus === 'draft') {
      items.push({ kind: 'data_collection', message: 'Data Collection has not been submitted yet', attention: true });
    } else if (discoveryStatus === 'submitted') {
      items.push({
        kind: 'data_collection',
        message: 'Data Collection is submitted and waiting for review',
        attention: can(user.role, 'discovery:review'),
      });
    }

    const out: CustomerProgress = { discoveryStatus, fullView, sites: [], items };
    if (can(user.role, 'tenantdiscovery:read')) await this.addDiscoverySync(t, out);
    if (t.managedServices && can(user.role, 'sr:read')) await this.addServiceRequests(t, user, out);
    if (siteIds.length === 0) return out;

    const countBy = async (table: 'discovery_users' | 'discovery_caps' | 'discovery_resource_accounts') => {
      const rows = await s
        .selectFrom(table)
        .select(['site_id', (eb) => eb.fn.countAll<string>().as('n')])
        .where('site_id', 'in', siteIds)
        .groupBy('site_id')
        .execute();
      return new Map(rows.map((r) => [r.site_id as string, Number(r.n)]));
    };

    const [capUsers, capCaps, capRas, rollup, buildStats, finishedRuns, firstLive, activeRuns, packs] = await Promise.all([
      countBy('discovery_users'),
      countBy('discovery_caps'),
      countBy('discovery_resource_accounts'),
      this.build.siteRollup(t),
      this.buildStats(t, siteIds),
      // The latest finished run per site and mode.
      s
        .selectFrom('deployments')
        .select(['mode', 'status', 'created_at', 'summary', sql<string>`scope->>'siteId'`.as('site_id')])
        .where('status', 'in', ['completed', 'failed'])
        .where(sql<string>`scope->>'siteId'`, 'in', siteIds)
        .distinctOn([sql`scope->>'siteId'`, 'mode'])
        .orderBy(sql`scope->>'siteId'`)
        .orderBy('mode')
        .orderBy('created_at', 'desc')
        .execute(),
      // When each site first went live cleanly.
      s
        .selectFrom('deployments')
        .select(['created_at', sql<string>`scope->>'siteId'`.as('site_id')])
        .where('mode', '=', 'execute')
        .where('status', '=', 'completed')
        .where(sql<boolean>`coalesce((summary->>'failed')::int, 0) = 0`)
        .where(sql<string>`scope->>'siteId'`, 'in', siteIds)
        .distinctOn(sql`scope->>'siteId'`)
        .orderBy(sql`scope->>'siteId'`)
        .orderBy('created_at', 'asc')
        .execute(),
      s
        .selectFrom('deployments')
        .select(['mode', sql<string>`scope->>'siteId'`.as('site_id')])
        .where('status', 'in', ['queued', 'running'])
        .where(sql<string>`scope->>'siteId'`, 'in', siteIds)
        .execute(),
      // Packs are customer-wide (source.siteIds empty = every site). Site
      // contacts can't read them, but whether a pack covers their site is
      // only a status, so it is still shown to them.
      s.selectFrom('handover_packs').select(['version', 'status', 'issued_at', 'source']).orderBy('version', 'desc').execute(),
    ]);
    const rollupBySite = new Map(rollup.map((r) => [r.id, r]));

    const runOf = (siteId: string, mode: 'dry_run' | 'execute'): ProgressRun | null => {
      const r = finishedRuns.find((x) => x.site_id === siteId && x.mode === mode);
      if (!r) return null;
      return {
        status: r.status as 'completed' | 'failed',
        createdAt: iso(r.created_at),
        failed: Number((r.summary as Record<string, number> | null)?.failed ?? 0),
      };
    };

    for (const site of sites) {
      const covers = (p: (typeof packs)[number]) => {
        const ids = (p.source as PackSource | null)?.siteIds ?? [];
        return ids.length === 0 || ids.includes(site.id);
      };
      const issued = packs.find((p) => p.status === 'issued' && covers(p));
      const draft = packs.find((p) => p.status === 'draft' && covers(p) && (!issued || p.version > issued.version));
      const r = rollupBySite.get(site.id);
      const stats = buildStats.get(site.id);
      const active = activeRuns.find((x) => x.site_id === site.id);
      const firstLiveAt = firstLive.find((x) => x.site_id === site.id);

      const input: SiteProgressInput = {
        discoveryStatus,
        captured: {
          users: capUsers.get(site.id) ?? 0,
          caps: capCaps.get(site.id) ?? 0,
          resourceAccounts: capRas.get(site.id) ?? 0,
        },
        build: {
          users: r?.counts.users ?? 0,
          caps: r?.counts.caps ?? 0,
          resourceAccounts: r?.counts.resourceAccounts ?? 0,
          other: stats?.other ?? 0,
          validationIssues: r?.validationIssues ?? 0,
          lastChangeAt: stats?.lastChangeAt ?? null,
        },
        lastDryRun: runOf(site.id, 'dry_run'),
        lastLiveRun: runOf(site.id, 'execute'),
        firstLiveAt: firstLiveAt ? iso(firstLiveAt.created_at) : null,
        runInProgress: active ? (active.mode as 'dry_run' | 'execute') : null,
        handover: {
          issued: issued?.issued_at ? { version: issued.version, issuedAt: iso(issued.issued_at) } : null,
          draftVersion: draft?.version ?? null,
        },
        mode: site.mode,
      };
      out.sites.push({ id: site.id, sitecode: site.sitecode, name: site.name, ...deriveSiteProgress(input, fullView) });
    }
    return out;
  }

  /** Per site: rows in the call flow / policy build tables, and the latest updated_at over every build table. */
  private async buildStats(t: TenantContext, siteIds: string[]) {
    const s = tenantDb(this.db, t.schema);
    const out = new Map<string, { other: number; lastChangeAt: string | null }>();
    const perTable = await Promise.all(
      COUNTED_BUILD_TABLES.map((table) =>
        s
          .selectFrom(table)
          .select(['site_id', (eb) => eb.fn.countAll<string>().as('n'), (eb) => eb.fn.max('updated_at').as('last')])
          .where('site_id', 'in', siteIds)
          .groupBy('site_id')
          .execute()
          .then((rows) => ({ table, rows })),
      ),
    );
    for (const { table, rows } of perTable) {
      for (const row of rows) {
        const cur = out.get(row.site_id) ?? { other: 0, lastChangeAt: null };
        if ((OTHER_BUILD_TABLES as readonly string[]).includes(table)) cur.other += Number(row.n);
        const last = row.last ? iso(row.last) : null;
        if (last && (!cur.lastChangeAt || new Date(last) > new Date(cur.lastChangeAt))) cur.lastChangeAt = last;
        out.set(row.site_id, cur);
      }
    }
    return out;
  }

  /** The latest Discovery sync of the live tenant - the same run TenantDiscoveryService.summary reports as lastRun. */
  private async addDiscoverySync(t: TenantContext, out: CustomerProgress) {
    const run = await tenantDb(this.db, t.schema)
      .selectFrom('tenant_discovery_runs')
      .select(['status', 'finished_at', 'created_at'])
      .where('status', 'in', ['completed', 'failed', 'running', 'queued'])
      .where('kind', '=', 'sync')
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    out.lastDiscoverySync = run
      ? { status: run.status, finishedAt: run.finished_at ? iso(run.finished_at) : null, createdAt: iso(run.created_at) }
      : null;
    if (!run) {
      out.items.push({ kind: 'discovery_sync', message: 'The customer tenant has never been synced in Discovery', attention: true });
    } else if (run.status === 'failed') {
      out.items.push({ kind: 'discovery_sync', message: 'The last Discovery sync failed', attention: true });
    } else if (run.status === 'completed') {
      out.items.push({
        kind: 'discovery_sync',
        message: `Discovery last synced ${progressShortDate(iso(run.finished_at ?? run.created_at))}`,
        attention: false,
      });
    } else {
      out.items.push({ kind: 'discovery_sync', message: 'A Discovery sync is running now', attention: false });
    }
  }

  /** Open service requests (the site contact's own sites only); new ones are flagged to the engineers who plan them. */
  private async addServiceRequests(t: TenantContext, user: AuthedUser, out: CustomerProgress) {
    let q = tenantDb(this.db, t.schema)
      .selectFrom('service_requests')
      .select(['status', (eb) => eb.fn.countAll<string>().as('n')])
      .where('status', 'in', [...SR_OPEN_STATUSES])
      .groupBy('status');
    if (isSiteScoped(t)) q = q.where('site_id', 'in', t.siteScope);
    const rows = await q.execute();
    const open = rows.reduce((sum, r) => sum + Number(r.n), 0);
    const fresh = Number(rows.find((r) => r.status === 'new')?.n ?? 0);
    out.openServiceRequests = open;
    if (fresh > 0 && can(user.role, 'sr:manage')) {
      out.items.push({
        kind: 'service_requests',
        message: `${fresh} new service request${fresh === 1 ? '' : 's'} waiting to be planned`,
        attention: true,
      });
    }
    if (open > 0) {
      out.items.push({ kind: 'service_requests', message: `${open} open service request${open === 1 ? '' : 's'}`, attention: false });
    }
  }
}
