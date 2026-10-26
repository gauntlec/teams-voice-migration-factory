/**
 * Incidents raised by machines and by email (docs/INTAKE.md): monitoring alerts (an SBC, Teams service health, call quality,
 * Microsoft service health) arriving at the intake endpoint, de-duplicated by a key, and the rules that turn an alert into an
 * incident. Pure: the API does the storing.
 */
import { z } from 'zod';
import { INC_CATEGORY_KEYS, INC_IMPACTS, INC_URGENCIES, type IncImpact, type IncUrgency } from './incidents';

export const INTAKE_KINDS = ['generic', 'sbc', 'teams_health', 'cqd', 'microsoft_health'] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];
export const INTAKE_KIND_LABELS: Record<IntakeKind, string> = {
  generic: 'Any monitoring tool',
  sbc: 'Session border controller',
  teams_health: 'Teams service health',
  cqd: 'Call quality (CQD) alerts',
  microsoft_health: 'Microsoft 365 service health',
};
/** The category an alert from this kind of source raises, unless the source or the alert says otherwise. */
export const INTAKE_KIND_CATEGORY: Record<IntakeKind, string> = {
  generic: 'other',
  sbc: 'direct_routing',
  teams_health: 'microsoft_service',
  cqd: 'call_quality',
  microsoft_health: 'microsoft_service',
};

export const INTAKE_SEVERITIES = ['critical', 'major', 'minor', 'info'] as const;
export type IntakeSeverity = (typeof INTAKE_SEVERITIES)[number];
export const INTAKE_SEVERITY_RANK: Record<IntakeSeverity, number> = { critical: 0, major: 1, minor: 2, info: 3 };
export const INTAKE_SEVERITY_LABELS: Record<IntakeSeverity, string> = { critical: 'Critical', major: 'Major', minor: 'Minor', info: 'Information' };

/** What each severity means for the incident's impact and urgency (and so its priority, from the customer's matrix). */
export const INTAKE_DEFAULT_SEVERITY_MAP: Record<IntakeSeverity, { impact: IncImpact; urgency: IncUrgency }> = {
  critical: { impact: 'company', urgency: 'cannot_call' },
  major: { impact: 'site', urgency: 'degraded' },
  minor: { impact: 'team', urgency: 'feature_broken' },
  info: { impact: 'individual', urgency: 'question' },
};

export interface IntakeConfig {
  /** Overrides the kind's category. */
  category?: string;
  /** The site alerts are about when they do not say. */
  siteCode?: string;
  severityMap?: Partial<Record<IntakeSeverity, { impact: IncImpact; urgency: IncUrgency }>>;
  /** When an alert clears, move its incident to Restored (instead of only noting it). */
  autoRestore?: boolean;
  /** Alerts below this severity are ignored. */
  minSeverity?: IntakeSeverity;
}

export const intakeConfigSchema = z
  .object({
    category: z.enum(INC_CATEGORY_KEYS).optional(),
    siteCode: z.string().trim().max(60).optional(),
    // partial: a customer maps only the severities it wants to change (zod 4's record over an enum would require all four)
    severityMap: z
      .partialRecord(z.enum(INTAKE_SEVERITIES), z.object({ impact: z.enum(INC_IMPACTS), urgency: z.enum(INC_URGENCIES) }).strict())
      .optional(),
    autoRestore: z.boolean().optional(),
    minSeverity: z.enum(INTAKE_SEVERITIES).optional(),
  })
  .strict();

export const INTAKE_DEFAULT_IP_ALLOW: string[] = [];

/** What a monitoring tool sends. */
export const intakeAlertSchema = z
  .object({
    /** Identifies the thing that is wrong, so repeats of the same alert are one incident ("sbc1-trunk-down"). */
    dedupKey: z.string().trim().min(1).max(200),
    title: z.string().trim().min(3).max(160),
    description: z.string().trim().max(8000).optional(),
    severity: z.enum(INTAKE_SEVERITIES).default('major'),
    state: z.enum(['firing', 'resolved']).default('firing'),
    siteCode: z.string().trim().max(60).optional(),
    category: z.enum(INC_CATEGORY_KEYS).optional(),
    /** Where to look: a dashboard or the alert in the monitoring tool. */
    link: z.string().trim().max(500).optional(),
    details: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()])).optional(),
  })
  .strict();
export type IntakeAlert = z.infer<typeof intakeAlertSchema>;

export const intakeSourceCreateSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    kind: z.enum(INTAKE_KINDS).default('generic'),
    config: intakeConfigSchema.default({}),
    ipAllow: z.array(z.string().trim().min(3).max(60)).max(20).default([]),
  })
  .strict();
export type IntakeSourceCreateInput = z.infer<typeof intakeSourceCreateSchema>;

export const intakeSourceUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    config: intakeConfigSchema.optional(),
    ipAllow: z.array(z.string().trim().min(3).max(60)).max(20).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type IntakeSourceUpdateInput = z.infer<typeof intakeSourceUpdateSchema>;

/* ------------------------------ token ------------------------------ */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TOKEN_RE = new RegExp(`^vxs_intake_(${UUID})_([A-Za-z0-9_-]{32,64})$`);
export const parseIntakeToken = (t: string) => {
  const m = TOKEN_RE.exec(t.trim());
  return m ? { sourceId: m[1]!, secret: m[2]! } : null;
};
export const formatIntakeToken = (sourceId: string, secret: string) => `vxs_intake_${sourceId}_${secret}`;
export const intakeTokenHint = (last4: string) => `vxs_intake_…${last4}`;

/* ------------------------------ mapping ------------------------------ */

const RESOLVED_STATUSES = /^(resolved|serviceRestored|falsePositive|postIncidentReviewPublished|mitigated|closed)$/i;

/**
 * A Microsoft 365 service health issue (the Graph `serviceHealthIssue` shape, as sent by Power Automate's Service Health connector
 * or a Graph subscription) as an alert. Anything that already has a `dedupKey` is taken as it is.
 */
export function normaliseIntakeBody(kind: IntakeKind, body: unknown): { ok: true; alert: IntakeAlert } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.dedupKey === 'string') {
    const r = intakeAlertSchema.safeParse(b);
    return r.success ? { ok: true, alert: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') };
  }
  if (kind === 'microsoft_health' || kind === 'teams_health') {
    const id = typeof b.id === 'string' ? b.id : null;
    if (!id) return { ok: false, error: 'Send a Microsoft service health issue (with an id) or an alert with a dedupKey.' };
    const service = typeof b.service === 'string' ? b.service : 'Microsoft 365';
    const title = typeof b.title === 'string' ? b.title : `${service} service issue`;
    const status = typeof b.status === 'string' ? b.status : '';
    const resolved = b.isResolved === true || RESOLVED_STATUSES.test(status);
    const alert = {
      dedupKey: `ms:${id}`,
      title: `${service}: ${title}`.slice(0, 160),
      description: [typeof b.impactDescription === 'string' ? b.impactDescription : '', status ? `Status: ${status}.` : ''].filter(Boolean).join('\n').slice(0, 8000) || undefined,
      severity: (b.classification === 'incident' ? 'major' : 'minor') as IntakeSeverity,
      state: (resolved ? 'resolved' : 'firing') as 'resolved' | 'firing',
      category: 'microsoft_service' as const,
      details: { service, ...(status ? { status } : {}), ...(typeof b.classification === 'string' ? { classification: b.classification } : {}) },
    };
    const r = intakeAlertSchema.safeParse(alert);
    return r.success ? { ok: true, alert: r.data } : { ok: false, error: r.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: false, error: 'Send an alert: { dedupKey, title, severity, state }.' };
}

export interface IntakeIncidentFields {
  title: string;
  description: string;
  category: string;
  impact: IncImpact;
  urgency: IncUrgency;
  siteCode: string | null;
}

/** What the incident for an alert looks like: the alert, the source's settings, and the severity map. */
export function intakeIncidentFields(kind: IntakeKind, config: IntakeConfig, alert: IntakeAlert): IntakeIncidentFields {
  const sev = { ...INTAKE_DEFAULT_SEVERITY_MAP, ...(config.severityMap ?? {}) }[alert.severity];
  const lines = [alert.description ?? '', alert.link ? `Link: ${alert.link}` : '', ...Object.entries(alert.details ?? {}).map(([k, v]) => `${k}: ${v}`)].filter(Boolean);
  return {
    title: alert.title,
    description: (lines.join('\n') || `${alert.title} (raised by monitoring).`).slice(0, 8000).padEnd(10, '.'),
    category: alert.category ?? config.category ?? INTAKE_KIND_CATEGORY[kind],
    impact: sev.impact,
    urgency: sev.urgency,
    siteCode: alert.siteCode ?? config.siteCode ?? null,
  };
}

/** Should an alert of this severity be acted on? */
export const intakeWanted = (config: IntakeConfig, severity: IntakeSeverity): boolean => !config.minSeverity || INTAKE_SEVERITY_RANK[severity] <= INTAKE_SEVERITY_RANK[config.minSeverity];

/** The dedup key as stored: namespaced by source, so two tools can use the same words without colliding. */
export const intakeDedupKey = (sourceId: string, key: string) => `${sourceId}:${key}`;

/** What the system actor is called on a timeline. */
export const INTAKE_CUSTOMER_LABEL = 'Voxshift monitoring';
