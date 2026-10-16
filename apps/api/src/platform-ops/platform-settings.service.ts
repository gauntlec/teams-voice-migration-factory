import { ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { disabledFeatures, effectiveMail, emailEnabled, forgetAppSettings, platformDb, readMailRow, savedBaseUrl } from '@tvmf/db';
import { baseUrlWarnings, connectDetails, MAIL_MODE_LABELS, type BaseUrlView, type HubConnectionView, type MailSettingsView, type PlatformFeature, type SetMailSettingsInput } from '@tvmf/shared';
import { APP_CONFIG, type AppConfig } from '../common/config';
import { encryptSecret } from '../common/crypto';
import { InjectDb, type Db } from '../db/db.module';
import { MailService } from '../mail/mail.service';

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
    private readonly mail: MailService,
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
      mail: await this.mailView(),
      disabledFeatures: (await disabledFeatures(this.db, { fresh: true })) as PlatformFeature[],
      version: (process.env.APP_VERSION ?? '').trim() || 'dev',
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

  /** How this installation sends email: what is saved in the app, else the SMTP_* environment values. The password is never returned, only whether one is set. */
  async mailView(): Promise<MailSettingsView> {
    const row = await readMailRow(this.db);
    const m = effectiveMail(row);
    return {
      mode: m.mode,
      source: m.source,
      smtp: { host: m.host, port: m.port, secure: m.secure, user: m.user, passwordSet: !!(m.passEnc ?? m.passEnv), from: m.from, fromName: m.fromName },
      hubFromName: m.fromName,
      hub: { connected: !!row.hub_url && !!row.hub_token_enc, available: row.hub_mail_relay },
    };
  }

  /** Saves how email is sent. Changing from the environment values keeps their password unless a new one is given. */
  async setMail(input: SetMailSettingsInput, userId: string): Promise<BaseUrlView> {
    const row = await readMailRow(this.db);
    const current = effectiveMail(row);
    let values: Record<string, unknown>;
    if (input.mode === 'none') values = { mail_mode: 'none' };
    else if (input.mode === 'hub') values = { mail_mode: 'hub', mail_from_name: input.fromName || 'Voxshift' };
    else {
      const s = input.smtp;
      let pass: string | null;
      if (s.password === undefined) pass = row.smtp_pass_enc ?? (current.passEnv ? encryptSecret(current.passEnv) : null);
      else pass = s.password === '' ? null : encryptSecret(s.password);
      values = { mail_mode: 'smtp', smtp_host: s.host, smtp_port: s.port, smtp_secure: s.secure, smtp_user: s.user || null, smtp_pass_enc: pass, mail_from: s.from, mail_from_name: s.fromName || 'Voxshift' };
    }
    await platformDb(this.db)
      .insertInto('app_settings')
      .values({ id: true, base_url: null, ...values, updated_by: userId } as never)
      .onConflict((oc) => oc.column('id').doUpdateSet({ ...values, updated_by: userId, updated_at: new Date().toISOString() } as never))
      .execute();
    return this.view();
  }

  /** Queues a test message the normal way (the worker sends it as set up), so it proves the real path. Poll `mailTestStatus` for the result. */
  async testMail(to: string): Promise<{ id: string }> {
    if (!(await emailEnabled(this.db, { fresh: true }))) throw new ConflictException('Email is switched off for the whole platform (the switch above). Switch it on to send a test.');
    const m = await this.mailView();
    if (m.mode === 'none') throw new ConflictException('Email is not set up. Choose how it is sent and save first.');
    const how = m.mode === 'hub' ? 'through the Voxshift Hub\'s mail service' : `through ${m.smtp.host}`;
    const r = await this.mail.enqueue({ template: 'mail_test', to: { email: to }, context: { installation: this.cfg.WEB_ORIGIN, how, sentAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC' }, related: { type: 'mail_test', id: to } });
    if (!r.id) throw new ConflictException('Email is switched off for the whole platform.');
    return { id: r.id };
  }

  async mailTestStatus(id: string): Promise<{ status: string; error: string | null }> {
    const r = await platformDb(this.db).selectFrom('email_messages').select(['status', 'error']).where('id', '=', id).where('template', '=', 'mail_test').executeTakeFirst();
    if (!r) throw new NotFoundException('No such test message.');
    return { status: r.status, error: r.error };
  }

  /** Switches optional areas off (or back on). Takes effect at once: menus on the next page load, the API immediately. */
  async setDisabledFeatures(disabled: PlatformFeature[], userId: string): Promise<BaseUrlView> {
    const list = [...new Set(disabled)];
    await platformDb(this.db)
      .insertInto('app_settings')
      .values({ id: true, base_url: null, disabled_features: list, updated_by: userId })
      .onConflict((oc) => oc.column('id').doUpdateSet({ disabled_features: list, updated_by: userId, updated_at: new Date().toISOString() }))
      .execute();
    forgetAppSettings();
    return this.view();
  }
}
