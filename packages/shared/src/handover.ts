import { HANDOVER_SECTIONS, type HandoverNoteSection } from './domain';

/**
 * What one Handover section holds, as stored in handover_sections.content and
 * rendered by both the .docx builder and the in-app preview.
 */
export type HandoverSectionContent =
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'paragraphs'; paragraphs: string[] }
  | { kind: 'placeholder'; note: string };

/** Shown for a note-backed section until someone writes a note for it. */
export const HANDOVER_NOTE_EMPTY: Record<HandoverNoteSection, string> = {
  service_support_model: 'Not yet captured in Voxshift — agree the ongoing support model with the customer and add it to this section manually.',
  paging: 'No paging system data is currently collected by Voxshift.',
  teams_configuration: 'Not yet captured in Voxshift — record tenant-wide Microsoft Teams configuration decisions in this section manually.',
  outstanding_actions: 'No outstanding actions recorded for this handover.',
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
