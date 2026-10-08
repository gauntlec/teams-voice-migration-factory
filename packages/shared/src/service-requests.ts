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

/** Workflow order. `cancelled` can be reached from any open status. */
export const SR_STATUSES = ['new', 'planned', 'built', 'deployed', 'cancelled'] as const;
export type SrStatus = (typeof SR_STATUSES)[number];

export const SR_STATUS_LABELS: Record<SrStatus, string> = {
  new: 'New',
  planned: 'Planned',
  built: 'Designed & built',
  deployed: 'Deployed',
  cancelled: 'Cancelled',
};

/** Still waiting on the team. */
export const SR_OPEN_STATUSES: readonly SrStatus[] = ['new', 'planned', 'built'];

/** The customer is emailed when their request reaches one of these. */
export const SR_CUSTOMER_NOTIFY_STATUSES: readonly SrStatus[] = ['planned', 'built', 'deployed', 'cancelled'];

export const SR_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type SrPriority = (typeof SR_PRIORITIES)[number];

const FORWARD: Partial<Record<SrStatus, SrStatus>> = { new: 'planned', planned: 'built', built: 'deployed' };

/** The next workflow step, or null when the request is finished. */
export function nextSrStatus(status: SrStatus): SrStatus | null {
  return FORWARD[status] ?? null;
}

/** A move is one step forward, or a cancel from any open status. */
export function canMoveSr(from: SrStatus, to: SrStatus): boolean {
  if (to === 'cancelled') return SR_OPEN_STATUSES.includes(from);
  return FORWARD[from] === to;
}

/** "SR-0042": how a request is referred to in the app and in email. */
export function srReference(number: number): string {
  return `SR-${String(number).padStart(4, '0')}`;
}

export type SrFieldKind = 'text' | 'textarea' | 'number' | 'select' | 'list' | 'boolean' | 'date';

export interface SrFieldSpec {
  key: string;
  label: string;
  kind: SrFieldKind;
  required?: boolean;
  /** select only */
  options?: readonly string[];
  /** number: min value */
  min?: number;
  /** text/textarea: max length; number: max value; list: max items */
  max?: number;
  hint?: string;
}

export interface SrTypeDef {
  label: string;
  description: string;
  /** false only for a new site, which by definition has no site yet. */
  needsSite: boolean;
  fields: readonly SrFieldSpec[];
}

const NUMBER_NEED = ['New number', 'Keep an existing number', 'No number'] as const;
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
      { key: 'country', label: 'Country', kind: 'text', max: 80 },
      { key: 'go_live', label: 'Wanted by', kind: 'date' },
      { key: 'contact_email', label: 'Site contact email', kind: 'text', max: 200 },
      NOTES,
    ],
  },
  new_user: {
    label: 'New user',
    description: 'Give a person Teams calling.',
    needsSite: true,
    fields: [
      { key: 'display_name', label: 'Name', kind: 'text', required: true, max: 120 },
      { key: 'upn', label: 'Sign-in address (UPN)', kind: 'text', required: true, max: 200, hint: 'e.g. jo.bloggs@contoso.com' },
      { key: 'number', label: 'Phone number', kind: 'select', required: true, options: NUMBER_NEED },
      { key: 'existing_number', label: 'Number to keep', kind: 'text', max: 40, hint: 'Only if keeping an existing number' },
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
      { key: 'area', label: 'Area code or locality', kind: 'text', max: 80 },
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
      { key: 'device_model', label: 'Device model', kind: 'text', max: 120 },
      { key: 'number', label: 'Phone number', kind: 'select', required: true, options: NUMBER_NEED },
      NOTES,
    ],
  },
  new_call_queue: {
    label: 'New call queue',
    description: 'Ring a group of people, e.g. a sales or support line.',
    needsSite: true,
    fields: [
      { key: 'name', label: 'Queue name', kind: 'text', required: true, max: 120 },
      { key: 'agents', label: 'Who should answer (sign-in addresses)', kind: 'list', required: true, max: 50, hint: 'One per line' },
      { key: 'routing', label: 'How calls are shared out', kind: 'select', options: ['All at once', 'In order', 'Round robin', 'Longest idle'] },
      { key: 'unanswered', label: 'If nobody answers', kind: 'textarea', max: 1000, hint: 'e.g. go to voicemail after 60 seconds' },
      { key: 'number', label: 'Phone number', kind: 'select', required: true, options: NUMBER_NEED },
      NOTES,
    ],
  },
  new_auto_attendant: {
    label: 'New auto attendant',
    description: 'A menu that answers calls, e.g. "Press 1 for sales".',
    needsSite: true,
    fields: [
      { key: 'name', label: 'Auto attendant name', kind: 'text', required: true, max: 120 },
      { key: 'greeting', label: 'Greeting', kind: 'textarea', required: true, max: 1000 },
      { key: 'menu', label: 'Menu options', kind: 'textarea', max: 2000, hint: 'e.g. 1 = Sales queue, 2 = Support queue, 0 = Reception' },
      { key: 'business_hours', label: 'Opening hours', kind: 'textarea', max: 1000 },
      { key: 'after_hours', label: 'Out of hours', kind: 'textarea', max: 1000, hint: 'What callers should hear or where calls should go' },
      { key: 'number', label: 'Phone number', kind: 'select', required: true, options: NUMBER_NEED },
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

/** Label/value pairs for display and email, in form order, skipping blanks. */
export function srDetailLines(type: SrType, details: Record<string, unknown>): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const f of SR_TYPE_DEFS[type].fields) {
    const v = details[f.key];
    if (v === undefined || v === null || v === '') continue;
    let value: string;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      value = v.join(', ');
    } else if (typeof v === 'boolean') value = v ? 'Yes' : 'No';
    else value = String(v);
    out.push({ label: f.label, value });
  }
  return out;
}
