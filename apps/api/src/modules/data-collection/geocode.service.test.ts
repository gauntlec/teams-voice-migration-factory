import { describe, expect, it } from 'vitest';
import { geocodeAttempts } from './geocode.service';

describe('geocodeAttempts', () => {
  it('still finds a US street when the town is misspelled, by trying street + state + ZIP without the town', () => {
    const qs = geocodeAttempts('300 Marcus Boulevard, Hauppage, NY, 11788').map((a) => a.q);
    expect(qs).toContain('300 Marcus Boulevard, NY 11788');
  });

  it('tries the exact-street queries first, then the approximate ones', () => {
    const attempts = geocodeAttempts('300 Marcus Boulevard, Hauppage, NY, 11788');
    expect(attempts.map((a) => a.q)).toEqual([
      '300 Marcus Boulevard, Hauppage, NY 11788',
      '300 Marcus Boulevard, Hauppage, NY, 11788',
      '300 Marcus Boulevard, NY 11788',
      'Hauppage, NY 11788',
      'NY 11788',
    ]);
    expect(attempts.map((a) => a.approximate)).toEqual([false, false, false, true, true]);
  });

  it('expands street abbreviations and drops unit numbers as before', () => {
    expect(geocodeAttempts('300 Marcus Blvd Suite 5, Hauppauge, NY 11788')[0].q).toBe('300 Marcus Boulevard, Hauppauge, NY 11788');
  });

  it('does not add US-only queries for an address with no state and ZIP', () => {
    const qs = geocodeAttempts('10 Downing Street, London, SW1A 2AA').map((a) => a.q);
    expect(qs).toEqual(['10 Downing Street, London, SW1A 2AA', 'London, SW1A 2AA']);
  });
});
