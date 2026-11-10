import { describe, expect, it } from 'vitest';
import { HANDOVER_SECTIONS } from './domain';
import { handoverGenerateSchema, handoverNoteSchema } from './dto';
import { HANDOVER_NOTE_EMPTY, handoverFileName, handoverScopeLabel, issuedHandoverVersionLabel, nextHandoverVersionLabel, sameHandoverScope, noteSectionContent, selectSections, noteLine, outstandingActionsContent } from './handover';

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
    const c = noteSectionContent('paging', [
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

describe('notes written for the pack', () => {
  it('reads "## " as a numbered sub-heading and "- " as a bullet', () => {
    expect(noteLine('## Welcome Document')).toEqual({ kind: 'heading', text: 'Welcome Document' });
    expect(noteLine('- David Mead - david.mead@parker.com')).toEqual({ kind: 'bullet', text: 'David Mead - david.mead@parker.com' });
    expect(noteLine('Plain text - with a dash')).toEqual({ kind: 'text', text: 'Plain text - with a dash' });
  });

  it('turns the open outstanding actions into numbered actions with an owner, a site’s prefixed with its code', () => {
    expect(
      outstandingActionsContent([
        { sitecode: null, description: 'Test 933 on the lobby phone', owner: 'AT&T' },
        { sitecode: null, description: 'Submit a ticket for the paging amp ', owner: '' },
        { sitecode: 'FSD02D', description: 'Fix the diagram', owner: 'AT&T' },
      ]),
    ).toEqual({
      kind: 'blocks',
      blocks: [
        {
          kind: 'actions',
          caption: 'Outstanding Actions Table',
          items: [
            { description: 'Test 933 on the lobby phone', owner: 'AT&T' },
            { description: 'Submit a ticket for the paging amp', owner: '' },
            { description: 'FSD02D: Fix the diagram', owner: 'AT&T' },
          ],
        },
      ],
    });
    expect(outstandingActionsContent([])).toEqual({ kind: 'blocks', blocks: [{ kind: 'text', text: 'There are no outstanding actions.' }] });
  });
});

describe('handover pack versions (major.minor)', () => {
  const d = (version_label: string | null) => ({ status: 'draft' as const, version_label });
  const i = (version_label: string | null) => ({ status: 'issued' as const, version_label });
  it('numbers drafts 0.1, 0.2 until the first issue, then 1.1, 1.2', () => {
    expect(nextHandoverVersionLabel([])).toBe('0.1');
    expect(nextHandoverVersionLabel([d('0.1'), d('0.2')])).toBe('0.3');
    expect(nextHandoverVersionLabel([d('0.1'), i('1.0')])).toBe('1.1');
    expect(nextHandoverVersionLabel([d('0.1'), i('1.0'), d('1.1'), i('1.2')])).toBe('1.3');
  });
  it('issues a 0.x draft as 1.0 and keeps a 1.x number', () => {
    expect(issuedHandoverVersionLabel('0.3', [d('0.1'), d('0.2'), d('0.3')])).toBe('1.0');
    expect(issuedHandoverVersionLabel(null, [])).toBe('1.0');
    expect(issuedHandoverVersionLabel('1.2', [i('1.0'), d('1.2')])).toBe('1.2');
  });
  it('never issues a second 1.0: a later 0.x draft for the same sites takes the next number', () => {
    expect(issuedHandoverVersionLabel('0.2', [i('1.0'), d('0.2')])).toBe('1.1');
    expect(issuedHandoverVersionLabel('0.2', [i('1.0'), d('0.2'), d('1.1')])).toBe('1.2');
  });
  it('carries on from a site\'s highest number, from when packs were numbered across the customer', () => {
    expect(nextHandoverVersionLabel([d('0.3'), d('0.7')])).toBe('0.8');
    expect(nextHandoverVersionLabel([d('1.2')])).toBe('1.3');
  });
  it('treats the same sites in any order as the same pack, and all sites as its own', () => {
    expect(sameHandoverScope(['b', 'a'], ['a', 'b'])).toBe(true);
    expect(sameHandoverScope(['a'], ['a', 'b'])).toBe(false);
    expect(sameHandoverScope(['a'], [])).toBe(false);
    expect(sameHandoverScope(undefined, [])).toBe(true);
  });
  it('names the sites in the file name', () => {
    expect(handoverFileName(['FSD02D'], '0.1')).toBe('service-handover-FSD02D-v0.1.docx');
    expect(handoverFileName([], '1.0')).toBe('service-handover-v1.0.docx');
    expect(handoverFileName(['A', 'B', 'C', 'D'], '0.2')).toBe('service-handover-4-sites-v0.2.docx');
  });
});
