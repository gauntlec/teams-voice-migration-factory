import { describe, expect, it } from 'vitest';
import { createServiceRequestSchema, setSiteModeSchema, srDetailsSchema } from './dto';
import { SR_TYPES, SR_TYPE_DEFS, canMoveSr, countryName, srCanReopen, srMoveKind, srStatusLabel, nextSrStatus, srDetailLines, srReference, type SrType } from './service-requests';

const SITE = '11111111-2222-3333-4444-555555555555';
const CQ = '22222222-3333-4444-5555-666666666666';
const RANGE = '33333333-4444-5555-6666-777777777777';
const jo = { upn: 'jo@contoso.com', name: 'Jo Bloggs' };
const al = { upn: 'al@contoso.com', name: 'Al Smith' };

/** A valid details object for every type, so each form is exercised end to end. */
const VALID: Record<SrType, Record<string, unknown>> = {
  new_site: { sitecode: 'LON02', name: 'London', address: '1 High St, London', country: 'GB', contact: jo },
  new_user: { user: jo, number: 'New number', new_number: '+442079460001', voicemail: true },
  new_phone_numbers: { quantity: 10, purpose: 'Users', range: { id: RANGE, label: '+44 20 7946 0000–0099' } },
  new_common_area_phone: { display_name: 'Reception', device_model: 'Poly CCX 400', number: 'No number' },
  new_call_queue: {
    name: 'Sales',
    agents: [jo, al],
    unanswered_after: '1 minute',
    unanswered: { kind: 'voicemail', label: 'Voicemail' },
    number: 'Keep an existing number',
    existing_number: '+442079460002',
  },
  new_auto_attendant: {
    name: 'Main line',
    greeting: 'Thanks for calling',
    menu: [
      { key: '1', target: { kind: 'call_queue', id: CQ, label: 'Sales queue' } },
      { key: '0', target: { kind: 'person', upn: 'jo@contoso.com', label: 'Jo Bloggs' } },
    ],
    after_hours: { kind: 'disconnect', label: 'Disconnect' },
    number: 'No number',
  },
  change_user: { user: jo, changes: ['Phone number', 'Voicemail'], new_number: '+442079460003', voicemail: 'Turn off' },
  change_call_queue: { queue: { id: CQ, label: 'Sales' }, changes: ['Add people', 'How calls are shared out'], add_agents: [al], routing: 'Round robin' },
  change_auto_attendant: {
    auto_attendant: { id: CQ, label: 'Main line' },
    changes: ['Holiday closure'],
    holiday_name: 'Christmas',
    holiday_from: '2026-12-24',
    holiday_to: '2026-12-27',
  },
  remove_user: { user: jo, leaving_date: '2026-11-30', number_after: 'Release it so it can be reused' },
  remove_common_area_phone: { phone: { id: CQ, label: 'Lobby phone' }, number_after: 'Keep it for a replacement' },
  other: { description: 'Change our caller ID' },
};

describe('change requests', () => {
  it('only asks for what is ticked', () => {
    const r = srDetailsSchema('change_user').safeParse({ user: jo, changes: ['Voicemail'], voicemail: 'Turn on', new_number: '+442079460003' });
    expect(r.success && r.data).toEqual({ user: jo, changes: ['Voicemail'], voicemail: 'Turn on' });
  });
  it('requires what a tick needs', () => {
    const r = srDetailsSchema('change_call_queue').safeParse({ queue: { id: CQ, label: 'Sales' }, changes: ['Remove people'] });
    expect(r.success).toBe(false);
  });
  it('rejects an option that is not on the list', () => {
    expect(srDetailsSchema('change_user').safeParse({ user: jo, changes: ['Teleport'] }).success).toBe(false);
  });
});

describe('workflow', () => {
  it('moves forward one step at a time: new, planned, built, deployed', () => {
    expect(nextSrStatus('new')).toBe('planned');
    expect(nextSrStatus('planned')).toBe('built');
    expect(nextSrStatus('built')).toBe('deployed');
    expect(nextSrStatus('deployed')).toBeNull();
    expect(nextSrStatus('cancelled')).toBeNull();
  });

  it('allows the next step, cancel/decline while open, send back and reopen', () => {
    expect(canMoveSr('new', 'planned')).toBe(true);
    expect(canMoveSr('new', 'built')).toBe(false);
    expect(canMoveSr('planned', 'cancelled')).toBe(true);
    expect(canMoveSr('deployed', 'cancelled')).toBe(false);
    expect(canMoveSr('cancelled', 'planned')).toBe(false);
    expect(srMoveKind('built', 'planned')).toBe('send_back');
    expect(srMoveKind('deployed', 'planned')).toBe('reopen');
    expect(srMoveKind('planned', 'declined')).toBe('decline');
    expect(srMoveKind('deployed', 'declined')).toBe(null);
    expect(srMoveKind('declined', 'planned')).toBe(null);
    expect(srMoveKind('planned', 'new')).toBe(null);
  });

  it('reopens only within the window', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    expect(srCanReopen('deployed', '2026-10-10T12:00:00Z', now)).toBe(true);
    expect(srCanReopen('deployed', '2026-10-01T12:00:00Z', now)).toBe(false);
    expect(srCanReopen('planned', '2026-10-19T12:00:00Z', now)).toBe(false);
    expect(srCanReopen('deployed', null, now)).toBe(false);
  });

  it('has plain customer-facing status names', () => {
    expect(srStatusLabel('built', false)).toBe('Ready to go live');
    expect(srStatusLabel('built', true)).toBe('Designed & built');
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

  it('needs a site for everything except a new site and "something else"', () => {
    const r = createServiceRequestSchema.safeParse({ type: 'new_user', title: 'A user', details: VALID.new_user });
    expect(!r.success && r.error.issues.some((i) => i.path.join('.') === 'siteId')).toBe(true);
    expect(createServiceRequestSchema.safeParse({ type: 'new_site', title: 'A site', details: VALID.new_site }).success).toBe(true);
  });

  it('asks for the new number only when a new number is wanted', () => {
    const schema = srDetailsSchema('new_user');
    expect(schema.safeParse({ user: jo, number: 'New number' }).success).toBe(false); // missing the number
    const r = schema.parse({ user: jo, number: 'No number', new_number: '+442079460001', existing_number: '+442079460002' });
    expect(r).toEqual({ user: jo, number: 'No number' }); // hidden fields are dropped
    expect(schema.parse({ user: jo, number: 'Keep an existing number', existing_number: '+442079460002' }).existing_number).toBe('+442079460002');
  });

  it('only accepts real-looking phone numbers and people', () => {
    const schema = srDetailsSchema('new_user');
    expect(schema.safeParse({ user: jo, number: 'New number', new_number: 'call me' }).success).toBe(false);
    expect(schema.safeParse({ user: { upn: 'not-an-address', name: 'Jo' }, number: 'No number' }).success).toBe(false);
  });

  it('checks targets: a queue needs its id, a person needs a sign-in address', () => {
    const cq = srDetailsSchema('new_call_queue');
    expect(cq.safeParse({ ...VALID.new_call_queue, unanswered: { kind: 'call_queue', label: 'Sales' } }).success).toBe(false);
    expect(cq.safeParse({ ...VALID.new_call_queue, unanswered: { kind: 'person', label: 'Jo' } }).success).toBe(false);
    expect(cq.safeParse({ ...VALID.new_call_queue, agents: [] }).success).toBe(false);
  });

  it('does not allow the same key twice in an auto attendant menu', () => {
    const t = { kind: 'disconnect', label: 'Disconnect' };
    expect(srDetailsSchema('new_auto_attendant').safeParse({ ...VALID.new_auto_attendant, menu: [{ key: '1', target: t }, { key: '1', target: t }] }).success).toBe(false);
  });

  it('only takes known countries, options and fields', () => {
    expect(srDetailsSchema('new_site').safeParse({ ...VALID.new_site, country: 'Narnia' }).success).toBe(false);
    expect(srDetailsSchema('new_user').safeParse({ ...VALID.new_user, number: 'Two please' }).success).toBe(false);
    expect(srDetailsSchema('new_user').safeParse({ ...VALID.new_user, sneaky: 'x' }).success).toBe(false);
  });

  it('trims text and drops blank optional answers', () => {
    const r = srDetailsSchema('new_site').parse({ ...VALID.new_site, name: '  London  ', go_live: '', notes: '   ' });
    expect(r.name).toBe('London');
    expect('go_live' in r).toBe(false);
    expect('notes' in r).toBe(false);
  });

  it('only accepts the two site modes', () => {
    expect(setSiteModeSchema.safeParse({ mode: 'operations' }).success).toBe(true);
    expect(setSiteModeSchema.safeParse({ mode: 'live' }).success).toBe(false);
  });
});

describe('srDetailLines', () => {
  it('shows people, targets, menus and countries by name, and skips hidden fields', () => {
    const cq = srDetailLines('new_call_queue', VALID.new_call_queue);
    expect(cq.find((l) => l.label === 'Who should answer')?.value).toBe('Jo Bloggs, Al Smith');
    expect(cq.find((l) => l.label === 'Then send the call to')?.value).toBe('Voicemail');
    expect(cq.find((l) => l.label === 'Number to keep')?.value).toBe('+442079460002');
    expect(cq.some((l) => l.label === 'New number')).toBe(false);
    expect(srDetailLines('new_auto_attendant', VALID.new_auto_attendant).find((l) => l.label === 'Menu options')?.value).toBe('1: Sales queue; 0: Jo Bloggs');
    expect(srDetailLines('new_site', VALID.new_site).find((l) => l.label === 'Country')?.value).toBe(countryName('GB'));
    expect(srDetailLines('new_user', VALID.new_user)[0]).toEqual({ label: 'Person', value: 'Jo Bloggs (jo@contoso.com)' });
  });
});
