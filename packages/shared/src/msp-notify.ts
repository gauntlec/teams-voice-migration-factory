/**
 * Telling an MSP's Microsoft Teams channel about what matters (docs/INTAKE.md): a P1 or P2 raised, a major incident declared or
 * over, a target missed. A channel is reached through a Teams "Workflows" webhook URL, a secret: it is stored encrypted, shown to
 * nobody, and only ever posted to if it is a genuine Microsoft webhook address. Pure: the cards and the rules; the API queues them and the
 * worker posts them.
 */
import { z } from 'zod';

export const MSP_NOTIFY_KINDS = ['incident', 'major', 'sla', 'test'] as const;
export type MspNotifyKind = (typeof MSP_NOTIFY_KINDS)[number];

export interface MspNotifyConfig {
  /** A P1 or P2 incident is raised. */
  incidents: boolean;
  /** A major incident is declared or ends. */
  major: boolean;
  /** A response or resolution target is missed. */
  sla: boolean;
}
export const MSP_NOTIFY_DEFAULTS: MspNotifyConfig = { incidents: true, major: true, sla: true };

export const mspTeamsSchema = z
  .object({
    /** The Workflows webhook URL. Send null to remove it; leave out to keep the one stored. */
    webhookUrl: z.string().trim().max(2000).nullable().optional(),
    notify: z.object({ incidents: z.boolean(), major: z.boolean(), sla: z.boolean() }).strict().optional(),
  })
  .strict();
export type MspTeamsInput = z.infer<typeof mspTeamsSchema>;

/** Hosts a Teams webhook lives on. Anything else is refused, so a Super Admin's typo (or worse) cannot point us at an internal address. */
const HOST_SUFFIXES = ['.webhook.office.com', '.logic.azure.com', '.api.powerplatform.com', '.powerplatform.com', '.environment.api.powerplatform.com'];
const HOSTS = ['outlook.office.com', 'outlook.office365.com'];

export function isTeamsWebhookUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase();
  return HOSTS.includes(host) || HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

export interface MspNotifyCard {
  title: string;
  body?: string;
  facts?: { title: string; value: string }[];
  link?: { label: string; url: string };
  /** Teams shows a coloured bar for these. */
  tone?: 'attention' | 'warning' | 'good' | 'default';
}

/** The message a Teams Workflows webhook takes: an Adaptive Card in an attachment. */
export function teamsPayload(c: MspNotifyCard) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: c.title.slice(0, 200), weight: 'Bolder', size: 'Medium', wrap: true, color: c.tone ?? 'default' },
            ...(c.body ? [{ type: 'TextBlock', text: c.body.slice(0, 1500), wrap: true }] : []),
            ...(c.facts?.length ? [{ type: 'FactSet', facts: c.facts.slice(0, 8).map((f) => ({ title: f.title, value: f.value.slice(0, 200) })) }] : []),
          ],
          ...(c.link ? { actions: [{ type: 'Action.OpenUrl', title: c.link.label.slice(0, 60), url: c.link.url }] } : {}),
        },
      },
    ],
  };
}

export const mspNotifyEnabled = (config: Partial<MspNotifyConfig> | null | undefined, kind: MspNotifyKind): boolean => {
  if (kind === 'test') return true;
  const c = { ...MSP_NOTIFY_DEFAULTS, ...(config ?? {}) };
  return kind === 'incident' ? c.incidents : kind === 'major' ? c.major : c.sla;
};

/** Failed posts are retried, then given up on. */
export const MSP_NOTIFY_MAX_ATTEMPTS = 6;
export const mspNotifyBackoffSeconds = (attempts: number) => Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
