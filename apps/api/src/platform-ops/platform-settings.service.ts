import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { emailEnabled, forgetAppSettings, platformDb, savedBaseUrl } from '@tvmf/db';
import { baseUrlWarnings, connectDetails, type BaseUrlView, type HubConnectionView } from '@tvmf/shared';
import { APP_CONFIG, type AppConfig } from '../common/config';
import { encryptSecret } from '../common/crypto';
import { InjectDb, type Db } from '../db/db.module';

// The driver hands back Date objects for timestamptz columns whatever the table type says.
const iso = (v: string | Date | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

/**
 * Administration > Platform settings: the base URL (the address people use to reach this installation), the master email switch and the
 * connection to a Voxshift Hub.
 *
 * The base URL:
 *
 * The API reads `cfg.WEB_ORIGIN` wherever it builds a link (emails, notifications) and for the CORS allow-list, so
 * this service keeps that one value current: the saved setting when there is one, else the WEB_ORIGIN environment
 * value it started with. A save takes effect at once; the worker reads the same table (`webOrigin` in @tvmf/db).
 */
@Injectable()
export class PlatformSettingsService implements OnModuleInit {
  private readonly log = new Logger(PlatformSettingsService.name);
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
      emailEnabled: await emailEnabled(this.db, { fresh: true }),
      hub: await this.hubView(),
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
    forgetAppSettings();
    this.apply(baseUrl);
    return this.view();
  }

  /** The master email switch: false stops all email being generated or sent. */
  async setEmailEnabled(enabled: boolean, userId: string): Promise<BaseUrlView> {
    await platformDb(this.db)
      .insertInto('app_settings')
      .values({ id: true, email_enabled: enabled, base_url: null, updated_by: userId })
      .onConflict((oc) => oc.column('id').doUpdateSet({ email_enabled: enabled, updated_by: userId, updated_at: new Date().toISOString() }))
      .execute();
    forgetAppSettings();
    return this.view();
  }

  /** The connection to a Voxshift Hub, without the token (only its last four characters). */
  async hubView(): Promise<HubConnectionView> {
    const r = await platformDb(this.db)
      .selectFrom('app_settings')
      .select(['hub_url', 'hub_token_hint', 'hub_last_attempt_at', 'hub_last_ok_at', 'hub_last_error', 'hub_remote_access', 'hub_tunnel_state', 'hub_tunnel_error'])
      .executeTakeFirst();
    return {
      connected: !!r?.hub_url,
      hubUrl: r?.hub_url ?? null,
      tokenHint: r?.hub_token_hint ?? null,
      lastAttemptAt: iso(r?.hub_last_attempt_at),
      lastOkAt: iso(r?.hub_last_ok_at),
      lastError: r?.hub_last_error ?? null,
      remoteAccess: r?.hub_remote_access ?? false,
      tunnelState: r?.hub_tunnel_state ?? 'off',
      tunnelError: r?.hub_tunnel_error ?? null,
    };
  }

  /** Connects to a hub: the token is stored encrypted, and the worker starts reporting within a minute. */
  async connectHub(hubUrl: string, token: string, userId: string): Promise<BaseUrlView> {
    const values = { hub_url: hubUrl, hub_token_enc: encryptSecret(token), hub_token_hint: `…${token.slice(-4)}`, hub_last_attempt_at: null, hub_last_ok_at: null, hub_last_error: null, hub_remote_access: false, hub_tunnel_state: 'off' as const, hub_tunnel_error: null, hub_tunnel_at: null, updated_by: userId };
    await platformDb(this.db)
      .insertInto('app_settings')
      .values({ id: true, base_url: null, ...values })
      .onConflict((oc) => oc.column('id').doUpdateSet({ ...values, updated_at: new Date().toISOString() }))
      .execute();
    return this.view();
  }

  async disconnectHub(userId: string): Promise<BaseUrlView> {
    await platformDb(this.db)
      .updateTable('app_settings')
      .set({ hub_url: null, hub_token_enc: null, hub_token_hint: null, hub_last_attempt_at: null, hub_last_ok_at: null, hub_last_error: null, hub_remote_access: false, hub_tunnel_state: 'off', hub_tunnel_error: null, hub_tunnel_at: null, updated_by: userId, updated_at: new Date().toISOString() })
      .where('id', '=', true)
      .execute();
    return this.view();
  }

  /** The customer's switch: while on, the worker keeps a connection open to the hub so staff it allows can open this installation there. Off by default. */
  async setHubRemoteAccess(enabled: boolean, userId: string): Promise<BaseUrlView> {
    await platformDb(this.db)
      .updateTable('app_settings')
      .set({ hub_remote_access: enabled, ...(enabled ? {} : { hub_tunnel_state: 'off' as const, hub_tunnel_error: null }), updated_by: userId, updated_at: new Date().toISOString() })
      .where('id', '=', true)
      .where('hub_url', 'is not', null)
      .execute();
    return this.view();
  }
}
