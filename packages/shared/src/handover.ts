import { HANDOVER_SECTIONS, type HandoverNoteSection } from './domain';

/**
 * What one Handover section holds, as stored in handover_sections.content and
 * rendered by both the .docx builder and the in-app preview.
 */
export type HandoverSectionContent =
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'paragraphs'; paragraphs: string[] }
  | { kind: 'placeholder'; note: string }
  /** A section laid out like the template (docs: the corrected AT&T pack, 5 Nov 2026): text, sub-headings and tables in order. */
  | { kind: 'blocks'; blocks: HandoverBlock[] };

/**
 * One part of a 'blocks' section. Tables carry their caption ("Table N – <caption>", numbered in the document).
 * - labels: a label/value table, navy labels on the left (Site Information; Emergency Calling Policies).
 * - cards: label/value tables two across (Call Queues: one card per queue).
 * - actions: Outstanding Actions - numbered <section>.<n> in the document, with a description and an owner.
 */
export type HandoverBlock =
  | { kind: 'heading'; title: string }
  | { kind: 'text'; text: string; bold?: boolean }
  | { kind: 'bullets'; items: string[] }
  /** share: the table's width as a part of the text width (1 = full width), for a narrow table such as a list of policies */
  | { kind: 'table'; columns: string[]; rows: string[][]; caption?: string; share?: number }
  | { kind: 'labels'; rows: [string, string][]; caption?: string; title?: string }
  | { kind: 'cards'; cards: [string, string][][]; caption?: string; /** cards side by side (default 2); 1 gives each card the page's width */ perRow?: 1 | 2 }
  | { kind: 'actions'; items: { description: string; owner: string }[]; caption?: string }
  /** a picture kept with the pack (a call flow diagram): the stored file, what it shows, and its size in pixels */
  | { kind: 'image'; fileId: string; title: string; width: number; height: number; /** "Figure N – <this>" under the picture */ caption?: string };

/** A note line that is a bullet ("- " or "• ") or a numbered sub-heading ("## "), as the document and preview draw it. */
export function noteLine(line: string): { kind: 'bullet' | 'heading' | 'text'; text: string } {
  const t = line.trim();
  if (/^##\s+/.test(t)) return { kind: 'heading', text: t.replace(/^##\s+/, '') };
  if (/^[-•*]\s+/.test(t)) return { kind: 'bullet', text: t.replace(/^[-•*]\s+/, '') };
  return { kind: 'text', text: t };
}

/** One outstanding action as the Service Handover page lists it (handover_actions). */
export interface HandoverAction {
  id: string;
  site_id: string | null;
  sitecode: string | null;
  description: string;
  owner: string;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  done_at: string | null;
  done_by: string | null;
  done_by_name: string | null;
  /** still open after the customer's reminder interval (docs/HANDOVER-VIEW.md step 4); never true when reminders are off */
  overdue?: boolean;
}

/** Service Handover reminders: an action open this many days is overdue (default 7, 0 = off). */
export const HANDOVER_REMINDER_DEFAULT_DAYS = 7;
export const HANDOVER_REMINDER_MAX_DAYS = 365;

/** Is an open action overdue? Added at least `days` days ago and not done; never with reminders off (0). */
export function handoverActionOverdue(a: { created_at: string | Date; done_at: string | Date | null }, days: number, now = new Date()): boolean {
  return days > 0 && !a.done_at && now.getTime() - new Date(a.created_at).getTime() >= days * 86_400_000;
}

/**
 * The pack's Outstanding Actions: the open ones (a ticked-off action drops out of the next version), a site's prefixed with its
 * code. Numbered by the document as <section>.<n>, as the template does.
 */
export function outstandingActionsContent(actions: readonly { sitecode: string | null; description: string; owner: string }[]): HandoverSectionContent {
  const items = actions.map((a) => ({ description: `${a.sitecode ? `${a.sitecode}: ` : ''}${a.description.trim()}`, owner: a.owner.trim() }));
  if (items.length === 0) return { kind: 'blocks', blocks: [{ kind: 'text', text: 'There are no outstanding actions.' }] };
  return { kind: 'blocks', blocks: [{ kind: 'actions', items, caption: 'Outstanding Actions Table' }] };
}

/** Shown for a note-backed section until someone writes a note for it. */
export const HANDOVER_NOTE_EMPTY: Record<HandoverNoteSection, string> = {
  introduction: 'The standard introduction is printed.',
  service_support_model: 'Not yet captured in Voxshift — agree the ongoing support model with the customer and add it to this section manually.',
  paging: 'No paging system data is currently collected by Voxshift.',
  teams_configuration: 'Not yet captured in Voxshift — record tenant-wide Microsoft Teams configuration decisions in this section manually.',
};

export interface HandoverNote {
  /** null = the note applies to every site. */
  sitecode: string | null;
  body: string;
}

/**
 * A note-backed section: the all-sites note first, then each site's note in site
 * code order. Notes are labelled with their site only when a site-specific note
 * is present, so a single all-sites note reads as plain text.
 */
export function noteSectionContent(key: HandoverNoteSection, notes: readonly HandoverNote[]): HandoverSectionContent {
  const filled = notes.filter((n) => n.body.trim() !== '');
  if (filled.length === 0) return { kind: 'placeholder', note: HANDOVER_NOTE_EMPTY[key] };
  const sorted = [...filled].sort((a, b) => {
    if (a.sitecode === b.sitecode) return 0;
    if (a.sitecode === null) return -1;
    if (b.sitecode === null) return 1;
    return a.sitecode.localeCompare(b.sitecode);
  });
  const labelled = sorted.some((n) => n.sitecode !== null);
  const paragraphs: string[] = [];
  for (const n of sorted) {
    if (labelled) paragraphs.push(`${n.sitecode ?? 'All sites'}:`);
    paragraphs.push(...n.body.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== ''));
  }
  return { kind: 'paragraphs', paragraphs };
}

/** The chosen sections in template order; none chosen means every section. */
export function selectSections<T extends { key: string }>(all: readonly T[], keys?: readonly string[] | null): T[] {
  if (!keys || keys.length === 0) return [...all];
  const wanted = new Set(keys);
  return all.filter((s) => wanted.has(s.key));
}

/** True for a section key that exists in the template. */
export function isHandoverSectionKey(key: string): boolean {
  return HANDOVER_SECTIONS.some((s) => s.key === key);
}

/** The cover-page / list label for a pack's scope. */
export function handoverScopeLabel(siteCodes: readonly string[] | null | undefined): string {
  return siteCodes && siteCodes.length > 0 ? [...siteCodes].sort().join(', ') : 'All sites';
}

/** Do two packs cover the same sites? A site's packs have their own version numbers and Document Control; so does "all sites". */
export function sameHandoverScope(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  return [...(a ?? [])].sort().join(',') === [...(b ?? [])].sort().join(',');
}

/**
 * A site on the Service Handover page (docs/HANDOVER-VIEW.md): its own packs set its status. A pack covering several sites (or every
 * site) doesn't count towards any one site's, so the three statuses stay simple.
 */
export type HandoverSiteStatus = 'not_created' | 'draft' | 'issued';

export const HANDOVER_SITE_STATUS_LABELS: Record<HandoverSiteStatus, string> = { not_created: 'Not created', draft: 'Draft', issued: 'Issued' };

export interface HandoverSiteRow {
  id: string;
  sitecode: string;
  name: string | null;
  country: string | null;
  region: string | null;
  status: HandoverSiteStatus;
  /** the newest pack's version ("1.1"), and the newest issued one's; null when there is none */
  latestVersion: string | null;
  issuedVersion: string | null;
  /** the newest thing that happened to the site's packs: a draft generated, or a pack issued */
  lastChange: { at: string; by: string | null; what: 'generated' | 'issued' } | null;
  /** the site's outstanding actions and the all-sites ones (both print in its pack); null for customer users, who don't see them */
  actions: { open: number; total: number; overdue: number } | null;
  /** the site's Provider PM(s) from the Site Overview, as names */
  providerPms: string[];
}

type SitePack = { status: 'draft' | 'issued'; version: number; version_label: string | null; generated_by?: string | null; generated_at: string | Date | null; issued_by?: string | null; issued_at: string | Date | null; created_at: string | Date };

/** A site's status from its own packs (any order): none = Not created, else the newest pack's Draft or Issued. */
export function handoverSiteStatus(packs: readonly SitePack[]): Pick<HandoverSiteRow, 'status' | 'latestVersion' | 'issuedVersion'> & { lastChange: { at: Date; byId: string | null; what: 'generated' | 'issued' } | null } {
  if (packs.length === 0) return { status: 'not_created', latestVersion: null, issuedVersion: null, lastChange: null };
  const byVersion = [...packs].sort((a, b) => b.version - a.version);
  const latest = byVersion[0]!;
  const issued = byVersion.find((p) => p.status === 'issued');
  const label = (p: SitePack) => p.version_label ?? String(p.version);
  const events = packs.flatMap((p) => [
    { at: new Date(p.generated_at ?? p.created_at), byId: p.generated_by ?? null, what: 'generated' as const },
    ...(p.issued_at ? [{ at: new Date(p.issued_at), byId: p.issued_by ?? null, what: 'issued' as const }] : []),
  ]);
  const lastChange = events.reduce((a, b) => (b.at.getTime() >= a.at.getTime() ? b : a));
  return { status: latest.status, latestVersion: label(latest), issuedVersion: issued ? label(issued) : null, lastChange };
}

type VersionedPack = { status: 'draft' | 'issued'; version_label: string | null };
const minorsOf = (packs: readonly VersionedPack[], major: 0 | 1) =>
  packs.map((p) => new RegExp(`^${major}\\.(\\d+)$`).exec(p.version_label ?? '')?.[1]).filter((m): m is string => !!m).map(Number);

/**
 * A new pack's version (major.minor, the team's rule for documents), given the packs for the same sites: drafts are 0.1, 0.2, … until
 * one is first issued; after that every new pack is the next 1.x - 1.1, 1.2 - a draft until it is issued. Each site counts on its own.
 */
export function nextHandoverVersionLabel(packs: readonly VersionedPack[]): string {
  const ones = minorsOf(packs, 1);
  if (ones.length > 0 || packs.some((p) => p.status === 'issued')) return `1.${Math.max(0, ...ones) + 1}`;
  return `0.${Math.max(0, ...minorsOf(packs, 0)) + 1}`;
}

/**
 * The version a pack is issued as, given the packs for the same sites: the first issue of a 0.x draft makes it 1.0, a later 0.x draft
 * takes the next 1.x (never a second 1.0), and a 1.x keeps its number.
 */
export function issuedHandoverVersionLabel(label: string | null, packs: readonly VersionedPack[]): string {
  if (label && !label.startsWith('0.')) return label;
  return packs.some((p) => p.status === 'issued') ? nextHandoverVersionLabel(packs) : '1.0';
}

/** A pack's file name: packs for different sites can have the same version, so it says which sites. */
export function handoverFileName(siteCodes: readonly string[] | null | undefined, versionLabel: string): string {
  const codes = [...(siteCodes ?? [])].sort();
  const scope = codes.length === 0 ? '' : codes.length <= 3 ? `-${codes.join('-').replace(/[^A-Za-z0-9-]/g, '')}` : `-${codes.length}-sites`;
  return `service-handover${scope}-v${versionLabel}.docx`;
}

/** Approvals & Sign-Off, entered when a pack is issued. */
export interface HandoverApproval {
  company: string;
  /** name and title, e.g. "Alex Example, Contoso & Partners, Director EMEA" */
  name: string;
  /** YYYY-MM-DD */
  date: string;
}

/** One row of the pack's Document Control table. */
export interface HandoverHistoryRow {
  author: string;
  version: string;
  date: string;
  comments: string;
}

/**
 * A port range on a pack's sites whose port is not marked complete (bug report "Service Handover - Pre creation check"): the pack
 * describes the service as handed over, so before a draft is made the engineer is asked whether to go ahead with numbers still to port.
 */
export interface HandoverUnportedRange {
  sitecode: string;
  siteName: string | null;
  start: string;
  end: string;
  /** where the port has got to, in words (portStageText in number-port-carrier.ts) */
  stage: string;
}

