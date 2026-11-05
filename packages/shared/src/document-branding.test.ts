import { describe, expect, it } from 'vitest';
import { documentBrandingSource, documentPalette, VOXSHIFT_DOCUMENT_PALETTE } from './document-branding';

describe('whose branding documents carry', () => {
  const base = { mspFeatureOn: true, mspId: 'm1', choice: 'msp' as const, customerHasBranding: true, mspHasBranding: true };
  it('follows the choice when an MSP looks after the customer', () => {
    expect(documentBrandingSource(base)).toBe('msp');
    expect(documentBrandingSource({ ...base, choice: 'customer' })).toBe('customer');
  });
  it('uses the customer’s branding when there is no MSP, or the MSP feature is off', () => {
    expect(documentBrandingSource({ ...base, mspId: null })).toBe('customer');
    expect(documentBrandingSource({ ...base, mspFeatureOn: false })).toBe('customer');
  });
  it('falls back to Voxshift, never to the other party, when the chosen one has no branding', () => {
    expect(documentBrandingSource({ ...base, mspHasBranding: false })).toBe('voxshift');
    expect(documentBrandingSource({ ...base, choice: 'customer', customerHasBranding: false })).toBe('voxshift');
    expect(documentBrandingSource({ ...base, mspId: null, customerHasBranding: false })).toBe('voxshift');
  });
});

describe('document colours', () => {
  it('keeps Voxshift’s palette exactly, and builds others from the accent', () => {
    expect(documentPalette(null)).toBe(VOXSHIFT_DOCUMENT_PALETTE);
    expect(documentPalette('#4657d2')).toBe(VOXSHIFT_DOCUMENT_PALETTE);
    const p = documentPalette('#D83B01');
    expect(p.brand).toBe('D83B01');
    expect(Object.values(p).every((v) => /^[0-9A-F]{6}$/.test(v))).toBe(true);
    expect(p.calloutBg).not.toBe(p.brand);
  });
});
