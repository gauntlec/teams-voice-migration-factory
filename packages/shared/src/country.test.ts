import { describe, expect, it } from 'vitest';
import { countryLabel, countryToIso, usageLocationMismatch } from './country';

describe('countryToIso', () => {
  it('reads the names and short forms people type', () => {
    expect(countryToIso('United Kingdom')).toBe('GB');
    expect(countryToIso('UK')).toBe('GB');
    expect(countryToIso('England')).toBe('GB');
    expect(countryToIso('USA')).toBe('US');
    expect(countryToIso('United States')).toBe('US');
    expect(countryToIso(' united states of america ')).toBe('US');
    expect(countryToIso('Germany')).toBe('DE');
    expect(countryToIso('france')).toBe('FR');
  });
  it('accepts a two-letter code that is a real country', () => {
    expect(countryToIso('gb')).toBe('GB');
    expect(countryToIso('US')).toBe('US');
  });
  it('returns null rather than guessing', () => {
    expect(countryToIso('')).toBeNull();
    expect(countryToIso(null)).toBeNull();
    expect(countryToIso('Narnia')).toBeNull();
    expect(countryToIso('ZZ')).toBeNull();
  });
  it('names a code', () => {
    expect(countryLabel('GB')).toBe('United Kingdom');
  });
});

describe('usageLocationMismatch', () => {
  it('is null when the usage location is the site\'s country, however the country was typed', () => {
    expect(usageLocationMismatch('GB', 'United Kingdom')).toBeNull();
    expect(usageLocationMismatch('gb', 'UK')).toBeNull();
    expect(usageLocationMismatch('US', 'USA')).toBeNull();
  });
  it('reports a different country', () => {
    expect(usageLocationMismatch('US', 'UK')).toEqual({ live: 'US', expected: 'GB', country: 'UK' });
  });
  it('reports a user with no usage location', () => {
    expect(usageLocationMismatch(null, 'UK')).toEqual({ live: null, expected: 'GB', country: 'UK' });
    expect(usageLocationMismatch('', 'UK')?.live).toBeNull();
  });
  it('has nothing to compare when the site country is missing or not recognised', () => {
    expect(usageLocationMismatch('US', null)).toBeNull();
    expect(usageLocationMismatch('US', '')).toBeNull();
    expect(usageLocationMismatch('US', 'Narnia')).toBeNull();
  });
});
