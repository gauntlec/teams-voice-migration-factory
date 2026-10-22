import { describe, expect, it } from 'vitest';
import { isCoordinateText, parseCoordinatePair } from './coordinates';

describe('parseCoordinatePair', () => {
  it('splits a pair copied from Google Maps', () => {
    expect(parseCoordinatePair('40.8209442, -73.2492744')).toEqual({ latitude: '40.8209442', longitude: '-73.2492744' });
  });
  it('accepts no space, a space only, brackets, degree signs and surrounding whitespace', () => {
    expect(parseCoordinatePair('40.82,-73.25')).toEqual({ latitude: '40.82', longitude: '-73.25' });
    expect(parseCoordinatePair('51.5 -0.12')).toEqual({ latitude: '51.5', longitude: '-0.12' });
    expect(parseCoordinatePair(' (40.82°, -73.25°) \n')).toEqual({ latitude: '40.82', longitude: '-73.25' });
    expect(parseCoordinatePair('-33.8688, 151.2093')).toEqual({ latitude: '-33.8688', longitude: '151.2093' });
  });
  it('rejects a single number, out-of-range values and other text', () => {
    expect(parseCoordinatePair('40.82')).toBeNull();
    expect(parseCoordinatePair('95.1, 10')).toBeNull();
    expect(parseCoordinatePair('40.8, 181')).toBeNull();
    expect(parseCoordinatePair('300 Marcus Boulevard, NY 11788')).toBeNull();
    expect(parseCoordinatePair('')).toBeNull();
  });
});

describe('isCoordinateText', () => {
  it('allows what is typed on the way to a number, and nothing else', () => {
    for (const ok of ['', '-', '40', '40.', '-73.2492744', ' 40.5 ']) expect(isCoordinateText(ok)).toBe(true);
    for (const bad of ['4,0', '40.8.2', 'abc', '40.8 -73.2']) expect(isCoordinateText(bad)).toBe(false);
  });
});
