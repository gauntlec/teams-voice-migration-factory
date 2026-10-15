import type { Kysely } from 'kysely';
import type { DB } from './schema';

/**
 * How this installation sends email. The settings saved in the app (platform.app_settings, Administration > Platform settings > Email) win;
 * when nothing has been saved there, the SMTP_* / MAIL_FROM environment values apply, exactly as they did before the settings moved into the app.
 */
export type MailMode = 'none' | 'smtp' | 'hub';

export interface MailRow {
  mail_mode: MailMode | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean | null;
  smtp_user: string | null;
  smtp_pass_enc: string | null;
  mail_from: string | null;
  mail_from_name: string | null;
  hub_url: string | null;
  hub_token_enc: string | null;
  hub_mail_relay: boolean | null;
}

export async function readMailRow(db: Kysely<DB>): Promise<MailRow> {
  const r = await db
    .withSchema('platform')
    .selectFrom('app_settings')
    .select(['mail_mode', 'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass_enc', 'mail_from', 'mail_from_name', 'hub_url', 'hub_token_enc', 'hub_mail_relay'])
    .executeTakeFirst();
  return r ?? { mail_mode: null, smtp_host: null, smtp_port: null, smtp_secure: null, smtp_user: null, smtp_pass_enc: null, mail_from: null, mail_from_name: null, hub_url: null, hub_token_enc: null, hub_mail_relay: null };
}

export interface EffectiveMail {
  mode: MailMode;
  /** Where the settings come from: saved in the app, or the environment. */
  source: 'setting' | 'environment';
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** The password as stored: encrypted when saved in the app (`passEnc`), plain when it comes from the environment (`passEnv`). */
  passEnc: string | null;
  passEnv: string | null;
  from: string;
  fromName: string;
}

export const DEFAULT_MAIL_FROM = 'no-reply@voxshift.io';
export const DEFAULT_MAIL_FROM_NAME = 'Voxshift';

export function effectiveMail(row: MailRow, env: NodeJS.ProcessEnv = process.env): EffectiveMail {
  if (row.mail_mode) {
    return {
      mode: row.mail_mode,
      source: 'setting',
      host: row.smtp_host ?? '',
      port: row.smtp_port ?? 587,
      secure: row.smtp_secure ?? false,
      user: row.smtp_user ?? '',
      passEnc: row.smtp_pass_enc,
      passEnv: null,
      from: row.mail_from ?? DEFAULT_MAIL_FROM,
      fromName: row.mail_from_name || DEFAULT_MAIL_FROM_NAME,
    };
  }
  return {
    mode: env.SMTP_HOST ? 'smtp' : 'none',
    source: 'environment',
    host: env.SMTP_HOST ?? '',
    port: Number(env.SMTP_PORT ?? 587),
    secure: (env.SMTP_SECURE ?? 'false') === 'true',
    user: env.SMTP_USER ?? '',
    passEnc: null,
    passEnv: env.SMTP_PASS ?? null,
    from: env.MAIL_FROM || DEFAULT_MAIL_FROM,
    fromName: env.MAIL_FROM_NAME || DEFAULT_MAIL_FROM_NAME,
  };
}
