import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { platformDb, siteSuggestions, tenantDb, type DB } from '@tvmf/db';
import { InjectDb, type Db } from '../../db/db.module';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { TenantDiscoveryService } from './tenant-discovery.service';

/** Who automatic adding acts as: not a person, so the change log says "Voxshift (automatic)". */
const AUTO_ACTOR: AuthedUser = {
  id: '00000000-0000-0000-0000-000000000a01',
  email: 'system:auto-add',
  displayName: 'Voxshift (automatic)',
  role: 'ENGINEER',
  totpEnrolled: true,
  enrolOnly: false,
  pwresetOnly: false,
  system: { id: '00000000-0000-0000-0000-000000000a01', name: 'Automatic add by number range' },
};

/**
 * For a customer that has switched it on (Discovery > Settings), adds what a finished full discovery run found to the site its number
 * says: an account, resource account, auto attendant or call queue whose number is in a site's range and that is on no site yet.
 * Site Data only - Design & Build takes it from there with Populate from Site Data. Something already on another site is never
 * moved. Each run is handled once.
 */
@Injectable()
export class AutoAddByRangeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AutoAddByRange');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly discovery: TenantDiscoveryService,
  ) {}

  onModuleInit() {
    const every = Number(process.env.AUTO_ADD_BY_RANGE_INTERVAL_SECONDS ?? 60);
    if (process.env.NODE_ENV === 'test' || process.env.VITEST || !(every > 0)) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.error(`pass failed: ${(e as Error).message}`)), every * 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over the customers that have it switched on. Returns how many objects were added. */
  async tick(opts: { tenantId?: string } = {}): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let total = 0;
    try {
      let q = platformDb(this.db as Kysely<DB>).selectFrom('tenants').select(['id', 'slug', 'name', 'schema_name', 'managed_services_enabled']).where('status', '=', 'active');
      if (opts.tenantId) q = q.where('id', '=', opts.tenantId);
      for (const row of await q.execute()) {
        try {
          total += await this.forTenant({ id: row.id, slug: row.slug, name: row.name, schema: row.schema_name, siteScope: null, teamsReadOnly: false, managedServices: !!row.managed_services_enabled });
        } catch (e) {
          this.log.warn(`${row.slug}: ${(e as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
    return total;
  }

  async forTenant(t: TenantContext): Promise<number> {
    const s = tenantDb(this.db as Kysely<DB>, t.schema);
    const cfg = await s.selectFrom('tenant_discovery_config').select(['auto_add_by_number_range', 'auto_add_last_run_id']).executeTakeFirst();
    if (!cfg?.auto_add_by_number_range) return 0;
    // the newest finished full run that is not one already handled
    const run = await s
      .selectFrom('tenant_discovery_runs')
      .select(['id'])
      .where('status', '=', 'completed')
      .where('kind', '=', 'sync')
      .where('scope_types', 'is', null)
      .orderBy('finished_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!run || run.id === cfg.auto_add_last_run_id) return 0;

    const { items } = await siteSuggestions(s);
    const toAdd = items.filter((i) => i.state === 'suggest');
    let added = 0;
    let skipped = 0;
    const bySite: Record<string, number> = {};
    for (const kind of ['account', 'resource_account', 'auto_attendant', 'call_queue'] as const) {
      const group = toAdd.filter((i) => i.kind === kind);
      if (!group.length) continue;
      const { results } = await this.discovery.captureSelected(t, AUTO_ACTOR, kind, group.map((i) => ({ id: i.id, siteId: i.siteId, ...(i.as ? { as: i.as } : {}) })));
      for (const r of results) {
        const item = group.find((g) => g.id === r.id);
        if (r.dataCollection === 'added' && item) {
          added += 1;
          bySite[item.sitecode] = (bySite[item.sitecode] ?? 0) + 1;
        } else if (r.dataCollection !== 'already_on_site') skipped += 1;
      }
    }
    await s
      .updateTable('tenant_discovery_config')
      .set({ auto_add_last_run_id: run.id, auto_add_last_at: new Date().toISOString(), auto_add_last_summary: { added, skipped, bySite } as never })
      .execute();
    if (added || skipped) {
      await this.audit.tenant(t.schema, 'tenant_discovery.auto_added', { actor: { id: AUTO_ACTOR.id, email: AUTO_ACTOR.email }, targetType: 'tenant_discovery_run', targetId: run.id, detail: { added, skipped, bySite } });
    }
    return added;
  }
}
