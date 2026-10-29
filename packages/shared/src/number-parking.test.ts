import { describe, expect, it } from 'vitest';
import { parkBlockReason, unparkBlockReason } from './number-parking';

describe('parking a number', () => {
  it('parks a spare number', () => {
    expect(parkBlockReason({ e164: '+1', status: 'available', live_status: null })).toBeNull();
  });
  it('refuses a number in use, here or in Teams', () => {
    expect(parkBlockReason({ e164: '+1', status: 'assigned' })).toMatch(/in use/);
    expect(parkBlockReason({ e164: '+1', status: 'available', live_status: 'UserAssigned' })).toMatch(/in use/);
  });
  it('refuses a reserved or already parked number', () => {
    expect(parkBlockReason({ e164: '+1', status: 'reserved' })).toMatch(/reserved/);
    expect(parkBlockReason({ e164: '+1', status: 'parked' })).toMatch(/already parked/);
  });
  it('only unparks a parked number', () => {
    expect(unparkBlockReason({ e164: '+1', status: 'parked' })).toBeNull();
    expect(unparkBlockReason({ e164: '+1', status: 'available' })).toMatch(/not parked/);
  });
});
