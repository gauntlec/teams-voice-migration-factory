import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { forgetBaseUrl, platformDb, savedBaseUrl } from '@tvmf/db';
import { baseUrlWarnings, connectDetails, type BaseUrlView } from '@tvmf/shared';
import { APP_CONFIG, type AppConfig } from '../common/config';
import { InjectDb, type Db } from '../db/db.module';

/**
 * The base URL (Administration > Web address): the address people use to reach this installation.
 *
 * The API reads `cfg.WEB_ORIGIN` wherever it builds a link (emails, notifications) and for the CORS allow-list, so
 * this service keeps that one value current: the saved setting when there is one, else the WEB_ORIGIN environment
 * value it started with. A save takes effect at once; the worker reads the same table (`webOrigin` in @tvmf/db).
 */
@Injectable()
export class BaseUrlService implements OnModuleInit {
  private readonly log = new Logger(BaseUrlService.name);
  private readonly environmentValue: string;

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    this.environmentValue = cfg.WEB_ORIGIN.replace(/\/+$/, '');
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.apply(await savedBaseUrl(this.db, { fresh: true }));
    } catch (err) {
      // Never stop the API from starting over a settings read: the environment value stays in force.
      this.log.warn(`Could not read the saved base URL, using WEB_ORIGIN: ${(err as Error).message}`);
    }
  }

  private apply(saved: string | null) {
    this.cfg.WEB_ORIGIN = saved ?? this.environmentValue;
  }

  async view(): Promise<BaseUrlView> {
    const saved = await savedBaseUrl(this.db, { fresh: true });
    const baseUrl = saved ?? this.environmentValue;
    return {
      baseUrl,
      source: saved ? 'setting' : 'environment',
      environmentValue: this.environmentValue,
      warnings: baseUrlWarnings(baseUrl),
      connect: connectDetails(baseUrl),
    };
  }

  /** Saves the address (null = go back to the environment value) and applies it. */
  async set(baseUrl: string | null, userId: string): Promise<BaseUrlView> {
    await platformDb(this.db)
      .insertInto('app_settings')
      .values({ id: true, base_url: baseUrl, updated_by: userId })
      .onConflict((oc) => oc.column('id').doUpdateSet({ base_url: baseUrl, updated_by: userId, updated_at: new Date().toISOString() }))
      .execute();
    forgetBaseUrl();
    this.apply(baseUrl);
    return this.view();
  }
}
