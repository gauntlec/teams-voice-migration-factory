/**
 * Managed Services: customer-raised service requests (SRs) for the things the
 * platform already builds - sites, users, phone numbers, common area phones,
 * call queues and auto attendants - plus a free-text "other". Engineers and
 * admins action them through New -> Planned -> Designed & built -> Deployed.
 *
 * Each type's form is described by field specs; the web form renders from them
 * and dto.ts builds the matching validation from the same specs, so a field is
 * only ever defined in one place.
 */

export const SR_TYPES = [
  'new_site',
  'new_user',
  'new_phone_numbers',
  'new_common_area_phone',
  'new_call_queue',
  'new_auto_attendant',
  'other',
] as const;
export type SrType = (typeof SR_TYPES)[number];

/**
 * Workflow order. `cancelled` (the customer or team withdrew it) and
 * `declined` (the team won't do it) can be reached from any open status.
 */
export const SR_STATUSES = ['new', 'planned', 'built', 'deployed', 'cancelled', 'declined'] as const;
export type SrStatus = (typeof SR_STATUSES)[number];

/** What the team sees. */
export const SR_STATUS_LABELS: Record<SrStatus, string> = {
  new: 'New',
  planned: 'Planned',
  built: 'Designed & built',
  deployed: 'Deployed',
  cancelled: 'Cancelled',
  declined: 'Declined',
};

/** What the customer sees (pages and emails): plain words, no delivery jargon. */
export const SR_STATUS_CUSTOMER_LABELS: Record<SrStatus, string> = {
  new: 'Received',
  planned: 'Scheduled',
  built: 'Ready to go live',
  deployed: 'Completed',
  cancelled: 'Cancelled',
  declined: 'Declined',
};

export function srStatusLabel(status: SrStatus, staff: boolean): string {
  return (staff ? SR_STATUS_LABELS : SR_STATUS_CUSTOMER_LABELS)[status];
}

/** Still waiting on the team. */
export const SR_OPEN_STATUSES: readonly SrStatus[] = ['new', 'planned', 'built'];

/** The customer is emailed when their request reaches one of these (but not when it's sent back a step). */
export const SR_CUSTOMER_NOTIFY_STATUSES: readonly SrStatus[] = ['planned', 'built', 'deployed', 'cancelled', 'declined'];

export const SR_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type SrPriority = (typeof SR_PRIORITIES)[number];

/** A deployed request can be reopened for this long (e.g. "it isn't working"). */
export const SR_REOPEN_DAYS = 14;

/** While waiting on the customer, remind them every this many days, at most SR_WAITING_MAX_REMINDERS times. */
export const SR_WAITING_REMINDER_DAYS = 3;
export const SR_WAITING_MAX_REMINDERS = 3;

const FORWARD: Partial<Record<SrStatus, SrStatus>> = { new: 'planned', planned: 'built', built: 'deployed' };

/** The next workflow step, or null when the request is finished. */
export function nextSrStatus(status: SrStatus): SrStatus | null {
  return FORWARD[status] ?? null;
}

/**
 * The kinds of move:
 *  forward   - one step on (New -> Planned -> Designed & built -> Deployed)
 *  cancel    - withdrawn, from any open status
 *  decline   - the team won't do it, from any open status (reason required)
 *  send_back - Designed & built -> Planned, e.g. the design was wrong or a deploy failed (reason required)
 *  reopen    - Deployed -> Planned within SR_REOPEN_DAYS (reason required)
 */
export type SrMoveKind = 'forward' | 'cancel' | 'decline' | 'send_back' | 'reopen';

export function srMoveKind(from: SrStatus, to: SrStatus): SrMoveKind | null {
  if (to === 'cancelled') return SR_OPEN_STATUSES.includes(from) ? 'cancel' : null;
  if (to === 'declined') return SR_OPEN_STATUSES.includes(from) ? 'decline' : null;
  if (FORWARD[from] === to) return 'forward';
  if (from === 'built' && to === 'planned') return 'send_back';
  if (from === 'deployed' && to === 'planned') return 'reopen';
  return null;
}

/** Moves that must say why. */
export const SR_NOTE_REQUIRED: readonly SrMoveKind[] = ['decline', 'send_back', 'reopen'];

export function canMoveSr(from: SrStatus, to: SrStatus): boolean {
  return srMoveKind(from, to) !== null;
}

/** Whether a Deployed request is still inside the reopen window. */
export function srCanReopen(status: SrStatus, deployedAt: string | null, now = Date.now()): boolean {
  if (status !== 'deployed' || !deployedAt) return false;
  return now - new Date(deployedAt).getTime() <= SR_REOPEN_DAYS * 86_400_000;
}

/** "SR-0042": how a request is referred to in the app and in email. */
export function srReference(number: number): string {
  return `SR-${String(number).padStart(4, '0')}`;
}

/** Whether a site accepts service requests: only sites in operations mode do. */
export const SITE_MODES = ['project', 'operations'] as const;
export type SiteMode = (typeof SITE_MODES)[number];
export const SITE_MODE_LABELS: Record<SiteMode, string> = { project: 'Project', operations: 'Operations' };

/**
 * How a field is answered. Plain text kinds are only used where Voxshift has no
 * data to offer (names, addresses, greetings); everything else is picked from
 * existing data:
 * - person / people: the customer's directory (synced users, plus Data Collection users)
 * - phone_number: a number at the request's site - `numberSource` 'available'
 *   offers free numbers (and one is picked automatically), 'site' offers any of
 *   the site's numbers (keeping an existing one)
 * - target: where a call goes - a call queue or auto attendant at the site, a
 *   person, voicemail, or disconnect
 * - menu: auto attendant key presses, each to a target
 * - number_range / device_model / country: the site's ranges, known phone
 *   models, ISO countries
 */
export type SrFieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'boolean'
  | 'date'
  | 'person'
  | 'people'
  | 'phone_number'
  | 'target'
  | 'menu'
  | 'number_range'
  | 'device_model'
  | 'country';

export interface SrFieldSpec {
  key: string;
  label: string;
  kind: SrFieldKind;
  required?: boolean;
  /** select only */
  options?: readonly string[];
  /** number: min value */
  min?: number;
  /** text/textarea: max length; number: max value; people/menu: max items */
  max?: number;
  hint?: string;
  /** phone_number only: which of the site's numbers to offer. */
  numberSource?: 'available' | 'site';
  /**
   * Only asked (and only required) when another field has this value, e.g. the
   * number to keep is only asked when "Keep an existing number" is chosen.
   * Hidden fields are dropped from the request.
   */
  showWhen?: { key: string; equals: string };
}

export interface SrTypeDef {
  label: string;
  description: string;
  /** false only for a new site, which by definition has no site yet. */
  needsSite: boolean;
  fields: readonly SrFieldSpec[];
}

/** A person from the directory. `name` is shown; `upn` identifies them. */
export interface SrPerson {
  upn: string;
  name: string;
}

export const SR_TARGET_KINDS = ['call_queue', 'auto_attendant', 'person', 'voicemail', 'disconnect'] as const;
export type SrTargetKind = (typeof SR_TARGET_KINDS)[number];

/** Where a call goes. `id` is the queue / auto attendant; `upn` the person. */
export interface SrTarget {
  kind: SrTargetKind;
  id?: string;
  upn?: string;
  label: string;
}

export const SR_MENU_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;

export interface SrMenuOption {
  key: (typeof SR_MENU_KEYS)[number];
  target: SrTarget;
}

export const NUMBER_NEED_NEW = 'New number';
export const NUMBER_NEED_KEEP = 'Keep an existing number';
const NUMBER_NEED = [NUMBER_NEED_NEW, NUMBER_NEED_KEEP, 'No number'] as const;

/** The three number fields every number-bearing request shares. */
const NUMBER_FIELDS: readonly SrFieldSpec[] = [
  { key: 'number', label: 'Phone number', kind: 'select', required: true, options: NUMBER_NEED },
  {
    key: 'new_number',
    label: 'New number',
    kind: 'phone_number',
    numberSource: 'available',
    required: true,
    showWhen: { key: 'number', equals: NUMBER_NEED_NEW },
    hint: "A free number at this site is picked for you. Choose another if you'd prefer.",
  },
  {
    key: 'existing_number',
    label: 'Number to keep',
    kind: 'phone_number',
    numberSource: 'site',
    required: true,
    showWhen: { key: 'number', equals: NUMBER_NEED_KEEP },
  },
];

const NOTES: SrFieldSpec = { key: 'notes', label: 'Anything else we should know', kind: 'textarea', max: 4000 };

export const SR_TYPE_DEFS: Record<SrType, SrTypeDef> = {
  new_site: {
    label: 'New site',
    description: 'Add a new office or location to the service.',
    needsSite: false,
    fields: [
      { key: 'sitecode', label: 'Site code', kind: 'text', required: true, max: 20, hint: 'A short unique code, e.g. LON02' },
      { key: 'name', label: 'Site name', kind: 'text', required: true, max: 120 },
      { key: 'address', label: 'Address', kind: 'textarea', required: true, max: 400, hint: 'Used for emergency calling, so include the full address.' },
      { key: 'country', label: 'Country', kind: 'country', required: true },
      { key: 'go_live', label: 'Wanted by', kind: 'date' },
      { key: 'contact', label: 'Site contact', kind: 'person' },
      NOTES,
    ],
  },
  new_user: {
    label: 'New user',
    description: 'Give a person Teams calling.',
    needsSite: true,
    fields: [
      { key: 'user', label: 'Person', kind: 'person', required: true, hint: 'Search your directory by name or sign-in address.' },
      ...NUMBER_FIELDS,
      { key: 'voicemail', label: 'Voicemail', kind: 'boolean' },
      NOTES,
    ],
  },
  new_phone_numbers: {
    label: 'New phone numbers',
    description: 'Order new numbers for a site.',
    needsSite: true,
    fields: [
      { key: 'quantity', label: 'How many numbers', kind: 'number', required: true, min: 1, max: 1000 },
      { key: 'purpose', label: 'What they are for', kind: 'select', required: true, options: ['Users', 'Call queue or auto attendant', 'Common area phones', 'Other'] },
      { key: 'range', label: 'Next to which range', kind: 'number_range', hint: 'Pick an existing range to extend, or leave it for a new range.' },
      { key: 'number_type', label: 'Number type', kind: 'select', options: ['No preference', 'Calling Plan', 'Direct Routing', 'Operator Connect'] },
      NOTES,
    ],
  },
  new_common_area_phone: {
    label: 'New common area phone',
    description: 'A shared desk, lobby or meeting-room phone.',
    needsSite: true,
    fields: [
      { key: 'display_name', label: 'Phone name', kind: 'text', required: true, max: 120, hint: 'e.g. Reception desk' },
      { key: 'location', label: 'Where it will be', kind: 'text', max: 120 },
      { key: 'device_model', label: 'Device model', kind: 'device_model' },
      ...NUMBER_FIELDS,
      NOTES,
    ],
  },
  new_call_queue: {
    label: 'New call queue',
    description: 'Ring a group of people, e.g. a sales or support line.',
    needsSite: true,
    fields: [
      { key: 'name', label: 'Queue name', kind: 'text', required: true, max: 120 },
      { key: 'agents', label: 'Who should answer', kind: 'people', required: true, max: 50 },
      { key: 'routing', label: 'How calls are shared out', kind: 'select', options: ['All at once', 'In order', 'Round robin', 'Longest idle'] },
      { key: 'unanswered_after', label: 'If nobody answers within', kind: 'select', options: ['30 seconds', '1 minute', '2 minutes', '5 minutes', '10 minutes', '20 minutes'] },
      { key: 'unanswered', label: 'Then send the call to', kind: 'target' },
      ...NUMBER_FIELDS,
      NOTES,
    ],
  },
  new_auto_attendant: {
    label: 'New auto attendant',
    description: 'A menu that answers calls, e.g. "Press 1 for sales".',
    needsSite: true,
    fields: [
      { key: 'name', label: 'Auto attendant name', kind: 'text', required: true, max: 120 },
      { key: 'greeting', label: 'Greeting', kind: 'textarea', required: true, max: 1000, hint: 'What callers hear first.' },
      { key: 'menu', label: 'Menu options', kind: 'menu', max: 10 },
      { key: 'business_hours', label: 'Opening hours', kind: 'textarea', max: 1000 },
      { key: 'after_hours', label: 'Out of hours, send calls to', kind: 'target' },
      ...NUMBER_FIELDS,
      NOTES,
    ],
  },
  other: {
    label: 'Something else',
    description: 'Any other change to your Teams calling.',
    needsSite: false,
    fields: [{ key: 'description', label: 'What do you need?', kind: 'textarea', required: true, max: 4000 }],
  },
};

/** Whether a field is asked, given the other answers (see showWhen). */
export function srFieldVisible(f: SrFieldSpec, details: Record<string, unknown>): boolean {
  return !f.showWhen || details[f.showWhen.key] === f.showWhen.equals;
}

/** The field holding a free number the request would take, if this type has one. */
export const SR_NEW_NUMBER_KEY = 'new_number';

/**
 * ISO 3166-1 alpha-2 codes. Names come from Intl.DisplayNames (countryName), so
 * there is no hand-maintained list of names to drift.
 */
export const COUNTRY_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ',
  'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR',
  'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR',
  'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM', 'HN', 'HR', 'HT', 'HU',
  'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ',
  'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ',
  'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF',
  'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI',
  'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR',
  'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
] as const;
export type CountryCode = (typeof COUNTRY_CODES)[number];

let regionNames: Intl.DisplayNames | null = null;
/** English country name for an ISO code, e.g. GB -> United Kingdom. */
export function countryName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

function targetLabel(t: SrTarget): string {
  return t.label;
}

/** Label/value pairs for display and email, in form order, skipping blanks and hidden fields. */
export function srDetailLines(type: SrType, details: Record<string, unknown>): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const f of SR_TYPE_DEFS[type].fields) {
    if (!srFieldVisible(f, details)) continue;
    const v = details[f.key];
    if (v === undefined || v === null || v === '') continue;
    let value: string;
    switch (f.kind) {
      case 'person':
        value = `${(v as SrPerson).name} (${(v as SrPerson).upn})`;
        break;
      case 'people':
        if (!Array.isArray(v) || v.length === 0) continue;
        value = (v as SrPerson[]).map((p) => p.name).join(', ');
        break;
      case 'target':
        value = targetLabel(v as SrTarget);
        break;
      case 'menu':
        if (!Array.isArray(v) || v.length === 0) continue;
        value = (v as SrMenuOption[]).map((o) => `${o.key}: ${targetLabel(o.target)}`).join('; ');
        break;
      case 'country':
        value = countryName(String(v));
        break;
      case 'boolean':
        value = v ? 'Yes' : 'No';
        break;
      case 'number_range':
        value = (v as { label: string }).label;
        break;
      default:
        value = Array.isArray(v) ? v.join(', ') : String(v);
    }
    out.push({ label: f.label, value });
  }
  return out;
}
