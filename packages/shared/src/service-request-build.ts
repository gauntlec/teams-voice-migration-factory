/**
 * Managed Services -> Design & Build: turns what the customer typed into a
 * service request into the matching draft Design & Build row, so the engineer
 * doesn't retype it ("Create in Design & Build" on the request).
 *
 *   new_user              -> build_users row (Users tab)
 *   new_common_area_phone -> build_caps row (Common area phones tab)
 *   new_call_queue        -> build_call_queues row (Call queues tab)
 *   new_auto_attendant    -> build_auto_attendants row (Auto attendants tab)
 *   new_site              -> discovery_sites row (a new site)
 *   new_phone_numbers / other -> nothing to create automatically
 *
 * Everything here is pure (no database): the API resolves anything that needs
 * a lookup (agent names -> UPNs) first, maps with srToBuildDraft, then runs the
 * result through the normal Design & Build / site create validation and create
 * paths. The phone number is always left for the engineer to pick.
 *
 * The readers below accept both the original request shape (plain text UPNs,
 * one-per-line agents, free-text menus) and the richer picker shape (a person
 * as { upn, name }, a call target as { label }, a menu as [{ key, target }]),
 * so requests raised before and after a form change both map.
 */
import { z } from 'zod';
import { CALL_QUEUE_ROUTING_METHODS } from './domain';
import { upnSchema } from './dto';
import type {
  BuildAutoAttendantCreateInput,
  BuildCallQueueCreateInput,
  BuildCapCreateInput,
  BuildIdentityCreateInput,
  DiscoverySiteInput,
} from './dto';
import type { SrStatus, SrType } from './service-requests';

export type SrBuildKind = 'site' | 'user' | 'cap' | 'call_queue' | 'auto_attendant';

/** What each request type creates in Design & Build; null = nothing automatic. */
export const SR_BUILD_KIND: Record<SrType, SrBuildKind | null> = {
  new_site: 'site',
  new_user: 'user',
  new_phone_numbers: null,
  new_common_area_phone: 'cap',
  new_call_queue: 'call_queue',
  new_auto_attendant: 'auto_attendant',
  // Change and remove requests link the existing row - see service-request-change.ts.
  change_user: 'user',
  change_call_queue: 'call_queue',
  change_auto_attendant: 'auto_attendant',
  remove_user: 'user',
  remove_common_area_phone: 'cap',
  other: null,
};

export const SR_BUILD_KIND_LABELS: Record<SrBuildKind, string> = {
  site: 'Site',
  user: 'User',
  cap: 'Common area phone',
  call_queue: 'Call queue',
  auto_attendant: 'Auto attendant',
};

/**
 * Drafting is for requests still being worked out. Once the request is
 * Designed & built the rows exist (or were made by hand), and a Deployed or
 * Cancelled request is finished.
 */
export const SR_BUILD_DRAFT_STATUSES: readonly SrStatus[] = ['new', 'planned'];

export function canDraftSrInBuild(type: SrType, status: SrStatus): boolean {
  return SR_BUILD_KIND[type] !== null && SR_BUILD_DRAFT_STATUSES.includes(status);
}

type RoutingMethod = (typeof CALL_QUEUE_ROUTING_METHODS)[number];

/** The call queue form's friendly "How calls are shared out" -> Set-CsCallQueue -RoutingMethod. */
export const SR_ROUTING_TO_BUILD: Record<string, RoutingMethod> = {
  'All at once': 'Attendant',
  'In order': 'Serial',
  'Round robin': 'RoundRobin',
  'Longest idle': 'LongestIdle',
};

/** The draft row, ready for the matching Design & Build create schema. `key` is its natural key (UPN / name / sitecode). */
export type SrBuildDraft =
  | { kind: 'site'; key: string; label: string; input: DiscoverySiteInput }
  | { kind: 'user'; key: string; label: string; input: BuildIdentityCreateInput }
  | { kind: 'cap'; key: string; label: string; input: BuildCapCreateInput }
  | { kind: 'call_queue'; key: string; label: string; input: BuildCallQueueCreateInput }
  | { kind: 'auto_attendant'; key: string; label: string; input: BuildAutoAttendantCreateInput };

export interface SrBuildContext {
  /** "SR-0042" - noted on the row so the engineer can trace it back. */
  reference: string;
  /** The request's site; every type except new_site needs one. */
  siteId: string | null;
  /** Common area phones only: the account UPN, which the customer isn't asked for. */
  capUpn?: string | null;
  /** Call queues only: agent UPNs after the API has resolved any names. Defaults to the UPNs in the request. */
  agentUpns?: string[];
}

export type SrBuildMapping = { ok: true; draft: SrBuildDraft } | { ok: false; error: string };

/* ------------------------------ field readers ------------------------------ */

const UPN_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Plain text from a text answer or a picked { label } / { name } value. */
function text(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['label', 'name', 'e164', 'number']) if (typeof o[k] === 'string' && o[k]) return (o[k] as string).trim();
  }
  return '';
}

/** The person a new-user request is for: { upn, name } picker, or the original upn + display_name fields. */
function person(details: Record<string, unknown>): { upn: string; name: string } {
  const u = details.user;
  if (u && typeof u === 'object') {
    const o = u as Record<string, unknown>;
    return { upn: text(o.upn), name: text(o.name) };
  }
  return { upn: text(details.upn), name: text(details.display_name) };
}

/** A menu: free text, or [{ key, target: { label } }]. */
function menuText(v: unknown): string {
  if (Array.isArray(v)) {
    return v
      .map((o) => (o && typeof o === 'object' ? `${text((o as Record<string, unknown>).key)}: ${text((o as Record<string, unknown>).target)}` : text(o)))
      .filter((s) => s && s !== ': ')
      .join('; ');
  }
  return text(v);
}

/** "Phone number: Keep an existing number (+44 20 7946 0000)" - the engineer picks the number. */
function numberLine(details: Record<string, unknown>): string | null {
  const need = text(details.number);
  if (!need) return null;
  const which = text(details.existing_number) || text(details.new_number);
  return `Phone number: ${need}${which ? ` (${which})` : ''}.`;
}

/** A two-letter ISO code becomes its English name (sites hold the country as text). */
function countryText(v: unknown): string {
  const s = text(v);
  if (!/^[A-Z]{2}$/.test(s)) return s;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(s) ?? s;
  } catch {
    return s;
  }
}

/**
 * Shortens text to a Design & Build field's limit. Nothing is lost: the full
 * answer stays on the request, which the note points to.
 */
export function fitText(value: string, max: number, reference: string): string {
  if (value.length <= max) return value;
  const suffix = `… (full text on ${reference})`;
  return value.slice(0, Math.max(0, max - suffix.length)).trimEnd() + suffix;
}

/** Lines for a row's comments/notes, under a "From SR-0042" header. */
function note(reference: string, max: number, lines: (string | null | undefined | false)[]): string {
  return fitText([`From ${reference}.`, ...lines.filter((l): l is string => !!l)].join('\n'), max, reference);
}

/**
 * Splits the call queue's agents into UPNs and anything else (names typed in
 * instead of sign-in addresses), which the API tries to find in the directory.
 */
export function srAgentEntries(details: Record<string, unknown>): { upns: string[]; names: string[] } {
  const raw = Array.isArray(details.agents) ? details.agents : typeof details.agents === 'string' ? details.agents.split(/[\n,;]/) : [];
  const upns: string[] = [];
  const names: string[] = [];
  for (const a of raw) {
    const upn = a && typeof a === 'object' ? text((a as Record<string, unknown>).upn) : text(a);
    if (UPN_RE.test(upn)) {
      const lower = upn.toLowerCase();
      if (!upns.includes(lower)) upns.push(lower);
    } else {
      const name = upn || (a && typeof a === 'object' ? text((a as Record<string, unknown>).name) : '');
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return { upns, names };
}

/* --------------------------------- mapping --------------------------------- */

/**
 * The draft Design & Build row for a request, or why there can't be one.
 * The result still goes through the Design & Build create schema in the API -
 * this only decides which answer goes in which field.
 */
export function srToBuildDraft(type: SrType, details: Record<string, unknown>, ctx: SrBuildContext): SrBuildMapping {
  const kind = SR_BUILD_KIND[type];
  if (!kind) return { ok: false, error: 'This type of request has nothing to create in Design & Build. Make the change there by hand.' };
  const ref = ctx.reference;
  const notes = text(details.notes);

  if (kind === 'site') {
    const sitecode = text(details.sitecode);
    if (!sitecode) return { ok: false, error: 'The request has no site code.' };
    return {
      ok: true,
      draft: {
        kind,
        key: sitecode,
        label: sitecode,
        input: {
          sitecode,
          name: fitText(text(details.name), 200, ref),
          address: fitText(text(details.address), 500, ref),
          country: fitText(countryText(details.country), 80, ref),
        },
      },
    };
  }

  // Everything else lives on a site.
  if (!ctx.siteId) return { ok: false, error: "The request's site no longer exists. Pick the site in Design & Build and add the row by hand." };
  const site_id = ctx.siteId;

  switch (kind) {
    case 'user': {
      const p = person(details);
      if (!p.upn) return { ok: false, error: 'The request has no sign-in address (UPN).' };
      const input: BuildIdentityCreateInput = {
        site_id,
        upn: p.upn,
        comments: note(ref, 2000, [p.name && `Name: ${p.name}.`, numberLine(details), notes && `Notes: ${notes}`]),
      };
      if (typeof details.voicemail === 'boolean') input.voicemail = { enabled: details.voicemail };
      return { ok: true, draft: { kind, key: p.upn.toLowerCase(), label: p.upn.toLowerCase(), input } };
    }
    case 'cap': {
      const upn = (ctx.capUpn ?? '').trim();
      if (!upn) return { ok: false, error: 'Enter the sign-in address (UPN) for the common area phone account.' };
      const name = text(details.display_name);
      return {
        ok: true,
        draft: {
          kind,
          key: upn.toLowerCase(),
          label: name ? `${name} (${upn.toLowerCase()})` : upn.toLowerCase(),
          input: {
            site_id,
            upn,
            display_name: fitText(name, 160, ref),
            phone_location: fitText(text(details.location), 160, ref),
            phone_model: fitText(text(details.device_model), 120, ref),
            comments: note(ref, 2000, [numberLine(details), notes && `Notes: ${notes}`]),
          },
        },
      };
    }
    case 'call_queue': {
      const name = text(details.name);
      if (!name) return { ok: false, error: 'The request has no queue name.' };
      const routing = text(details.routing);
      const after = text(details.unanswered_after);
      const unanswered = text(details.unanswered);
      return {
        ok: true,
        draft: {
          kind,
          key: name.toLowerCase(),
          label: name,
          input: {
            site_id,
            name: fitText(name, 160, ref),
            routing_method: SR_ROUTING_TO_BUILD[routing] ?? null,
            agents: ctx.agentUpns ?? srAgentEntries(details).upns,
            notes: note(ref, 2000, [
              (after || unanswered) && `If nobody answers${after ? ` within ${after}` : ''}: ${unanswered || 'not specified'}.`,
              numberLine(details),
              notes && `Notes: ${notes}`,
            ]),
          },
        },
      };
    }
    case 'auto_attendant': {
      const name = text(details.name);
      if (!name) return { ok: false, error: 'The request has no auto attendant name.' };
      const greeting = text(details.greeting);
      const menu = menuText(details.menu);
      return {
        ok: true,
        draft: {
          kind,
          key: name.toLowerCase(),
          label: name,
          input: {
            site_id,
            name: fitText(name, 160, ref),
            // The greeting becomes a text-to-speech prompt; the menu itself is
            // left in the notes for the engineer to build with real targets.
            default_call_flow: {
              greetings: greeting ? [{ type: 'Text', text: fitText(greeting, 1000, ref) }] : [],
              menu: { options: [] },
            },
            business_hours: fitText(text(details.business_hours), 400, ref),
            ooh_action: fitText(text(details.after_hours), 400, ref),
            notes: note(ref, 2000, [menu && `Menu options: ${menu}`, numberLine(details), notes && `Notes: ${notes}`]),
          },
        },
      };
    }
  }
}

/** A suggested common area phone UPN, e.g. "Reception desk" + contoso.com -> reception.desk@contoso.com. */
export function suggestCapUpn(displayName: string, domain: string | null): string | null {
  if (!domain) return null;
  const local = displayName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 60);
  return local ? `${local}@${domain}` : null;
}

/** Body of POST /service-requests/:id/build-draft. */
export const serviceRequestBuildDraftSchema = z
  .object({
    /** Common area phones only - see SrBuildContext.capUpn. */
    capUpn: upnSchema.optional(),
  })
  .strict();
export type ServiceRequestBuildDraftInput = z.infer<typeof serviceRequestBuildDraftSchema>;

/** One row on the "Created draft rows" result and timeline entry. `href` is an in-app path. */
export interface SrBuildLink {
  kind: SrBuildKind;
  label: string;
  href: string;
}

/** POST /service-requests/:id/build-draft */
export interface SrBuildDraftResult {
  /** Rows made by this call. */
  created: SrBuildLink[];
  /** Rows that already existed with the same UPN / name / site code - left untouched. */
  existing: SrBuildLink[];
  /** Things the engineer should check, e.g. agents that couldn't be found - for a change request, its to-do list. */
  warnings: string[];
  /** Change requests: what was applied to the existing row. */
  applied?: string[];
}

/** Where a row lives in the app - the Design & Build tab, or the site's Data Collection page. */
export function srBuildHref(kind: SrBuildKind, siteId: string): string {
  if (kind === 'site') return `/data-collection/sites/${siteId}`;
  const tab = { user: 'users', cap: 'caps', call_queue: 'call-queues', auto_attendant: 'auto-attendants' }[kind];
  return `/build/sites/${siteId}?tab=${tab}`;
}
