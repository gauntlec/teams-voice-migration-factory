/**
 * Safe releases and safe testing - see docs/ARCHITECTURE.md "Operations".
 *
 * - Release check: what a release (worker restart) would interrupt right now.
 * - Maintenance notice: a SUPER_ADMIN announces an update time; staff see a
 *   banner, and new live work is refused in the final minutes before it.
 * - Test customers (`platform.tenants.sandbox`): every email for that customer
 *   goes to the person who caused it instead of the real recipient.
 */
import { z } from 'zod';

/* ------------------------------ release check ----------------------------- */

/** A customer-tenant sign-in (device code) that a worker restart would end. */
export interface ReleaseCheckConnection {
  tenantId: string;
  tenantName: string;
  id: string;
  status: 'pending' | 'active';
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  /** the Microsoft account signed in, once active */
  upn: string | null;
  startedAt: string;
}

/** A queued/running discovery run (a full sync, or a Design & Build Validate check). */
export interface ReleaseCheckDiscoveryRun {
  tenantId: string;
  tenantName: string;
  id: string;
  status: 'queued' | 'running';
  kind: 'sync' | 'targeted';
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  startedAt: string;
}

/** A queued/running deployment run (What-If or live Execute). */
export interface ReleaseCheckDeployment {
  tenantId: string;
  tenantName: string;
  id: string;
  status: 'queued' | 'running';
  mode: 'dry_run' | 'execute';
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  startedAt: string;
}

export interface ReleaseCheckItems {
  connections: ReleaseCheckConnection[];
  discoveryRuns: ReleaseCheckDiscoveryRun[];
  deployments: ReleaseCheckDeployment[];
}

/** `GET /platform/release-check`. */
export interface ReleaseCheck extends ReleaseCheckItems {
  checkedAt: string;
  /** true when nothing above is in progress - a release interrupts no one */
  safe: boolean;
  /** connections + discovery runs + deployments */
  total: number;
  /** one line for the card: "Safe to release" / "3 things in progress: ..." */
  headline: string;
  maintenance: MaintenanceNoticeView | null;
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Counts + headline for a release check. Pure, so the wording is unit-tested. */
export function summarizeReleaseCheck(items: ReleaseCheckItems): Pick<ReleaseCheck, 'safe' | 'total' | 'headline'> {
  const live = items.deployments.filter((d) => d.mode === 'execute').length;
  const total = items.connections.length + items.discoveryRuns.length + items.deployments.length;
  if (total === 0) return { safe: true, total, headline: 'Safe to release - nothing is in progress.' };
  const parts: string[] = [];
  if (items.deployments.length) {
    parts.push(`${plural(items.deployments.length, 'deployment run')}${live ? ` (${live} live)` : ''}`);
  }
  if (items.discoveryRuns.length) parts.push(plural(items.discoveryRuns.length, 'discovery run'));
  if (items.connections.length) parts.push(plural(items.connections.length, 'customer-tenant sign-in'));
  return { safe: false, total, headline: `${plural(total, 'thing')} in progress: ${parts.join(', ')}.` };
}

/* --------------------------- maintenance notice --------------------------- */

/** New live deployments, discovery runs and sign-ins are refused this long before the update. */
export const MAINTENANCE_FREEZE_MINUTES = 10;
/** A notice nobody cleared stops showing (and stops blocking) this long after its time. */
export const MAINTENANCE_LAPSE_MINUTES = 30;

/** `platform.maintenance_notice` as the API returns it. */
export interface MaintenanceNotice {
  message: string;
  /** when the update is planned (ISO) */
  startsAt: string;
  createdByName: string | null;
  createdAt: string;
}

/**
 * - `scheduled`: before the freeze - banner only.
 * - `freeze`: within MAINTENANCE_FREEZE_MINUTES of the time, or the time has
 *   passed but the notice hasn't lapsed - new live work is refused.
 * - `lapsed`: more than MAINTENANCE_LAPSE_MINUTES past its time - ignored.
 */
export type MaintenancePhase = 'scheduled' | 'freeze' | 'lapsed';

export interface MaintenanceNoticeView extends MaintenanceNotice {
  phase: MaintenancePhase;
  /** whole minutes until startsAt; 0 or less once it's due */
  minutesUntil: number;
}

export function maintenancePhase(startsAt: string, now: Date = new Date()): MaintenancePhase {
  const ms = Date.parse(startsAt) - now.getTime();
  if (ms < -MAINTENANCE_LAPSE_MINUTES * 60_000) return 'lapsed';
  if (ms <= MAINTENANCE_FREEZE_MINUTES * 60_000) return 'freeze';
  return 'scheduled';
}

/** Adds phase + countdown; null when there's no notice or it has lapsed. */
export function viewMaintenanceNotice(notice: MaintenanceNotice | null, now: Date = new Date()): MaintenanceNoticeView | null {
  if (!notice) return null;
  const phase = maintenancePhase(notice.startsAt, now);
  if (phase === 'lapsed') return null;
  return { ...notice, phase, minutesUntil: Math.ceil((Date.parse(notice.startsAt) - now.getTime()) / 60_000) };
}

/**
 * The error a refused start shows. `what` completes "starting a new ___", e.g.
 * "live deployment" / "discovery run" / "customer-tenant sign-in".
 */
export function maintenanceFreezeMessage(view: MaintenanceNoticeView, what: string): string {
  const when =
    view.minutesUntil > 0 ? `in ${plural(view.minutesUntil, 'minute')}` : 'now';
  return (
    `A platform update is due ${when}, and it will end every live customer-tenant session. ` +
    `Starting a new ${what} is paused until the update is done - try again once the maintenance notice has gone. ` +
    `Notice: "${view.message}"`
  );
}

export const setMaintenanceNoticeSchema = z
  .object({
    message: z.string().trim().min(1, 'Enter a message').max(300),
    startsAt: z
      .string()
      .refine((s) => !Number.isNaN(Date.parse(s)), 'Enter a valid date and time'),
  })
  .strict();
export type SetMaintenanceNoticeInput = z.infer<typeof setMaintenanceNoticeSchema>;

/* ------------------------------ test customers ---------------------------- */

export const updateTenantSandboxSchema = z
  .object({
    sandbox: z.boolean(),
    /** where an email goes when nobody triggered it (reminders, sweeps); null = such emails aren't sent */
    sandboxEmail: z.string().trim().email('Enter an email address').max(320).nullable().optional(),
  })
  .strict();
export type UpdateTenantSandboxInput = z.infer<typeof updateTenantSandboxSchema>;

export type SandboxRedirect =
  | { action: 'redirect'; to: string; toName: string | null; subjectPrefix: string }
  | { action: 'skip'; reason: string };

export function sandboxSubjectPrefix(originalTo: string): string {
  return `[TEST - would have gone to ${originalTo}]`;
}

/**
 * Where an email for a test customer goes instead of its real recipient:
 * the person who triggered it (`email_messages.created_by`), else the
 * customer's fallback address, else nowhere (logged as skipped).
 */
export function sandboxRedirect(input: {
  originalTo: string;
  triggeredBy: { email: string; name: string | null } | null;
  fallbackEmail: string | null;
}): SandboxRedirect {
  const subjectPrefix = sandboxSubjectPrefix(input.originalTo);
  if (input.triggeredBy?.email) {
    return { action: 'redirect', to: input.triggeredBy.email, toName: input.triggeredBy.name, subjectPrefix };
  }
  if (input.fallbackEmail) return { action: 'redirect', to: input.fallbackEmail, toName: null, subjectPrefix };
  return {
    action: 'skip',
    reason:
      'Test customer - nobody triggered this email and no fallback address is set, so it was not sent (Customers page -> Test customer).',
  };
}
