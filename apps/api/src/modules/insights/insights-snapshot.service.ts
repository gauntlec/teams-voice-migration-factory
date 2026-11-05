import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { platformDb } from '@tvmf/db';
import { utcDay } from '@tvmf/shared';
import type { TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { InsightsService } from './insights.service';

/**
 * Takes each active customer's daily snapshot (InsightsService.takeSnapshot) soon after midnight UTC: it checks every
 * INSIGHTS_SNAPSHOT_INTERVAL_SECONDS (default an hour, 0 switches it off) and shortly after the api starts, and a
 * customer that already has today's row is skipped, so a restart or a second api instance never takes two.
 */
@Injectable()
export class InsightsSnapshotService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('InsightsSnapshots');
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private running = false;
  /** the UTC day every customer was last done, so the hourly check costs nothing for the rest of the day */
  private doneDay: string | null = null;

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly insights: InsightsService,
  ) {}

  onModuleInit() {
    const every = Number(process.env.INSIGHTS_SNAPSHOT_INTERVAL_SECONDS ?? 3600);
    if (process.env.NODE_ENV === 'test' || process.env.VITEST || !(every > 0)) return;
    const run = () => void this.tick().catch((e) => this.log.error(`snapshot pass failed: ${(e as Error).message}`));
    this.first = setTimeout(run, 120_000);
    this.first.unref();
    this.timer = setInterval(run, every * 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over the active customers. Returns how many snapshots were written. */
  async tick(now = new Date()): Promise<number> {
    const day = utcDay(now);
    if (this.running || this.doneDay === day) return 0;
    this.running = true;
    let written = 0;
    let failed = 0;
    try {
      const tenants = await platformDb(this.db)
        .selectFrom('tenants')
        .select(['id', 'slug', 'name', 'schema_name', 'teams_read_only', 'managed_services_enabled', 'monitoring_enabled'])
        .where('status', '=', 'active')
        .execute();
      for (const row of tenants) {
        const t: TenantContext = {
          id: row.id,
          slug: row.slug,
          name: row.name,
          schema: row.schema_name,
          siteScope: null,
          teamsReadOnly: !!row.teams_read_only,
          managedServices: !!row.managed_services_enabled,
          monitoringEnabled: !!row.monitoring_enabled,
        };
        try {
          if (await this.insights.takeSnapshot(t, now)) written++;
        } catch (e) {
          failed++;
          this.log.warn(`${row.slug}: ${(e as Error).message}`);
        }
      }
      // A customer that failed is tried again at the next check.
      if (failed === 0) this.doneDay = day;
      if (written) this.log.log(`took ${written} snapshot${written === 1 ? '' : 's'} for ${day}`);
    } finally {
      this.running = false;
    }
    return written;
  }
}
