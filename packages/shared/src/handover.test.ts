import { describe, expect, it } from 'vitest';
import { HANDOVER_SECTIONS } from './domain';
import { handoverGenerateSchema, handoverNoteSchema } from './dto';
import { HANDOVER_NOTE_EMPTY, handoverScopeLabel, noteSectionContent, selectSections } from './handover';

describe('noteSectionContent', () => {
  it('shows the empty-state text when there is no note', () => {
    expect(noteSectionContent('paging', [])).toEqual({ kind: 'placeholder', note: HANDOVER_NOTE_EMPTY.paging });
    expect(noteSectionContent('paging', [{ sitecode: null, body: '   \n ' }])).toEqual({ kind: 'placeholder', note: HANDOVER_NOTE_EMPTY.paging });
  });

  it('renders a single all-sites note as plain paragraphs, one per line', () => {
    const c = noteSectionContent('service_support_model', [{ sitecode: null, body: 'Tier 1: customer service desk\r\n\r\nTier 2: Voxshift' }]);
    expect(c).toEqual({ kind: 'paragraphs', paragraphs: ['Tier 1: customer service desk', 'Tier 2: Voxshift'] });
  });

  it('labels notes by site once any site-specific note exists, all-sites first then by site code', () => {
    const c = noteSectionContent('outstanding_actions', [
      { sitecode: 'LON02', body: 'Port the DDI range' },
      { sitecode: null, body: 'Retire the old PBX' },
      { sitecode: 'DAL01', body: 'Fit the paging amp' },
    ]);
    expect(c).toEqual({
      kind: 'paragraphs',
      paragraphs: ['All sites:', 'Retire the old PBX', 'DAL01:', 'Fit the paging amp', 'LON02:', 'Port the DDI range'],
    });
  });

  it('ignores blank notes when mixing with real ones', () => {
    const c = noteSectionContent('paging', [{ sitecode: 'DAL01', body: '' }, { sitecode: null, body: 'Bogen system' }]);
    expect(c).toEqual({ kind: 'paragraphs', paragraphs: ['Bogen system'] });
  });
});

describe('selectSections', () => {
  it('returns every section when none are chosen', () => {
    expect(selectSections(HANDOVER_SECTIONS)).toHaveLength(HANDOVER_SECTIONS.length);
    expect(selectSections(HANDOVER_SECTIONS, [])).toHaveLength(HANDOVER_SECTIONS.length);
  });

  it('keeps template order, whatever order the keys were chosen in', () => {
    const picked = selectSections(HANDOVER_SECTIONS, ['call_queues', 'site_information', 'phone_numbers']);
    expect(picked.map((s) => s.key)).toEqual(['site_information', 'phone_numbers', 'call_queues']);
  });

  it('drops unknown keys', () => {
    expect(selectSections(HANDOVER_SECTIONS, ['nope'])).toEqual([]);
  });
});

describe('handoverScopeLabel', () => {
  it('says All sites when no site is chosen', () => {
    expect(handoverScopeLabel(null)).toBe('All sites');
    expect(handoverScopeLabel([])).toBe('All sites');
  });
  it('lists chosen site codes in order', () => {
    expect(handoverScopeLabel(['LON02', 'DAL01'])).toBe('DAL01, LON02');
  });
});

describe('handover request schemas', () => {
  const id = '11111111-2222-3333-4444-555555555555';

  it('accepts no body, and a scoped body', () => {
    expect(handoverGenerateSchema.parse(undefined)).toEqual({});
    expect(handoverGenerateSchema.parse({ siteIds: [id], sectionKeys: ['paging'], notes: ' hi ' })).toEqual({ siteIds: [id], sectionKeys: ['paging'], notes: 'hi' });
  });

  it('rejects an unknown section or a non-uuid site', () => {
    expect(handoverGenerateSchema.safeParse({ sectionKeys: ['bogus'] }).success).toBe(false);
    expect(handoverGenerateSchema.safeParse({ siteIds: ['not-a-uuid'] }).success).toBe(false);
  });

  it('only lets the four note-backed sections take notes', () => {
    expect(handoverNoteSchema.safeParse({ sectionKey: 'paging', siteId: null, body: 'x' }).success).toBe(true);
    expect(handoverNoteSchema.safeParse({ sectionKey: 'phone_numbers', body: 'x' }).success).toBe(false);
    expect(handoverNoteSchema.safeParse({ sectionKey: 'paging', body: 'x'.repeat(20001) }).success).toBe(false);
  });
});
