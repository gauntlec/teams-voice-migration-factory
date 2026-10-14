/**
 * Incident management for a Teams Voice managed service: something that worked
 * has stopped working, or is working badly. Planned changes are Service
 * Requests (service-requests.ts); this is the unplanned side.
 *
 * Everything here is pure (no database, no clock unless passed in) so the API,
 * the worker, the web form and AI agents all read the same rules:
 *  - categories and the questions each one asks (INC_CATEGORIES)
 *  - priority = impact x urgency (incPriority)
 *  - status moves (incMoveKind) and who may make them
 *  - response / restoration / resolution clocks, paused while on hold (incSla)
 *  - the DTOs the API validates with
 * See docs/INCIDENT-MANAGEMENT.md.
 */
import { z } from 'zod';
import type { SrFieldSpec } from './service-requests';

/* ------------------------------ impact, urgency, priority ------------------------------ */

export const INC_IMPACTS = ['individual', 'team', 'site', 'company'] as const;
export type IncImpact = (typeof INC_IMPACTS)[number];
export const INC_IMPACT_LABELS: Record<IncImpact, string> = {
  individual: 'Just me, or one person',
  team: 'A team or several people',
  site: 'A whole site',
  company: 'The whole company',
};

export const INC_URGENCIES = ['cannot_call', 'degraded', 'feature_broken', 'question'] as const;
export type IncUrgency = (typeof INC_URGENCIES)[number];
export const INC_URGENCY_LABELS: Record<IncUrgency, string> = {
  cannot_call: 'Cannot make or receive calls',
  degraded: 'Calls work, but badly (quality or wrong routing)',
  feature_broken: 'A feature is broken (voicemail, forwarding, menus)',
  question: 'A question or minor problem',
};

export const INC_PRIORITIES = ['p1', 'p2', 'p3', 'p4'] as const;
export type IncPriority = (typeof INC_PRIORITIES)[number];
export const INC_PRIORITY_LABELS: Record<IncPriority, string> = {
  p1: 'P1 Critical',
  p2: 'P2 High',
  p3: 'P3 Medium',
  p4: 'P4 Low',
};
/** The words a customer sees, e.g. "We'll treat this as high priority". */
export const INC_PRIORITY_CUSTOMER_TEXT: Record<IncPriority, string> = {
  p1: 'critical',
  p2: 'high',
  p3: 'medium',
  p4: 'low',
};

export type IncMatrix = Record<IncImpact, Record<IncUrgency, IncPriority>>;

/** Used for every customer until a Super Admin sets their own. Columns follow INC_URGENCIES. */
export const INC_DEFAULT_MATRIX: IncMatrix = {
  company: { cannot_call: 'p1', degraded: 'p2', feature_broken: 'p3', question: 'p4' },
  site: { cannot_call: 'p1', degraded: 'p2', feature_broken: 'p3', question: 'p4' },
  team: { cannot_call: 'p2', degraded: 'p3', feature_broken: 'p3', question: 'p4' },
  individual: { cannot_call: 'p3', degraded: 'p3', feature_broken: 'p4', question: 'p4' },
};

/** Fills in the customer's own matrix over the default. */
export function incEffectiveMatrix(settings: IncSettings | null | undefined): IncMatrix {
  const out = {} as IncMatrix;
  for (const i of INC_IMPACTS) out[i] = { ...INC_DEFAULT_MATRIX[i], ...(settings?.matrix?.[i] ?? {}) };
  return out;
}

/**
 * Priority from impact x urgency. An emergency calling category is always P1
 * whatever the customer picked.
 */
export function incPriority(
  impact: IncImpact,
  urgency: IncUrgency,
  category?: string | null,
  matrix: IncMatrix = INC_DEFAULT_MATRIX,
): { priority: IncPriority; reason: 'matrix' | 'emergency' } {
  if (category && INC_CATEGORY_BY_KEY[category]?.forcePriority) {
    return { priority: INC_CATEGORY_BY_KEY[category]!.forcePriority!, reason: 'emergency' };
  }
  return { priority: matrix[impact][urgency], reason: 'matrix' };
}

/* ------------------------------ categories ------------------------------ */

export type IncSkill = 'voice' | 'sbc' | 'numbers' | 'platform' | 'general';

export interface IncSubcategory {
  key: string;
  label: string;
}

export interface IncCategoryDef {
  key: string;
  label: string;
  /** Plain-language help shown under the choice. */
  help: string;
  subcategories: readonly IncSubcategory[];
  /** The category's own questions (same field specs as service requests). */
  questions: readonly SrFieldSpec[];
  /** false: a customer-wide problem is fine (SBC, Microsoft, Voxshift, other). */
  siteRequired: boolean;
  /** Skill group the incident routes to; agent runbooks key off it too. */
  skill: IncSkill;
  /** Priority this category always gets, whatever the matrix says. */
  forcePriority?: IncPriority;
  /** Shown above the form: a warning the customer must see before raising it. */
  warning?: string;
}

const WHEN: SrFieldSpec = { key: 'started', label: 'When did it start?', kind: 'text', required: true, max: 120, hint: 'Date and time, with time zone if it is not obvious' };
const ERROR_TEXT: SrFieldSpec = { key: 'error_message', label: 'Any error or message shown or heard', kind: 'text', max: 300 };
const AFFECTED: SrFieldSpec = { key: 'affected_user', label: 'Which person or people', kind: 'text', required: true, max: 300, hint: 'Name or sign-in address; list several if needed' };
const RECENT_CHANGE: SrFieldSpec = { key: 'recent_change', label: 'Has anything changed recently (phones, network, numbers, policies)?', kind: 'boolean' };

export const INC_CATEGORIES: readonly IncCategoryDef[] = [
  {
    key: 'call_failure',
    label: 'Calls are failing or going to the wrong place',
    help: 'Cannot make or receive calls, busy tone, calls dropping, calls reaching the wrong person.',
    skill: 'voice',
    siteRequired: true,
    subcategories: [
      { key: 'outbound_fail', label: "Can't make outbound calls" },
      { key: 'inbound_fail', label: "Can't receive inbound calls" },
      { key: 'wrong_destination', label: 'Calls go to the wrong place' },
      { key: 'busy_or_not_in_service', label: 'Busy tone or "number not in service"' },
      { key: 'international_blocked', label: 'International or premium numbers blocked' },
      { key: 'calls_drop', label: 'Calls drop mid-call' },
    ],
    questions: [
      { key: 'direction', label: 'Which calls are affected', kind: 'select', required: true, options: ['Outbound calls', 'Inbound calls', 'Both', 'Internal calls only'] },
      { key: 'what_happens', label: 'What happens', kind: 'select', options: ['Busy tone', 'Fast busy or reorder tone', 'Number not in service message', 'Rings but no answer', 'Wrong person or place answers', 'Call drops', 'Silence', 'Not sure'] },
      { key: 'numbers_affected', label: 'Numbers that cannot be reached (or cannot reach you)', kind: 'text', max: 300, hint: 'e.g. all mobiles, international, one number' },
      WHEN,
      RECENT_CHANGE,
    ],
  },
  {
    key: 'call_quality',
    label: 'Call quality: choppy, one-way or no audio, echo',
    help: 'Calls connect but the audio is poor.',
    skill: 'voice',
    siteRequired: true,
    subcategories: [
      { key: 'choppy_audio', label: 'Choppy or robotic audio' },
      { key: 'one_way_audio', label: 'One-way or no audio' },
      { key: 'echo', label: 'Echo or feedback' },
      { key: 'latency', label: 'Delay on the line' },
      { key: 'remote_only', label: 'Only when working remotely or on wifi' },
    ],
    questions: [
      { key: 'where', label: 'Where are the affected people', kind: 'select', required: true, options: ['In the office on wifi', 'In the office, wired', 'Working from home', 'On mobile data', 'Everywhere'] },
      { key: 'device', label: 'What are they using', kind: 'select', options: ['Teams desktop app', 'Teams mobile app', 'Desk phone', 'Headset', 'Common area phone', 'Not sure'] },
      { key: 'how_often', label: 'How often', kind: 'select', required: true, options: ['Every call', 'Most calls', 'Some calls', 'Only at certain times'] },
      WHEN,
    ],
  },
  {
    key: 'emergency',
    label: 'Emergency calling',
    help: 'Emergency calls failing, or the wrong location or callback number being sent.',
    skill: 'voice',
    siteRequired: true,
    forcePriority: 'p1',
    warning: 'If anyone is in danger right now, use another phone to call the emergency services before you raise this.',
    subcategories: [
      { key: 'call_failed', label: 'An emergency call failed' },
      { key: 'wrong_location', label: 'The wrong location was sent' },
      { key: 'wrong_callback', label: 'The wrong callback number was sent' },
      { key: 'notification_missing', label: 'Security desk notification not received' },
      { key: 'lbr', label: 'Location-based routing problem' },
    ],
    questions: [
      { key: 'what_happened', label: 'What happened', kind: 'textarea', required: true, max: 1500 },
      { key: 'call_attempted', label: 'Was an emergency call actually attempted?', kind: 'boolean', required: true },
      { key: 'caller_location', label: 'Where was the caller (address, floor)', kind: 'text', max: 300 },
      WHEN,
    ],
  },
  {
    key: 'direct_routing',
    label: 'Direct Routing, SBC or carrier',
    help: 'Session border controller, certificates, carrier trunks and capacity.',
    skill: 'sbc',
    siteRequired: false,
    subcategories: [
      { key: 'sbc_offline', label: 'SBC offline or not responding' },
      { key: 'certificate', label: 'Certificate expired or about to expire' },
      { key: 'trunk_down', label: 'Carrier trunk down' },
      { key: 'capacity', label: 'Out of call capacity (channels)' },
      { key: 'media_tls', label: 'Media bypass or TLS problem' },
      { key: 'sbc_config', label: 'SBC firmware or configuration' },
    ],
    questions: [
      { key: 'which', label: 'Which SBC, carrier or trunk (if you know)', kind: 'text', max: 300 },
      { key: 'symptom', label: 'What are you seeing', kind: 'choices', required: true, options: ['All calls failing', 'Some calls failing', 'Certificate warning', 'Busy or out of capacity', 'Audio problems on external calls'] },
      WHEN,
    ],
  },
  {
    key: 'numbers',
    label: 'Phone numbers and porting',
    help: 'A number is not working, shows the wrong caller ID, or a port is delayed.',
    skill: 'numbers',
    siteRequired: true,
    subcategories: [
      { key: 'number_not_working', label: 'A number is not working' },
      { key: 'caller_id', label: 'Wrong caller ID shown' },
      { key: 'port_issue', label: 'Port delayed or failed' },
      { key: 'wrong_assignment', label: 'Number assigned to the wrong person' },
      { key: 'range_issue', label: 'Number range or DID problem' },
    ],
    questions: [
      { key: 'numbers', label: 'Numbers affected', kind: 'text', required: true, max: 500, hint: 'Separate several with commas' },
      { key: 'port_reference', label: 'Port reference (if a port)', kind: 'text', max: 120 },
      ERROR_TEXT,
    ],
  },
  {
    key: 'users',
    label: 'A person cannot use calling',
    help: 'No dial pad, licence, policy, voicemail, forwarding or delegation problems.',
    skill: 'voice',
    siteRequired: true,
    subcategories: [
      { key: 'no_dialpad', label: 'No dial pad or no calling in Teams' },
      { key: 'licence', label: 'Phone licence missing' },
      { key: 'policy', label: 'Calling or routing policy problem' },
      { key: 'voicemail', label: 'Voicemail not working' },
      { key: 'forwarding', label: 'Call forwarding or ring-also not working' },
      { key: 'delegation', label: 'Delegation (boss and assistant) problem' },
    ],
    questions: [AFFECTED, ERROR_TEXT, RECENT_CHANGE],
  },
  {
    key: 'queues_aa',
    label: 'Call queue or auto attendant',
    help: 'A queue is not ringing agents, a menu or greeting is wrong, or hours are not respected.',
    skill: 'voice',
    siteRequired: true,
    subcategories: [
      { key: 'queue_not_ringing', label: 'Queue not ringing agents' },
      { key: 'wrong_agents', label: 'Wrong agents or routing' },
      { key: 'menu_greeting', label: 'Menu or greeting is wrong' },
      { key: 'hours_holiday', label: 'Opening hours or holiday schedule wrong' },
      { key: 'overflow', label: 'Overflow or time-out goes to the wrong place' },
      { key: 'resource_account', label: 'Resource account or number problem' },
    ],
    questions: [
      { key: 'which', label: 'Which call queue or auto attendant', kind: 'text', required: true, max: 200, hint: 'Name or phone number' },
      { key: 'expected', label: 'What should happen', kind: 'textarea', required: true, max: 1000 },
      { key: 'actual', label: 'What happens instead', kind: 'textarea', required: true, max: 1000 },
      WHEN,
    ],
  },
  {
    key: 'devices',
    label: 'Phones, devices and the Teams app',
    help: 'Desk phones, common area phones, headsets, Teams Rooms or the Teams app.',
    skill: 'voice',
    siteRequired: true,
    subcategories: [
      { key: 'desk_phone', label: "Desk phone won't sign in or provision" },
      { key: 'cap', label: 'Common area phone problem' },
      { key: 'client', label: 'Teams app problem' },
      { key: 'headset', label: 'Headset or audio device' },
      { key: 'rooms', label: 'Teams Rooms' },
      { key: 'firmware', label: 'Firmware or update' },
    ],
    questions: [
      { key: 'device_model', label: 'Device make and model', kind: 'text', max: 160 },
      AFFECTED,
      ERROR_TEXT,
    ],
  },
  {
    key: 'voicemail_recording',
    label: 'Voicemail, recording or analytics',
    help: 'Voicemail delivery, greetings, transcription, call recording and reporting.',
    skill: 'voice',
    siteRequired: true,
    subcategories: [
      { key: 'vm_not_delivered', label: 'Voicemail not delivered' },
      { key: 'vm_greeting', label: 'Voicemail greeting problem' },
      { key: 'transcription', label: 'Transcription problem' },
      { key: 'recording', label: 'Call recording or compliance recording' },
      { key: 'analytics', label: 'Call reporting or analytics' },
    ],
    questions: [AFFECTED, ERROR_TEXT],
  },
  {
    key: 'microsoft_service',
    label: 'Suspected Microsoft service problem',
    help: 'An outage or admin centre problem that looks like it is on Microsoft’s side.',
    skill: 'general',
    siteRequired: false,
    subcategories: [
      { key: 'ms_outage', label: 'Suspected Microsoft 365 or Teams outage' },
      { key: 'admin_centre', label: 'Teams admin centre problem' },
      { key: 'tenant_setting', label: 'Tenant or licensing setting' },
    ],
    questions: [
      { key: 'health_notice', label: 'Have you seen a Microsoft service health notice?', kind: 'boolean' },
      { key: 'notice_id', label: 'Notice reference (for example MO123456)', kind: 'text', max: 60 },
      WHEN,
    ],
  },
  {
    key: 'voxshift',
    label: 'Voxshift itself',
    help: 'A deployment failed, the Teams connection will not start, or the data looks wrong.',
    skill: 'platform',
    siteRequired: false,
    subcategories: [
      { key: 'deployment_failed', label: 'A deployment failed' },
      { key: 'connection', label: 'Teams connection problem' },
      { key: 'wrong_data', label: 'Wrong data shown in Voxshift' },
    ],
    questions: [
      { key: 'where', label: 'Where in Voxshift', kind: 'text', max: 200 },
      ERROR_TEXT,
    ],
  },
  {
    key: 'other',
    label: 'Something else',
    help: 'Anything that does not fit the choices above.',
    skill: 'general',
    siteRequired: false,
    subcategories: [],
    questions: [],
  },
];

export const INC_CATEGORY_BY_KEY: Record<string, IncCategoryDef> = Object.fromEntries(INC_CATEGORIES.map((c) => [c.key, c]));
export const INC_CATEGORY_KEYS = INC_CATEGORIES.map((c) => c.key) as [string, ...string[]];

export function incCategoryLabel(key: string, sub?: string | null): string {
  const c = INC_CATEGORY_BY_KEY[key];
  if (!c) return key;
  const s = sub ? c.subcategories.find((x) => x.key === sub) : undefined;
  return s ? `${c.label} - ${s.label}` : c.label;
}

/** An example call: the single most useful thing an engineer can be given. */
export const INC_CALL_DIRECTIONS = ['inbound', 'outbound', 'internal', 'unknown'] as const;
export interface IncExampleCall {
  /** When it happened - free text so "about 10:15 this morning" is accepted. */
  at: string;
  direction: (typeof INC_CALL_DIRECTIONS)[number];
  from?: string;
  to?: string;
  note?: string;
}

/** The incident's stored details: the category's answers, example calls and a callback number. */
export interface IncDetails {
  answers: Record<string, string | boolean | string[]>;
  example_calls: IncExampleCall[];
  contact_phone?: string;
}

/**
 * Checks a category's answers: required questions answered, selects from their
 * options, text within its length. Unknown keys are dropped.
 */
export function incCleanAnswers(
  category: string,
  answers: Record<string, unknown>,
): { ok: true; answers: IncDetails['answers'] } | { ok: false; errors: string[] } {
  const def = INC_CATEGORY_BY_KEY[category];
  if (!def) return { ok: false, errors: ['Unknown category'] };
  const out: IncDetails['answers'] = {};
  const errors: string[] = [];
  for (const q of def.questions) {
    const v = answers[q.key];
    const blank = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (blank) {
      if (q.required) errors.push(`${q.label} is required`);
      continue;
    }
    if (q.kind === 'boolean') {
      if (typeof v !== 'boolean') errors.push(`${q.label} must be yes or no`);
      else out[q.key] = v;
    } else if (q.kind === 'choices') {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !(q.options ?? []).includes(x))) errors.push(`${q.label}: choose from the list`);
      else out[q.key] = v as string[];
    } else if (q.kind === 'select') {
      if (typeof v !== 'string' || !(q.options ?? []).includes(v)) errors.push(`${q.label}: choose from the list`);
      else out[q.key] = v;
    } else {
      if (typeof v !== 'string') errors.push(`${q.label} must be text`);
      else if (v.length > (q.max ?? 500)) errors.push(`${q.label} is too long`);
      else out[q.key] = v.trim();
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, answers: out };
}

/** The answers as readable lines for the timeline, emails and the incident page. */
export function incDetailLines(category: string, answers: IncDetails['answers']): { label: string; value: string }[] {
  const def = INC_CATEGORY_BY_KEY[category];
  if (!def) return [];
  const lines: { label: string; value: string }[] = [];
  for (const q of def.questions) {
    const v = answers[q.key];
    if (v === undefined) continue;
    lines.push({ label: q.label, value: typeof v === 'boolean' ? (v ? 'Yes' : 'No') : Array.isArray(v) ? v.join(', ') : String(v) });
  }
  return lines;
}

/* ------------------------------ status ------------------------------ */

export const INC_STATUSES = ['new', 'in_progress', 'on_hold', 'restored', 'resolved', 'closed', 'cancelled', 'duplicate'] as const;
export type IncStatus = (typeof INC_STATUSES)[number];

export const INC_STATUS_LABELS: Record<IncStatus, string> = {
  new: 'New',
  in_progress: 'In progress',
  on_hold: 'On hold',
  restored: 'Service restored',
  resolved: 'Resolved',
  closed: 'Closed',
  cancelled: 'Cancelled',
  duplicate: 'Duplicate',
};

/** Plain words for customers. */
export const INC_STATUS_CUSTOMER_LABELS: Record<IncStatus, string> = {
  new: 'Received',
  in_progress: 'Being worked on',
  on_hold: 'On hold',
  restored: 'Service restored',
  resolved: 'Resolved - please confirm',
  closed: 'Closed',
  cancelled: 'Cancelled',
  duplicate: 'Duplicate of another incident',
};

/** The team still has work to do. */
export const INC_OPEN_STATUSES: readonly IncStatus[] = ['new', 'in_progress', 'on_hold', 'restored'];
/** Not closed yet: open, or resolved and waiting for the customer's confirmation. */
export const INC_LIVE_STATUSES: readonly IncStatus[] = [...INC_OPEN_STATUSES, 'resolved'];

export const INC_HOLD_REASONS = ['customer', 'carrier', 'microsoft', 'vendor'] as const;
export type IncHoldReason = (typeof INC_HOLD_REASONS)[number];
export const INC_HOLD_LABELS: Record<IncHoldReason, string> = {
  customer: 'Waiting on the customer',
  carrier: 'Waiting on the carrier',
  microsoft: 'Waiting on Microsoft',
  vendor: 'Waiting on a vendor (SBC, handset)',
};
export const INC_HOLD_CUSTOMER_LABELS: Record<IncHoldReason, string> = {
  customer: 'Waiting on you',
  carrier: 'Waiting on your carrier',
  microsoft: 'Waiting on Microsoft',
  vendor: 'Waiting on a vendor',
};

/** A resolved incident can be reopened ("still broken") for this long. */
export const INC_REOPEN_DAYS = 7;
/** A resolved incident closes by itself after this long without a reply (worker sweep, chunk 3). */
export const INC_AUTOCLOSE_DAYS = 5;
/** While waiting on the customer, remind them every this many days, at most INC_WAITING_MAX_REMINDERS times. */
export const INC_WAITING_REMINDER_DAYS = 3;
export const INC_WAITING_MAX_REMINDERS = 3;

/**
 * The kinds of move:
 *  acknowledge - New -> In progress: someone owns it
 *  progress    - Restored -> In progress: it broke again or the fix did not hold
 *  hold        - to On hold (a reason is required)
 *  resume      - On hold -> In progress
 *  restore     - service is working again (workaround or fix); the cause may still be open
 *  resolve     - cause fixed; the customer is asked to confirm
 *  close       - Resolved -> Closed (the customer confirms, or the sweep)
 *  reopen      - Resolved/Closed -> In progress within INC_REOPEN_DAYS ("still broken")
 *  cancel      - raised in error, withdrawn
 *  duplicate   - the same as another incident
 */
export type IncMoveKind = 'acknowledge' | 'progress' | 'hold' | 'resume' | 'restore' | 'resolve' | 'close' | 'reopen' | 'cancel' | 'duplicate';

export function incMoveKind(from: IncStatus, to: IncStatus): IncMoveKind | null {
  const open = INC_OPEN_STATUSES.includes(from);
  switch (to) {
    case 'in_progress':
      if (from === 'new') return 'acknowledge';
      if (from === 'on_hold') return 'resume';
      if (from === 'restored') return 'progress';
      if (from === 'resolved' || from === 'closed') return 'reopen';
      return null;
    case 'on_hold':
      return from === 'new' || from === 'in_progress' || from === 'restored' ? 'hold' : null;
    case 'restored':
      return from === 'new' || from === 'in_progress' || from === 'on_hold' ? 'restore' : null;
    case 'resolved':
      return open ? 'resolve' : null;
    case 'closed':
      return from === 'resolved' ? 'close' : null;
    case 'cancelled':
      return open ? 'cancel' : null;
    case 'duplicate':
      return open ? 'duplicate' : null;
    default:
      return null;
  }
}

/** Moves that must say what happened (the note is shown to the customer on a resolve or restore). */
export const INC_NOTE_REQUIRED: readonly IncMoveKind[] = ['restore', 'resolve', 'reopen', 'cancel', 'duplicate'];

/** Whether a Resolved or Closed incident is still inside the reopen window. */
export function incCanReopen(status: IncStatus, resolvedAt: string | Date | null, now = Date.now()): boolean {
  if (status !== 'resolved' && status !== 'closed') return false;
  if (!resolvedAt) return false;
  return now - new Date(resolvedAt).getTime() <= INC_REOPEN_DAYS * 86_400_000;
}

/** INC-0042 */
export function incReference(number: number): string {
  return `INC-${String(number).padStart(4, '0')}`;
}

export const INC_SOURCES = ['customer', 'staff', 'agent', 'monitor', 'email'] as const;
export type IncSource = (typeof INC_SOURCES)[number];

export const INC_ACTOR_TYPES = ['user', 'agent', 'system'] as const;
export type IncActorType = (typeof INC_ACTOR_TYPES)[number];

export const INC_EVENT_KINDS = ['created', 'status_changed', 'priority_changed', 'assigned', 'comment', 'waiting', 'resumed', 'attachment', 'link'] as const;
export type IncEventKind = (typeof INC_EVENT_KINDS)[number];

export const INC_ITEM_KINDS = ['site', 'user', 'number', 'call_queue', 'auto_attendant', 'cap', 'service_request', 'deployment', 'number_port'] as const;
export type IncItemKind = (typeof INC_ITEM_KINDS)[number];

/* ------------------------------ clocks (targets) ------------------------------ */

export interface IncSlaTarget {
  /** Raised -> acknowledged. */
  responseMinutes: number;
  /** Raised -> service restored. null = no restoration target (P4). */
  restoreHours: number | null;
  /** Raised -> resolved. */
  resolveHours: number;
}
export type IncSlaTargets = Record<IncPriority, IncSlaTarget>;

/** Calendar hours (business-hours cover arrives with the working calendar). */
export const INC_DEFAULT_TARGETS: IncSlaTargets = {
  p1: { responseMinutes: 15, restoreHours: 4, resolveHours: 8 },
  p2: { responseMinutes: 60, restoreHours: 8, resolveHours: 24 },
  p3: { responseMinutes: 240, restoreHours: 24, resolveHours: 72 },
  p4: { responseMinutes: 480, restoreHours: null, resolveHours: 120 },
};

/** Warn when this share of a target is left. */
export const INC_SLA_WARN_FRACTION = 0.2;

/** Whether a priority's clocks run around the clock or only in the customer's working hours. */
export type IncCover = '24x7' | 'business';
export const INC_COVERS: readonly IncCover[] = ['24x7', 'business'];

/** The customer's working week: when "business hours" clocks run. */
export interface IncCalendar {
  /** 0 = Sunday ... 6 = Saturday */
  days: number[];
  /** "HH:mm" 24h, start < end */
  start: string;
  end: string;
  /** IANA time zone, e.g. Europe/London */
  timeZone: string;
  /** Days off, "YYYY-MM-DD" (local date in timeZone). */
  holidays: string[];
}

/** Per-customer incident settings (platform.tenants.inc_settings). Everything is optional. */
export interface IncSettings {
  targets?: Partial<IncSlaTargets>;
  matrix?: { [I in IncImpact]?: Partial<Record<IncUrgency, IncPriority>> };
  /** The working week. Without one, every clock runs around the clock. */
  calendar?: IncCalendar | null;
  /** Per priority; only means anything once there is a calendar. */
  cover?: Partial<Record<IncPriority, IncCover>>;
}

/** With a calendar: P1 and P2 run around the clock, P3 and P4 in working hours. */
export const INC_DEFAULT_COVER: Record<IncPriority, IncCover> = { p1: '24x7', p2: '24x7', p3: 'business', p4: 'business' };

/** How a priority's clocks run for this customer. No calendar means 24x7 for everything. */
export function incCoverFor(settings: IncSettings | null | undefined, priority: IncPriority): IncCover {
  if (!settings?.calendar) return '24x7';
  return settings.cover?.[priority] ?? INC_DEFAULT_COVER[priority];
}

/** The calendar a priority's clocks use, or null when they run around the clock. */
export function incClockCalendar(settings: IncSettings | null | undefined, priority: IncPriority): IncCalendar | null {
  return incCoverFor(settings, priority) === 'business' ? (settings?.calendar ?? null) : null;
}

/** Working-hour defaults, used for a priority on business cover until the customer sets its own. */
export const INC_DEFAULT_BUSINESS_TARGETS: IncSlaTargets = {
  p1: INC_DEFAULT_TARGETS.p1,
  p2: { responseMinutes: 60, restoreHours: 4, resolveHours: 16 },
  p3: { responseMinutes: 240, restoreHours: 8, resolveHours: 24 },
  p4: { responseMinutes: 480, restoreHours: null, resolveHours: 40 },
};

/**
 * The targets in force: the customer's own, else the default for how that
 * priority is covered (calendar hours around the clock, working hours on
 * business cover).
 */
export function incEffectiveTargets(settings: IncSettings | null | undefined): IncSlaTargets {
  const out = { ...INC_DEFAULT_TARGETS };
  for (const p of INC_PRIORITIES) {
    const custom = settings?.targets?.[p];
    out[p] = custom ?? (incCoverFor(settings, p) === 'business' ? INC_DEFAULT_BUSINESS_TARGETS[p] : INC_DEFAULT_TARGETS[p]);
  }
  return out;
}

/* ------------------------------ working hours ------------------------------ */

interface LocalDate {
  y: number;
  m: number; // 1-12
  d: number;
}

function tzOffsetMs(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time in `timeZone` happens. */
function localToUtc(date: LocalDate, hhmm: string, timeZone: string): number {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  const guess = Date.UTC(date.y, date.m - 1, date.d, hh, mm);
  const first = guess - tzOffsetMs(guess, timeZone);
  const second = guess - tzOffsetMs(first, timeZone);
  return second;
}

function localDateOf(ms: number, timeZone: string): LocalDate & { weekday: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')) };
}

const nextDay = (d: LocalDate): LocalDate => {
  const t = new Date(Date.UTC(d.y, d.m - 1, d.d + 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const isoDate = (d: LocalDate) => `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
const weekdayOf = (d: LocalDate) => new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay();

/** The day's working interval as instants, or null on a day off. */
function workingInterval(d: LocalDate, cal: IncCalendar): [number, number] | null {
  if (!cal.days.includes(weekdayOf(d)) || cal.holidays.includes(isoDate(d))) return null;
  return [localToUtc(d, cal.start, cal.timeZone), localToUtc(d, cal.end, cal.timeZone)];
}

/** How many days ahead we look before giving up (a calendar of nothing but days off). */
const MAX_DAYS = 800;

/** Milliseconds of working time in [from, to). */
export function incWorkingMs(from: number, to: number, cal: IncCalendar): number {
  if (to <= from) return 0;
  let day: LocalDate = localDateOf(from, cal.timeZone);
  let total = 0;
  for (let i = 0; i < MAX_DAYS; i++, day = nextDay(day)) {
    const w = workingInterval(day, cal);
    if (w) {
      if (w[0] >= to) break;
      total += Math.max(0, Math.min(w[1], to) - Math.max(w[0], from));
    } else if (localToUtc(day, '00:00', cal.timeZone) >= to) break;
    if (localToUtc(nextDay(day), '00:00', cal.timeZone) >= to) break;
  }
  return total;
}

/** The instant `ms` of working time after `from` has gone by. */
export function incAddWorkingMs(from: number, ms: number, cal: IncCalendar): number {
  if (ms <= 0) return from;
  let remaining = ms;
  let day: LocalDate = localDateOf(from, cal.timeZone);
  for (let i = 0; i < MAX_DAYS; i++, day = nextDay(day)) {
    const w = workingInterval(day, cal);
    if (!w) continue;
    const begin = Math.max(w[0], from);
    const room = w[1] - begin;
    if (room <= 0) continue;
    if (room >= remaining) return begin + remaining;
    remaining -= room;
  }
  return from + ms; // no working time to be found: fall back to calendar time rather than never
}

/**
 * A hold stops the clocks when the customer is the one who has to act. Waiting
 * on a carrier, Microsoft or a vendor stops them too - except for a P1, where
 * the customer cannot do anything about it and the clock keeps running.
 */
export function incHoldPauses(priority: IncPriority, status: IncStatus, holdReason: IncHoldReason | null): boolean {
  if (status !== 'on_hold' || !holdReason) return false;
  return holdReason === 'customer' ? true : priority !== 'p1';
}

export interface IncPauseInterval {
  from: string;
  to: string;
}

export interface IncPauseState {
  paused_since: string | Date | null;
  paused_seconds: number;
  /** Closed pauses, kept so working-hours clocks can leave out only the working time spent paused. */
  pause_log?: IncPauseInterval[];
}

/**
 * The pause columns after a change of status, hold reason or priority: opens a
 * pause when a pausing hold begins, and adds the time to paused_seconds (and the
 * interval to pause_log) when it ends - including when a priority change stops
 * the hold pausing.
 */
export function incPause(
  prev: IncPauseState & { priority: IncPriority; status: IncStatus; hold_reason: IncHoldReason | null },
  next: { priority: IncPriority; status: IncStatus; hold_reason: IncHoldReason | null },
  nowIso: string,
): { paused_since: string | null; paused_seconds: number; pause_log: IncPauseInterval[] } {
  const wasPaused = !!prev.paused_since;
  const willPause = incHoldPauses(next.priority, next.status, next.hold_reason);
  const log = prev.pause_log ?? [];
  if (wasPaused && !willPause) {
    const from = new Date(prev.paused_since!).toISOString();
    const elapsed = Math.max(0, Math.round((new Date(nowIso).getTime() - new Date(from).getTime()) / 1000));
    return { paused_since: null, paused_seconds: prev.paused_seconds + elapsed, pause_log: [...log, { from, to: nowIso }] };
  }
  if (!wasPaused && willPause) return { paused_since: nowIso, paused_seconds: prev.paused_seconds, pause_log: log };
  return { paused_since: prev.paused_since ? new Date(prev.paused_since).toISOString() : null, paused_seconds: prev.paused_seconds, pause_log: log };
}

export type IncClockState = 'met' | 'missed' | 'on_track' | 'at_risk' | 'overdue' | 'paused' | 'stopped' | 'none';

export interface IncClock {
  state: IncClockState;
  /** When the target falls due, given the pauses so far (ISO). Null once met/missed, stopped or none. */
  dueAt: string | null;
  /** Milliseconds left (negative = overdue). Null when finished, paused, stopped or none. */
  leftMs: number | null;
}

export interface IncSlaInput {
  priority: IncPriority;
  status: IncStatus;
  created_at: string | Date;
  acknowledged_at: string | Date | null;
  restored_at: string | Date | null;
  resolved_at: string | Date | null;
  paused_since: string | Date | null;
  paused_seconds: number;
  pause_log?: IncPauseInterval[];
  /** A reopened incident's restoration and resolution clocks restart from here. */
  reopened_at?: string | Date | null;
}

const ms = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : null);

/**
 * Where an incident stands against its three targets right now. Cancelled and
 * duplicate incidents stop every clock; a pausing hold shows "paused". With a
 * `calendar` (business cover) a target only counts working time, and so does the
 * time spent paused.
 */
export function incSla(
  r: IncSlaInput,
  targets: IncSlaTargets,
  now = Date.now(),
  calendar: IncCalendar | null = null,
): { response: IncClock; restoration: IncClock; resolution: IncClock } {
  const t = targets[r.priority] ?? INC_DEFAULT_TARGETS.p3;
  const created = ms(r.created_at)!;
  const reopened = ms(r.reopened_at);
  const pausedNow = r.paused_since ? Math.max(0, now - ms(r.paused_since)!) : 0;
  const pausedMs = r.paused_seconds * 1000 + pausedNow;
  const log = (r.pause_log ?? []).map((p) => [new Date(p.from).getTime(), new Date(p.to).getTime()] as const);

  /** Working time spent paused between `start` and `until`. */
  const pausedWorking = (cal: IncCalendar, start: number, until: number) => {
    let total = 0;
    for (const [a, b] of log) total += incWorkingMs(Math.max(a, start), Math.min(b, until), cal);
    if (r.paused_since) total += incWorkingMs(Math.max(ms(r.paused_since)!, start), until, cal);
    return total;
  };

  const clock = (limitMs: number | null, doneAt: number | null, start: number): IncClock => {
    if (r.status === 'cancelled' || r.status === 'duplicate') return { state: 'stopped', dueAt: null, leftMs: null };
    if (limitMs === null) return { state: 'none', dueAt: null, leftMs: null };

    if (calendar) {
      if (doneAt !== null) {
        const used = incWorkingMs(start, doneAt, calendar) - pausedWorking(calendar, start, doneAt);
        return { state: used <= limitMs ? 'met' : 'missed', dueAt: null, leftMs: null };
      }
      const due = incAddWorkingMs(start, limitMs + pausedWorking(calendar, start, now), calendar);
      if (r.paused_since) return { state: 'paused', dueAt: new Date(due).toISOString(), leftMs: null };
      const left = due - now;
      const workingLeft = left >= 0 ? incWorkingMs(now, due, calendar) : -1;
      const state: IncClockState = left < 0 ? 'overdue' : workingLeft <= limitMs * INC_SLA_WARN_FRACTION ? 'at_risk' : 'on_track';
      return { state, dueAt: new Date(due).toISOString(), leftMs: left };
    }

    const due = start + limitMs + pausedMs;
    if (doneAt !== null) return { state: doneAt <= due ? 'met' : 'missed', dueAt: null, leftMs: null };
    if (r.paused_since) return { state: 'paused', dueAt: new Date(due).toISOString(), leftMs: null };
    const left = due - now;
    const state: IncClockState = left < 0 ? 'overdue' : left <= limitMs * INC_SLA_WARN_FRACTION ? 'at_risk' : 'on_track';
    return { state, dueAt: new Date(due).toISOString(), leftMs: left };
  };

  const resolvedAt = ms(r.resolved_at);
  const restoredAt = ms(r.restored_at) ?? resolvedAt;
  const restart = reopened ?? created;
  return {
    response: clock(t.responseMinutes * 60_000, ms(r.acknowledged_at), created),
    restoration: clock(t.restoreHours === null ? null : t.restoreHours * 3_600_000, restoredAt, restart),
    resolution: clock(t.resolveHours * 3_600_000, resolvedAt, restart),
  };
}

/**
 * An incident's clocks and targets under the customer's settings: each priority
 * uses its own targets and, on business cover, the customer's working calendar.
 */
export function incSlaFor(r: IncSlaInput, settings: IncSettings | null | undefined, now = Date.now()) {
  const targets = incEffectiveTargets(settings);
  return { ...incSla(r, targets, now, incClockCalendar(settings, r.priority)), target: targets[r.priority], cover: incCoverFor(settings, r.priority) };
}

/** "We aim to respond within 1 hour." - what the customer is told when they raise an incident. */
export function incRespondText(target: IncSlaTarget, cover: IncCover): string {
  const m = target.responseMinutes;
  const span = m < 120 ? `${m} minutes` : m % 60 === 0 ? `${m / 60} hours` : `${Math.round((m / 60) * 10) / 10} hours`;
  return `We aim to respond within ${span}${cover === 'business' ? ' of working time' : ''}.`;
}

/** The clock that matters now: response until acknowledged, then restoration, then resolution. */
export function incNextClock(sla: { response: IncClock; restoration: IncClock; resolution: IncClock }): { which: 'response' | 'restoration' | 'resolution'; clock: IncClock } {
  const running = (c: IncClock) => c.state === 'on_track' || c.state === 'at_risk' || c.state === 'overdue' || c.state === 'paused';
  if (running(sla.response)) return { which: 'response', clock: sla.response };
  if (running(sla.restoration)) return { which: 'restoration', clock: sla.restoration };
  return { which: 'resolution', clock: sla.resolution };
}

/* ------------------------------ DTOs ------------------------------ */

const priorityEnum = z.enum(INC_PRIORITIES);

const exampleCallSchema = z
  .object({
    at: z.string().trim().min(1, 'Say when the call happened').max(60),
    direction: z.enum(INC_CALL_DIRECTIONS),
    from: z.string().trim().max(80).optional(),
    to: z.string().trim().max(80).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

const itemInputSchema = z
  .object({
    kind: z.enum(INC_ITEM_KINDS),
    ref: z.string().trim().min(1).max(200),
    label: z.string().trim().max(200).optional(),
  })
  .strict();
export type IncItemInput = z.infer<typeof itemInputSchema>;

/** POST /incidents */
export const createIncidentSchema = z
  .object({
    title: z.string().trim().min(3, 'Give the incident a short title').max(160),
    category: z.enum(INC_CATEGORY_KEYS),
    subcategory: z.string().trim().max(60).nullable().optional(),
    siteId: z.string().uuid().nullable().optional(),
    impact: z.enum(INC_IMPACTS),
    urgency: z.enum(INC_URGENCIES),
    description: z.string().trim().min(10, 'Describe what is happening').max(8000),
    answers: z.record(z.unknown()).default({}),
    exampleCalls: z.array(exampleCallSchema).max(10).default([]),
    contactPhone: z.string().trim().max(40).optional(),
    items: z.array(itemInputSchema).max(30).default([]),
    /** Staff only: set the priority instead of calculating it (the API refuses it from a customer). */
    priority: priorityEnum.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const def = INC_CATEGORY_BY_KEY[v.category];
    if (!def) return;
    if (def.subcategories.length > 0) {
      if (!v.subcategory) ctx.addIssue({ code: 'custom', path: ['subcategory'], message: 'Choose what is wrong' });
      else if (!def.subcategories.some((s) => s.key === v.subcategory)) ctx.addIssue({ code: 'custom', path: ['subcategory'], message: 'Unknown choice' });
    } else if (v.subcategory) {
      ctx.addIssue({ code: 'custom', path: ['subcategory'], message: 'This category has no sub-categories' });
    }
    if (def.siteRequired && !v.siteId) ctx.addIssue({ code: 'custom', path: ['siteId'], message: 'Choose the site' });
    const cleaned = incCleanAnswers(v.category, v.answers);
    if (!cleaned.ok) for (const message of cleaned.errors) ctx.addIssue({ code: 'custom', path: ['answers'], message });
  });
export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;

/** GET /incidents */
export const listIncidentsQuerySchema = z
  .object({
    /** 'open' = not closed yet (open or awaiting confirmation); 'all'; or one status. */
    status: z.enum([...INC_STATUSES, 'open', 'all'] as [string, ...string[]]).default('open'),
    category: z.enum(INC_CATEGORY_KEYS).optional(),
    priority: priorityEnum.optional(),
    siteId: z.string().uuid().optional(),
    /** 'me' = assigned to me; 'none' = unassigned. */
    assigned: z.enum(['me', 'none']).optional(),
    q: z.string().trim().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();
export type ListIncidentsQuery = z.infer<typeof listIncidentsQuerySchema>;

/** GET /incidents/similar - open incidents the reporter might subscribe to instead of raising another. */
export const similarIncidentsQuerySchema = z
  .object({
    category: z.enum(INC_CATEGORY_KEYS),
    siteId: z.string().uuid().optional(),
  })
  .strict();
export type SimilarIncidentsQuery = z.infer<typeof similarIncidentsQuerySchema>;

/** POST /incidents/:id/status */
export const incidentStatusSchema = z
  .object({
    to: z.enum(INC_STATUSES),
    note: z.string().trim().max(4000).optional(),
    holdReason: z.enum(INC_HOLD_REASONS).optional(),
    duplicateOf: z.string().uuid().optional(),
  })
  .strict();
export type IncidentStatusInput = z.infer<typeof incidentStatusSchema>;

export const incidentAssignSchema = z.object({ userId: z.string().uuid().nullable() }).strict();
export type IncidentAssignInput = z.infer<typeof incidentAssignSchema>;

/** POST /incidents/:id/comments */
export const incidentCommentSchema = z
  .object({
    body: z.string().trim().min(1, 'Write a comment').max(4000),
    /** Staff-only note the customer never sees. */
    internal: z.boolean().optional(),
    /** Team only, public: a question - the incident goes on hold, waiting on the customer, until they reply. */
    waitForReply: z.boolean().optional(),
  })
  .strict();
export type IncidentCommentInput = z.infer<typeof incidentCommentSchema>;

/** POST /public/incident-response - answering "Is it fixed?" from the email link, without signing in. */
export const incidentResponseSchema = z
  .object({
    t: z.string().min(20).max(1000),
    action: z.enum(['fixed', 'broken']),
    /** What is still wrong - needed for "broken". */
    note: z.string().trim().max(4000).optional(),
  })
  .strict();
export type IncidentResponseInput = z.infer<typeof incidentResponseSchema>;

/** POST /incidents/:id/priority - staff only. */
export const incidentPrioritySchema = z.object({ priority: priorityEnum, reason: z.string().trim().min(3, 'Say why').max(1000) }).strict();
export type IncidentPriorityInput = z.infer<typeof incidentPrioritySchema>;

/** POST /incidents/:id/watchers - add yourself, or (staff) a customer user. */
export const incidentWatcherSchema = z.object({ userId: z.string().uuid().optional() }).strict();
export type IncidentWatcherInput = z.infer<typeof incidentWatcherSchema>;

/** POST /incidents/:id/items - staff only. */
export const incidentItemSchema = itemInputSchema;

const targetSchema = z
  .object({
    responseMinutes: z.number().int().positive().max(60 * 24 * 7),
    restoreHours: z.number().positive().max(24 * 30).nullable(),
    resolveHours: z.number().positive().max(24 * 90),
  })
  .strict()
  .refine((t) => t.restoreHours === null || t.resolveHours >= t.restoreHours, 'The resolution target must be at least the restoration target')
  .refine((t) => t.resolveHours * 60 >= t.responseMinutes, 'The resolution target must be at least the response target');

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const calendarSchema = z
  .object({
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start: z.string().regex(HHMM, 'Use HH:mm'),
    end: z.string().regex(HHMM, 'Use HH:mm'),
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'Unknown time zone'),
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')).max(100).default([]),
  })
  .strict()
  .refine((c) => c.start < c.end, 'The working day must end after it starts');

/** PUT /incidents/settings - Super Admins only. */
export const incidentSettingsSchema = z
  .object({
    targets: z
      .object(Object.fromEntries(INC_PRIORITIES.map((p) => [p, targetSchema.optional()])) as Record<IncPriority, z.ZodOptional<typeof targetSchema>>)
      .strict()
      .optional(),
    matrix: z
      .object(
        Object.fromEntries(
          INC_IMPACTS.map((i) => [i, z.object(Object.fromEntries(INC_URGENCIES.map((u) => [u, priorityEnum.optional()])) as Record<IncUrgency, z.ZodOptional<typeof priorityEnum>>).strict().optional()]),
        ) as Record<IncImpact, z.ZodOptional<z.ZodObject<Record<IncUrgency, z.ZodOptional<typeof priorityEnum>>, 'strict'>>>,
      )
      .strict()
      .optional(),
    calendar: calendarSchema.nullable().optional(),
    cover: z
      .object(Object.fromEntries(INC_PRIORITIES.map((p) => [p, z.enum(['24x7', 'business']).optional()])) as Record<IncPriority, z.ZodOptional<z.ZodEnum<['24x7', 'business']>>>)
      .strict()
      .optional(),
  })
  .strict();
export type IncidentSettingsInput = z.infer<typeof incidentSettingsSchema>;

export const INC_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
