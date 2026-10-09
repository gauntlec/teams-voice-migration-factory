/**
 * Managed Services: response and resolution targets, and the per-customer
 * service request settings they live in.
 *
 * Targets are in calendar hours (not business hours), per priority:
 *  - response:   raised -> the team's first reply, question or move
 *  - resolution: raised -> Deployed (or Declined / Cancelled)
 * Time spent waiting on the customer is left out of both (the clock stops).
 * A request about to miss a target (SR_SLA_WARN_FRACTION of the target left)
 * and one that has missed it each email the team once (worker sweep).
 */
import { z } from 'zod';
import { SR_PRIORITIES, SR_TYPES, type SrPriority, type SrStatus, type SrType } from './service-requests';

export interface SrSlaTarget {
  responseHours: number;
  resolveHours: number;
}
export type SrSlaTargets = Record<SrPriority, SrSlaTarget>;

/** Used for every customer until a Super Admin sets their own. */
export const SR_DEFAULT_TARGETS: SrSlaTargets = {
  urgent: { responseHours: 1, resolveHours: 8 },
  high: { responseHours: 4, resolveHours: 24 },
  normal: { responseHours: 8, resolveHours: 72 },
  low: { responseHours: 24, resolveHours: 120 },
};

/** Warn when this share of a target is left. */
export const SR_SLA_WARN_FRACTION = 0.2;

/** A recurring change window, e.g. weekdays 18:00-22:00 Europe/London. Live deploys outside it need an override. */
export interface SrChangeWindow {
  /** 0 = Sunday ... 6 = Saturday */
  days: number[];
  /** "HH:mm" 24h, start < end (no windows across midnight). */
  start: string;
  end: string;
  /** IANA time zone, e.g. Europe/London */
  timeZone: string;
}

/** Per-customer Managed Services settings (platform.tenants.sr_settings). Everything is optional. */
export interface SrSettings {
  targets?: Partial<SrSlaTargets>;
  /** Phase 4: request types that need a customer approver before the team starts, and who can approve. */
  approval?: { types: SrType[]; approverIds: string[] };
  /** Phase 4: when live changes may be deployed. */
  changeWindow?: SrChangeWindow | null;
}

const targetSchema = z
  .object({
    responseHours: z.number().positive().max(24 * 30),
    resolveHours: z.number().positive().max(24 * 90),
  })
  .strict()
  .refine((t) => t.resolveHours >= t.responseHours, 'The resolution target must be at least the response target');

export const srTargetsSchema = z
  .object(Object.fromEntries(SR_PRIORITIES.map((p) => [p, targetSchema.optional()])) as Record<SrPriority, z.ZodOptional<typeof targetSchema>>)
  .strict();

/** Fills in defaults for any priority a customer hasn't set. */
export function srEffectiveTargets(settings: SrSettings | null | undefined): SrSlaTargets {
  const out = { ...SR_DEFAULT_TARGETS };
  for (const p of SR_PRIORITIES) {
    const t = settings?.targets?.[p];
    if (t) out[p] = t;
  }
  return out;
}

export type SrClockState = 'met' | 'missed' | 'on_track' | 'at_risk' | 'overdue' | 'paused' | 'stopped';

export interface SrClock {
  state: SrClockState;
  /** When the target falls due, given the waiting so far (ISO). Null once met/missed. */
  dueAt: string | null;
  /** Milliseconds left (negative = overdue). Null when finished or paused. */
  leftMs: number | null;
}

export interface SrSlaInput {
  priority: SrPriority;
  status: SrStatus;
  created_at: string | Date;
  first_response_at: string | Date | null;
  deployed_at: string | Date | null;
  declined_at?: string | Date | null;
  cancelled_at?: string | Date | null;
  waiting_since: string | Date | null;
  waiting_seconds: number;
  /** A reopened request's resolution clock restarts from here. */
  reopened_at?: string | Date | null;
}

const ms = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : null);

/**
 * Where a request stands against its targets right now. Cancelled requests
 * stop both clocks ("stopped"); a request waiting on the customer is "paused"
 * (its due time moves out by the time spent waiting).
 */
export function srSla(r: SrSlaInput, targets: SrSlaTargets, now = Date.now()): { response: SrClock; resolution: SrClock } {
  const t = targets[r.priority] ?? SR_DEFAULT_TARGETS.normal;
  const created = ms(r.created_at)!;
  const waitingNow = r.waiting_since ? Math.max(0, now - ms(r.waiting_since)!) : 0;
  const pausedMs = r.waiting_seconds * 1000 + waitingNow;

  const clock = (hours: number, doneAt: number | null, start = created): SrClock => {
    if (r.status === 'cancelled') return { state: 'stopped', dueAt: null, leftMs: null };
    const due = start + hours * 3_600_000 + pausedMs;
    if (doneAt !== null) return { state: doneAt <= due ? 'met' : 'missed', dueAt: null, leftMs: null };
    if (r.waiting_since) return { state: 'paused', dueAt: new Date(due).toISOString(), leftMs: null };
    const left = due - now;
    const state: SrClockState = left < 0 ? 'overdue' : left <= hours * 3_600_000 * SR_SLA_WARN_FRACTION ? 'at_risk' : 'on_track';
    return { state, dueAt: new Date(due).toISOString(), leftMs: left };
  };

  const resolvedAt = r.status === 'deployed' ? ms(r.deployed_at) : r.status === 'declined' ? ms(r.declined_at) : null;
  return {
    response: clock(t.responseHours, ms(r.first_response_at) ?? (r.status === 'declined' ? ms(r.declined_at) : null)),
    resolution: clock(t.resolveHours, resolvedAt, ms(r.reopened_at) ?? created),
  };
}

/** The clock that matters now: response until there's been one, then resolution. */
export function srNextClock(sla: { response: SrClock; resolution: SrClock }): { which: 'response' | 'resolution'; clock: SrClock } {
  const open = (c: SrClock) => c.state === 'on_track' || c.state === 'at_risk' || c.state === 'overdue' || c.state === 'paused';
  if (open(sla.response)) return { which: 'response', clock: sla.response };
  return { which: 'resolution', clock: sla.resolution };
}

/** Whether `now` falls inside a change window (in the window's own time zone). No window = always inside. */
export function srInChangeWindow(w: SrChangeWindow | null | undefined, now = new Date()): boolean {
  if (!w) return true;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: w.timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const hhmm = `${get('hour')}:${get('minute')}`;
  return w.days.includes(day) && hhmm >= w.start && hhmm < w.end;
}

/** "Mon-Fri 18:00-22:00 (Europe/London)" */
export function srChangeWindowText(w: SrChangeWindow): string {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = [...w.days].sort();
  const contiguous = days.length > 2 && days.every((d, i) => i === 0 || d === days[i - 1]! + 1);
  const dayText = contiguous ? `${names[days[0]!]}-${names[days[days.length - 1]!]}` : days.map((d) => names[d]).join(', ');
  return `${dayText} ${w.start}-${w.end} (${w.timeZone})`;
}

/** "2h 5m", "3d 4h" - for due-in / overdue-by text. */
export function srDuration(msLeft: number): string {
  const m = Math.max(0, Math.round(Math.abs(msLeft) / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${mm}m`;
  return `${mm}m`;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** PUT /service-requests/settings - Super Admins only. */
export const serviceRequestSettingsSchema = z
  .object({
    targets: srTargetsSchema.optional(),
    approval: z
      .object({
        types: z.array(z.enum(SR_TYPES)).max(SR_TYPES.length),
        approverIds: z.array(z.string().uuid()).max(20),
      })
      .strict()
      .refine((a) => a.types.length === 0 || a.approverIds.length > 0, 'Choose at least one approver')
      .optional(),
    changeWindow: z
      .object({
        days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
        start: z.string().regex(HHMM, 'Use HH:mm'),
        end: z.string().regex(HHMM, 'Use HH:mm'),
        timeZone: z.string().min(1).max(64).refine((tz) => {
          try {
            new Intl.DateTimeFormat('en', { timeZone: tz });
            return true;
          } catch {
            return false;
          }
        }, 'Unknown time zone'),
      })
      .strict()
      .refine((w) => w.start < w.end, 'The window must end after it starts (on the same day)')
      .nullable()
      .optional(),
  })
  .strict();
export type ServiceRequestSettingsInput = z.infer<typeof serviceRequestSettingsSchema>;

/** GET /service-requests/report?from=&to= (ISO dates; `to` exclusive). */
export const serviceRequestReportQuerySchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  })
  .strict();
export type ServiceRequestReportQuery = z.infer<typeof serviceRequestReportQuerySchema>;
