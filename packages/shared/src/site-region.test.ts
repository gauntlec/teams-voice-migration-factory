import { describe, expect, it } from 'vitest';
import { asSiteRegion } from './domain';
import { discoverySiteOverviewSchema, discoverySiteSchema } from './dto';

describe('site region', () => {
  it('only accepts AMER, EMEA or APAC (or blank) when a site is created or edited', () => {
    for (const region of ['AMER', 'EMEA', 'APAC', '']) {
      expect(discoverySiteSchema.safeParse({ sitecode: 'LON01', region }).success).toBe(true);
    }
    expect(discoverySiteSchema.safeParse({ sitecode: 'LON01', region: 'Europe' }).success).toBe(false);
    expect(discoverySiteSchema.safeParse({ sitecode: 'LON01' }).success).toBe(true);
  });

  it('uses the same choices on the Site Overview', () => {
    expect(discoverySiteOverviewSchema.safeParse({ region: 'APAC' }).success).toBe(true);
    expect(discoverySiteOverviewSchema.safeParse({ region: 'Europe' }).success).toBe(false);
  });

  it('shows older free-text values as not set', () => {
    expect(asSiteRegion('emea')).toBe('EMEA');
    expect(asSiteRegion(' APAC ')).toBe('APAC');
    expect(asSiteRegion('Kansas')).toBe('');
    expect(asSiteRegion(null)).toBe('');
  });
});
