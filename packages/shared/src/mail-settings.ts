/**
 * Email settings kept in the app (Administration > Platform settings > Email). An installation sends mail in one of three ways:
 *   none = nothing is sent;  smtp = through a mail server of its own;  hub = through the mail service of the Voxshift Hub it is connected to.
 */
import { z } from 'zod';

export const MAIL_MODES = ['none', 'smtp', 'hub'] as const;
export type MailModeSetting = (typeof MAIL_MODES)[number];
export const MAIL_MODE_LABELS: Record<MailModeSetting, string> = {
  none: 'Not set up (no email is sent)',
  smtp: 'This installation\'s own mail server',
  hub: 'Through the Voxshift Hub',
};

const fromNameSchema = z.string().trim().max(80);

export const smtpSettingsSchema = z
  .object({
    host: z.string().trim().min(1, 'Enter the mail server name').max(253),
    port: z.number().int().min(1).max(65535).default(587),
    /** true = the connection is encrypted from the start (port 465); false = STARTTLS (587), which is always required. */
    secure: z.boolean().default(false),
    user: z.string().trim().max(254).default(''),
    /** Left out = keep the saved password; an empty string = remove it. */
    password: z.string().max(500).optional(),
    from: z.string().trim().email('Enter the address mail is sent from').max(254),
    fromName: fromNameSchema.default('Voxshift'),
  })
  .strict();
export type SmtpSettingsInput = z.infer<typeof smtpSettingsSchema>;

export const setMailSettingsSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('hub'), fromName: fromNameSchema.default('Voxshift') }).strict(),
  z.object({ mode: z.literal('smtp'), smtp: smtpSettingsSchema }).strict(),
]);
export type SetMailSettingsInput = z.infer<typeof setMailSettingsSchema>;

export const mailTestSchema = z.object({ to: z.string().trim().email('Enter an email address').max(254) }).strict();
export type MailTestInput = z.infer<typeof mailTestSchema>;

export interface MailSettingsView {
  /** How mail is sent now. */
  mode: MailModeSetting;
  /** Where that comes from: saved in the app, or the SMTP_* environment values of the installation. */
  source: 'setting' | 'environment';
  smtp: { host: string; port: number; secure: boolean; user: string; passwordSet: boolean; from: string; fromName: string };
  /** The name mail shows as sender when it goes through the hub. */
  hubFromName: string;
  hub: {
    /** Is this installation connected to a hub? (Needed for the hub option.) */
    connected: boolean;
    /** What the hub last said about its mail service for this installation: true = ready, false = not available, null = not heard yet. */
    available: boolean | null;
  };
}

/** What the worker sends a hub's mail service. The hub decides the From address; this only suggests the name shown with it. */
export interface HubMailRequest {
  to: string;
  toName?: string | null;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
  fromName?: string;
}

/** A person-readable reason for a refused or failed relay through the hub. Never includes the token. */
export function hubMailErrorText(status: number | null, code?: string, detail?: string): string {
  if (status === 401) return 'The hub does not accept this installation\'s token. Copy a fresh one from the hub and connect again.';
  if (status === 403) return code === 'relay_disabled' ? 'The hub\'s mail service is switched off for this installation.' : 'This installation is switched off in the hub.';
  if (status === 429) return 'The hub is limiting how much mail this installation sends. It will be tried again.';
  if (status === 503) return 'The hub\'s mail service is not set up yet.';
  if (status === 400) return `The hub refused the message${detail ? `: ${detail}` : ''}.`;
  if (status !== null) return `The hub could not send the message (${status})${detail ? `: ${detail}` : ''}.`;
  return `Could not reach the hub${detail ? `: ${detail}` : ''}.`;
}
