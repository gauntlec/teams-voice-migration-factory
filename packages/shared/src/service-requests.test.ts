import { describe, expect, it } from 'vitest';
import { createServiceRequestSchema, srDetailsSchema } from './dto';
import { SR_TYPES, SR_TYPE_DEFS, canMoveSr, nextSrStatus, srDetailLines, srReference, type SrType } from './service-requests';

const SITE = '11111111-2222-3333-4444-555555555555';

/** A valid details object for every type, so each form is exercised end to end. */
const VALID: Record<SrType, Record<string, unknown>> = {
  new_site: { sitecode: 'LON02', name: 'London', address: '1 High St, London' },
  new_user: { display_name: 'Jo Bloggs', upn: 'jo@contoso.com', number: 'New number', voicemail: true },
  new_phone_numbers: { quantity: 10, purpose: 'Users' },
  new_common_area_phone: { display_name: 'Reception', number: 'No number' },
  new_call_queue: { name: 'Sales', agents: ['a@contoso.com', 'b@contoso.com'], number: 'New number' },
  new_auto_attendant: { name: 'Main line', greeting: 'Thanks for calling', number: 'Keep an existing number' },
  other: { description: 'Change our caller ID' },
};

describe('workflow', () => {
  it('moves forward one step at a time: new, planned, built, deployed', () => {
    expect(nextSrStatus('new')).toBe('planned');
    expect(nextSrStatus('planned')).toBe('built');
    expect(nextSrStatus('built')).toBe('deployed');
    expect(nextSrStatus('deployed')).toBeNull();
    expect(nextSrStatus('cancelled')).toBeNull();
  });

  it('allows only the next step or a cancel while open', () => {
    expect(canMoveSr('new', 'planned')).toBe(true);
    expect(canMoveSr('new', 'built')).toBe(false); // can't skip planning
    expect(canMoveSr('built', 'planned')).toBe(false); // no going back
    expect(canMoveSr('planned', 'cancelled')).toBe(true);
    expect(canMoveSr('deployed', 'cancelled')).toBe(false); // finished requests stay finished
    expect(canMoveSr('cancelled', 'planned')).toBe(false);
  });

  it('formats a reference', () => {
    expect(srReference(7)).toBe('SR-0007');
    expect(srReference(12345)).toBe('SR-12345');
  });
});

describe('request validation', () => {
  it.each(SR_TYPES)('accepts a complete %s request', (type) => {
    const r = createServiceRequestSchema.safeParse({ type, title: 'A request', siteId: SR_TYPE_DEFS[type].needsSite ? SITE : null, details: VALID[type] });
    expect(r.success, JSON.stringify(!r.success && r.error.issues)).toBe(true);
  });

  it('defaults the priority to normal', () => {
    const r = createServiceRequestSchema.parse({ type: 'other', title: 'A request', details: VALID.other });
    expect(r.priority).toBe('normal');
  });

  it('needs a site for everything except a new site and "something else"', () => {
    const r = createServiceRequestSchema.safeParse({ type: 'new_user', title: 'A user', details: VALID.new_user });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues.some((i) => i.path.join('.') === 'siteId')).toBe(true);
    expect(createServiceRequestSchema.safeParse({ type: 'new_site', title: 'A site', details: VALID.new_site }).success).toBe(true);
  });

  it('reports a missing required field against that field', () => {
    const r = createServiceRequestSchema.safeParse({ type: 'new_user', title: 'A user', siteId: SITE, details: { upn: 'jo@contoso.com', number: 'New number' } });
    expect(!r.success && r.error.issues.map((i) => i.path.join('.'))).toContain('details.display_name');
  });

  it('rejects an option that is not in the list, and fields the form does not have', () => {
    expect(srDetailsSchema('new_user').safeParse({ ...VALID.new_user, number: 'Two please' }).success).toBe(false);
    expect(srDetailsSchema('new_user').safeParse({ ...VALID.new_user, sneaky: 'x' }).success).toBe(false);
  });

  it('needs at least one agent for a call queue, and a sensible number quantity', () => {
    expect(srDetailsSchema('new_call_queue').safeParse({ ...VALID.new_call_queue, agents: [] }).success).toBe(false);
    expect(srDetailsSchema('new_phone_numbers').safeParse({ quantity: 0, purpose: 'Users' }).success).toBe(false);
    expect(srDetailsSchema('new_phone_numbers').safeParse({ quantity: 5000, purpose: 'Users' }).success).toBe(false);
  });

  it('trims text and treats an empty date as not given', () => {
    const r = srDetailsSchema('new_site').parse({ ...VALID.new_site, name: '  London  ', go_live: '' });
    expect(r.name).toBe('London');
    expect(r.go_live).toBeUndefined();
  });
});

describe('srDetailLines', () => {
  it('lists answered fields in form order with readable values', () => {
    expect(srDetailLines('new_call_queue', { ...VALID.new_call_queue, notes: '' })).toEqual([
      { label: 'Queue name', value: 'Sales' },
      { label: 'Who should answer (sign-in addresses)', value: 'a@contoso.com, b@contoso.com' },
      { label: 'Phone number', value: 'New number' },
    ]);
    expect(srDetailLines('new_user', VALID.new_user).find((l) => l.label === 'Voicemail')?.value).toBe('Yes');
  });
});
