import { describe, expect, it } from 'vitest';
import { handsetModelKey, summariseHandsets } from './handsets';

describe('handsetModelKey', () => {
  it('treats case and spacing as the same model', () => {
    expect(handsetModelKey('  Poly  CCX 400 ')).toBe('poly ccx 400');
    expect(handsetModelKey('poly ccx 400')).toBe('poly ccx 400');
    expect(handsetModelKey(null)).toBe('');
    expect(handsetModelKey('   ')).toBe('');
  });
});

describe('summariseHandsets', () => {
  it('counts users and common area phones per model, whatever the spelling', () => {
    const r = summariseHandsets(['Poly CCX 400', 'poly ccx 400', 'Yealink T54W', null, ''], ['Poly CCX 400', 'AudioCodes C450HD'], []);
    expect(r.models.map((m) => [m.model, m.users, m.caps, m.total])).toEqual([
      ['AudioCodes C450HD', 0, 1, 1],
      ['Poly CCX 400', 2, 1, 3], // spelling used most often
      ['Yealink T54W', 1, 0, 1],
    ]);
  });

  it('a model with nothing recorded is not ordered; recorded stages and totals follow', () => {
    const r = summariseHandsets(['A1', 'A1', 'B2', 'C3'], [], [
      { model_key: 'a1', status: 'ordered', updated_by: 'Pat', updated_at: '2026-10-28T10:00:00Z' },
      { model_key: 'b2', status: 'installed', updated_by: null, updated_at: null },
    ]);
    const byModel = Object.fromEntries(r.models.map((m) => [m.model, m.status]));
    expect(byModel).toEqual({ A1: 'ordered', B2: 'installed', C3: 'not_ordered' });
    expect(r.totals).toEqual({ not_ordered: 1, ordered: 2, delivered: 0, in_tooling: 0, installed: 1 });
    expect(r.models.find((m) => m.model === 'A1')).toMatchObject({ updatedBy: 'Pat', updatedAt: '2026-10-28T10:00:00.000Z' });
  });

  it('ignores a stored stage it does not know, and tracking for a model no longer on the site', () => {
    const r = summariseHandsets(['A1'], [], [
      { model_key: 'a1', status: 'bogus', updated_by: null, updated_at: null },
      { model_key: 'gone', status: 'ordered', updated_by: null, updated_at: null },
    ]);
    expect(r.models).toHaveLength(1);
    expect(r.models[0]!.status).toBe('not_ordered');
  });
});
