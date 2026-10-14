import { describe, expect, it } from 'vitest';
import { knowledgeCreateSchema, knowledgeMatches, knowledgeScore, knowledgeTokens, type KnowledgeSnippet } from './incident-knowledge';

const snip = (over: Partial<KnowledgeSnippet> = {}): KnowledgeSnippet => ({ id: 'a', title: 'One-way audio on wifi handsets', category: 'call_quality', subcategory: 'one_way_audio', symptoms: 'Caller can hear but the other side hears nothing, only on the wifi network', fix: 'Open UDP 3478-3481 to the Teams media range', customer_text: '', helpful: 0, not_helpful: 0, ...over });

describe('matching', () => {
  it('reads meaningful words only', () => {
    expect([...knowledgeTokens('The phones in the Reading office have no audio on WiFi calls')].sort()).toEqual(['audio', 'office', 'reading', 'wifi']);
  });
  it('scores category, sub-category and shared words, and finds the right snippet first', () => {
    const q = { category: 'call_quality', subcategory: 'one_way_audio', text: 'Nobody hears us on the wifi network at Reading' };
    expect(knowledgeScore(snip(), q)).toBeGreaterThanOrEqual(8);
    const other = snip({ id: 'b', title: 'Echo on headsets', subcategory: 'echo', symptoms: 'Echo for the caller' });
    expect(knowledgeMatches([other, snip()], q).map((s) => s.id)).toEqual(['a', 'b']);
  });
  it('shows nothing for a different category unless real words are shared', () => {
    expect(knowledgeMatches([snip()], { category: 'users', text: 'My dial pad has gone' })).toEqual([]);
    expect(knowledgeMatches([snip()], { category: 'devices', text: 'The handset on the wifi network has no audio and one-way hearing' }).length).toBe(1);
  });
  it('is helped by "this helped" and buried by "not helpful"', () => {
    const q = { category: 'call_quality', subcategory: 'one_way_audio', text: '' };
    expect(knowledgeScore(snip({ helpful: 3 }), q)).toBeGreaterThan(knowledgeScore(snip(), q));
    expect(knowledgeMatches([snip({ not_helpful: 5, helpful: 1 })], q)).toEqual([]);
    expect(knowledgeMatches([snip({ not_helpful: 2, helpful: 1 })], q)).toHaveLength(1);
  });
  it('limits and orders', () => {
    const many = [1, 2, 3, 4, 5].map((n) => snip({ id: String(n), helpful: n }));
    expect(knowledgeMatches(many, { category: 'call_quality', subcategory: 'one_way_audio' }, 3).map((s) => s.id)).toEqual(['5', '4', '3']);
  });
});

describe('input', () => {
  it('needs a fix and a known category', () => {
    expect(knowledgeCreateSchema.safeParse({ title: 'Wifi audio', category: 'call_quality', fix: 'Open UDP' }).success).toBe(true);
    expect(knowledgeCreateSchema.safeParse({ title: 'Wifi audio', category: 'nope', fix: 'Open UDP' }).success).toBe(false);
    expect(knowledgeCreateSchema.safeParse({ title: 'Wifi audio', category: 'call_quality', fix: '' }).success).toBe(false);
  });
});
