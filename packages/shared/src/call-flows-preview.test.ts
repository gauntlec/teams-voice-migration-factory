// Call Flows (preview), step 2 of docs/CALL-FLOWS-WIZARD.md: what the screens and the save endpoint use - the input schema, the
// plain-words checks, the site's defaults and the review screen's words.
import { describe, expect, it } from 'vitest';
import {
  callFlowDefaultsForSite,
  fromCaptures,
  mapVisualGroups,
  newVisualGroup,
  saveVisualCallFlowSchema,
  toCaptures,
  visualCallFlowProblem,
  visualCallFlowSchema,
  visualFlowCreates,
  visualFlowGroups,
  visualFlowSummary,
  visualHoursWords,
  type VisualCallFlow,
} from './call-flows-visual';
import { AA_SUPPORTED_LANGUAGES, AA_TIME_ZONES } from './domain';
import { autoAttendantWizardAnswersSchema } from './wizard';

const GROUP_ID = '55555555-5555-4555-8555-555555555555';
const sales = { ...newVisualGroup('g1', 'Sales', 'en-GB'), people: ['jo@contoso.test'] };

const menuFlow: VisualCallFlow = {
  name: 'Main Line',
  languageId: 'en-GB',
  timeZoneId: 'GMT Standard Time',
  hours: { type: 'standard' },
  business: { greeting: 'Welcome to Contoso.', then: { kind: 'menu', options: [{ key: '1', label: 'Sales', then: sales }, { key: '2', label: 'Accounts', then: { kind: 'person', who: 'pat@contoso.test' } }] } },
  afterHours: { then: { kind: 'shared_voicemail', group: 'Main voicemail', groupId: GROUP_ID } },
};

const groupOnly: VisualCallFlow = { name: 'Help desk', languageId: 'en-US', timeZoneId: 'Eastern Standard Time', hours: { type: 'always' }, business: { then: { ...sales, name: 'Help desk' } } };

describe('input schema', () => {
  it('accepts what the screens build, and the save body around it', () => {
    expect(visualCallFlowSchema.safeParse(menuFlow).success).toBe(true);
    expect(visualCallFlowSchema.safeParse(groupOnly).success).toBe(true);
    const body = { site_id: GROUP_ID, phone_number_id: GROUP_ID, flow: groupOnly, straight_to_queue: true };
    expect(saveVisualCallFlowSchema.safeParse(body).success).toBe(true);
  });

  it('refuses a hang-up as a menu option and unknown fields', () => {
    const bad = { ...menuFlow, business: { then: { kind: 'menu', options: [{ key: '1', label: 'Bye', then: { kind: 'hangup' } }] } } };
    expect(visualCallFlowSchema.safeParse(bad).success).toBe(false);
    expect(visualCallFlowSchema.safeParse({ ...menuFlow, extra: 1 }).success).toBe(false);
  });
});

describe('checks in words', () => {
  it('passes a complete flow', () => {
    expect(visualCallFlowProblem(menuFlow)).toBeNull();
    expect(visualCallFlowProblem(groupOnly)).toBeNull();
  });

  it('names what is missing', () => {
    expect(visualCallFlowProblem({ ...menuFlow, name: ' ' })).toMatch(/name/);
    expect(visualCallFlowProblem({ ...groupOnly, business: { then: { ...sales, people: [''] } } })).toBe('When someone calls: add at least one person to the group "Sales".');
    expect(visualCallFlowProblem({ ...menuFlow, afterHours: undefined })).toBe('After hours: choose what happens.');
    expect(visualCallFlowProblem({ ...menuFlow, business: { then: { kind: 'menu', options: [] } } })).toBe('During business hours: add at least one menu option.');
    expect(visualCallFlowProblem({ ...groupOnly, business: { then: { kind: 'hangup' } } })).toBe('When someone calls: type the message callers hear before the call ends.');
    const twice = { ...menuFlow, business: { then: { kind: 'menu' as const, options: [{ key: '1', label: 'A', then: { kind: 'person' as const, who: 'a' } }, { key: '1', label: 'B', then: { kind: 'person' as const, who: 'b' } }] } } };
    expect(visualCallFlowProblem(twice)).toMatch(/button 1 is used twice/);
    expect(visualCallFlowProblem({ ...groupOnly, hours: { type: 'custom', weekly: { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] } } })).toMatch(/at least one day/);
  });
});

describe('saving', () => {
  it('keeps the voicemail group picked, both ways', () => {
    const c = toCaptures(mapVisualGroups(menuFlow, (g) => ({ ...g, id: GROUP_ID })), { attendantFlowId: GROUP_ID });
    const aa = c.top.capture.answers as Parameters<typeof autoAttendantWizardAnswersSchema.parse>[0] & { afterHoursFlow: { target: unknown } };
    expect(aa.afterHoursFlow.target).toEqual({ kind: 'voicemail', label: 'Main voicemail', groupId: GROUP_ID });
    expect(autoAttendantWizardAnswersSchema.safeParse(aa).success).toBe(true);
    const back = fromCaptures(c.top, c.queues);
    expect(back.ok && back.flow.afterHours).toEqual({ then: { kind: 'shared_voicemail', group: 'Main voicemail', groupId: GROUP_ID } });
  });

  it('gives every group a new id through mapVisualGroups, wherever it is', () => {
    expect(visualFlowGroups(menuFlow).map((g) => g.id)).toEqual(['g1']);
    const mapped = mapVisualGroups(menuFlow, (g) => ({ ...g, id: 'new' }));
    expect(visualFlowGroups(mapped).map((g) => g.id)).toEqual(['new']);
    expect(menuFlow.business.then.kind === 'menu' && menuFlow.business.then.options[0]!.then.kind === 'group' && menuFlow.business.then.options[0]!.then.id).toBe('g1');
  });
});

describe('defaults from the site', () => {
  it('reads the country, and the state in a US address', () => {
    expect(callFlowDefaultsForSite({ country: 'United Kingdom' })).toEqual({ languageId: 'en-GB', timeZoneId: 'GMT Standard Time' });
    expect(callFlowDefaultsForSite({ country: 'GB' })).toEqual({ languageId: 'en-GB', timeZoneId: 'GMT Standard Time' });
    expect(callFlowDefaultsForSite({ country: 'USA', address: '1 Main Street, Austin, TX 78701' })).toEqual({ languageId: 'en-US', timeZoneId: 'Central Standard Time' });
    expect(callFlowDefaultsForSite({ country: 'United States', address: '500 Pine St\nSeattle, WA 98101' }).timeZoneId).toBe('Pacific Standard Time');
    expect(callFlowDefaultsForSite({ country: 'US', address: 'Phoenix, AZ' }).timeZoneId).toBe('US Mountain Standard Time');
    expect(callFlowDefaultsForSite({ country: null, address: null })).toEqual({ languageId: 'en-US', timeZoneId: 'Eastern Standard Time' });
    expect(callFlowDefaultsForSite({ country: 'Atlantis' })).toEqual({ languageId: 'en-US', timeZoneId: 'Eastern Standard Time' });
    // a state before its ZIP wins over a later pair of capitals; a very long address is read quickly (CodeQL js/polynomial-redos)
    expect(callFlowDefaultsForSite({ country: 'US', address: 'Suite CA 1, Denver, CO 80202, US' }).timeZoneId).toBe('Mountain Standard Time');
    const started = Date.now();
    callFlowDefaultsForSite({ country: 'US', address: `TX${' '.repeat(50_000)}!` });
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('only ever gives a language and time zone Teams accepts', () => {
    for (const country of ['uk', 'ie', 'au', 'ca', 'in', 'za', 'nz', 'fr', 'de', 'nl', 'es', 'it', 'us']) {
      const d = callFlowDefaultsForSite({ country });
      expect(AA_SUPPORTED_LANGUAGES.some((l) => l.code === d.languageId)).toBe(true);
      expect(AA_TIME_ZONES.some((z) => z.id === d.timeZoneId)).toBe(true);
    }
  });
});

describe('the review screen', () => {
  it('describes the flow in words', () => {
    expect(visualFlowSummary(menuFlow, '+44 20 7000 0201')).toEqual([
      '"Main Line" answers calls to +44 20 7000 0201.',
      'Business hours are Monday to Friday, 9:00 to 17:00.',
      'During business hours: plays "Welcome to Contoso.", then offers a menu:',
      '  · press 1 for Sales: the call rings the group "Sales" (1 person, everyone at once); if nobody answers, the call hangs up',
      '  · press 2 for Accounts: the call rings pat@contoso.test',
      'After hours: the call goes to the shared voicemail "Main voicemail".',
    ]);
    const weekly = { monday: [{ start: '08:00', end: '18:00' }], tuesday: [{ start: '08:00', end: '18:00' }], wednesday: [{ start: '08:00', end: '18:00' }], thursday: [{ start: '08:00', end: '18:00' }], friday: [{ start: '08:00', end: '18:00' }], saturday: [{ start: '09:00', end: '12:00' }], sunday: [] };
    expect(visualHoursWords({ type: 'custom', weekly })).toBe('Business hours are Monday to Friday, 08:00 to 18:00; Saturday 09:00 to 12:00.');
  });

  it('lists what will be made, with the Teams names', () => {
    expect(visualFlowCreates(menuFlow, { number: '+44 20 7000 0201' }).map((c) => [c.teams, c.name])).toEqual([
      ['resource account', 'Main Line'],
      ['auto attendant', 'Main Line'],
      ['call queue', 'Sales'],
    ]);
    expect(visualFlowCreates(groupOnly, { straightToQueue: true }).map((c) => c.teams)).toEqual(['resource account', 'call queue']);
    expect(visualFlowCreates(groupOnly).map((c) => c.teams)).toEqual(['resource account', 'auto attendant', 'call queue']);
  });
});
