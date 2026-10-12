import type { Kysely } from 'kysely';
import { platformDb, tenantDb, type DB } from '@tvmf/db';
import {
  summarizeReleaseCheck,
  type ReleaseCheck,
  type ReleaseCheckConnection,
  type ReleaseCheckDeployment,
  type ReleaseCheckDiscoveryRun,
} from '@tvmf/shared';
import { currentMaintenance, iso } from './maintenance';

/**
 * What a release would interrupt right now. The worker keeps customer-tenant
 * sessions (pwsh) in memory, and its startup sweep (expireOrphanedWork in
 * apps/worker/src/main.ts) expires every pending/active connection and fails
 * every queued/running discovery run and deployment - so this lists exactly
 * those rows, across every customer schema. Read-only.
 */
export async function collectReleaseCheck(db: Kysely<DB>, now: Date = new Date()): Promise<ReleaseCheck> {
  // Same population the sweep walks: every tenant, archived included.
  const tenants = await platformDb(db).selectFrom('tenants').select(['id', 'name', 'schema_name']).orderBy('name').execute();

  const connections: ReleaseCheckConnection[] = [];
  const discoveryRuns: ReleaseCheckDiscoveryRun[] = [];
  const deployments: ReleaseCheckDeployment[] = [];
  const ownerIds = new Set<string>();

  for (const t of tenants) {
    const s = tenantDb(db, t.schema_name);
    // A schema mid-provisioning (or a broken one) shouldn't hide everything else.
    const [conns, runs, deps] = await Promise.all([
      s
        .selectFrom('connections')
        .select(['id', 'status', 'started_by', 'upn', 'started_at'])
        .where('status', 'in', ['pending', 'active'])
        .execute()
        .catch(() => []),
      s
        .selectFrom('tenant_discovery_runs')
        .select(['id', 'status', 'kind', 'started_by', 'started_at', 'created_at'])
        .where('status', 'in', ['queued', 'running'])
        .execute()
        .catch(() => []),
      s
        .selectFrom('deployments')
        .select(['id', 'status', 'mode', 'created_by', 'started_at', 'created_at'])
        .where('status', 'in', ['queued', 'running'])
        .execute()
        .catch(() => []),
    ]);
    const base = { tenantId: t.id, tenantName: t.name, ownerName: null, ownerEmail: null };
    for (const c of conns) {
      ownerIds.add(c.started_by);
      connections.push({ ...base, id: c.id, status: c.status as 'pending' | 'active', ownerId: c.started_by, upn: c.upn, startedAt: iso(c.started_at) });
    }
    for (const r of runs) {
      ownerIds.add(r.started_by);
      discoveryRuns.push({
        ...base,
        id: r.id,
        status: r.status as 'queued' | 'running',
        kind: r.kind,
        ownerId: r.started_by,
        startedAt: iso(r.started_at ?? r.created_at),
      });
    }
    for (const d of deps) {
      ownerIds.add(d.created_by);
      deployments.push({
        ...base,
        id: d.id,
        status: d.status as 'queued' | 'running',
        mode: d.mode,
        ownerId: d.created_by,
        startedAt: iso(d.started_at ?? d.created_at),
      });
    }
  }

  if (ownerIds.size) {
    const users = await platformDb(db)
      .selectFrom('users')
      .select(['id', 'display_name', 'email'])
      .where('id', 'in', [...ownerIds])
      .execute();
    const byId = new Map(users.map((u) => [u.id, u]));
    for (const item of [...connections, ...discoveryRuns, ...deployments]) {
      const u = byId.get(item.ownerId);
      item.ownerName = u?.display_name ?? null;
      item.ownerEmail = u?.email ?? null;
    }
  }

  const byStart = (a: { startedAt: string }, b: { startedAt: string }) => a.startedAt.localeCompare(b.startedAt);
  const items = { connections: connections.sort(byStart), discoveryRuns: discoveryRuns.sort(byStart), deployments: deployments.sort(byStart) };
  return {
    ...items,
    ...summarizeReleaseCheck(items),
    checkedAt: now.toISOString(),
    maintenance: await currentMaintenance(db, now),
  };
}
