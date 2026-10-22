import { describe, expect, it } from 'vitest';
import {
  diagFinish,
  diagNormaliseNumber,
  diagOutcome,
  diagHasTeamsPhoneLicence,
  diagSameNumber,
  diagSuggest,
  evalChanges,
  evalEmergency,
  evalNumber,
  evalQueue,
  evalRouting,
  evalUserVoice,
  userAccountProblems,
  diagInputSchema,
  type DiagUserFacts,
} from './diagnostics';

const NOW = new Date('2026-10-14T12:00:00Z');
const FRESH = '2026-10-13T12:00:00Z';
const titles = (r: { findings: { status: string; title: string }[] }, status: string) => r.findings.filter((f) => f.status === status).map((f) => f.title);

const goodUser: DiagUserFacts = {
  found: true,
  upn: 'anna@contoso.com',
  displayName: 'Anna Ng',
  accountType: 'User',
  accountEnabled: true,
  enterpriseVoice: true,
  lineUri: 'tel:+441234567890',
  featureTypes: ['PhoneSystem'],
  assignedPlans: [{ Capability: 'MCOEV', CapabilityStatus: 'Enabled' }],
  usageLocation: 'GB',
  policies: { OnlineVoiceRoutingPolicy: 'UK-Routing', TeamsCallingPolicy: 'Standard' },
  design: { callingPolicy: 'Standard', requestedNumber: '+44 1234 567890', siteCode: 'RDG01' },
};

describe('numbers', () => {
  it('normalises tel: URIs and extensions', () => {
    expect(diagNormaliseNumber('tel:+441234567890;ext=100')).toBe('+441234567890');
    expect(diagNormaliseNumber('0044 1234 567890')).toBe('+441234567890');
  });
  it('matches the same number with or without + and country code', () => {
    expect(diagSameNumber('+441234567890', '441234567890')).toBe(true);
    expect(diagSameNumber('+44 1234 567890', 'tel:+441234567890;ext=1')).toBe(true);
    expect(diagSameNumber('01234567890', '+441234567890')).toBe(true);
    expect(diagSameNumber('+441234567890', '+441234567891')).toBe(false);
    expect(diagSameNumber('', '+441234567890')).toBe(false);
  });
});

describe('results', () => {
  it('takes the worst finding, and unknown when nothing was checked', () => {
    expect(diagOutcome([{ status: 'ok', title: 'a' }, { status: 'warn', title: 'b' }])).toBe('warn');
    expect(diagOutcome([{ status: 'ok', title: 'a' }, { status: 'fail', title: 'b' }, { status: 'warn', title: 'c' }])).toBe('fail');
    expect(diagOutcome([{ status: 'info', title: 'a' }])).toBe('unknown');
  });
  it('flags a Discovery that never ran or is old', () => {
    expect(diagFinish('routing_check', 'x', [{ status: 'ok', title: 'a' }], null, NOW).status).toBe('warn');
    const old = diagFinish('routing_check', 'x', [{ status: 'ok', title: 'a' }], '2026-10-01T00:00:00Z', NOW);
    expect(old.status).toBe('warn');
    expect(titles(old, 'warn')[0]).toMatch(/13 days old/);
    expect(diagFinish('routing_check', 'x', [{ status: 'ok', title: 'a' }], FRESH, NOW).status).toBe('ok');
  });
  it('summarises problems first', () => {
    const r = diagFinish('user_voice', 'anna', [{ status: 'fail', title: 'Enterprise Voice is off' }, { status: 'warn', title: 'w' }, { status: 'ok', title: 'o' }], FRESH, NOW);
    expect(r.summary).toBe('anna: 1 problem and 1 thing to look at. Enterprise Voice is off');
  });
  it('validates the run input', () => {
    expect(diagInputSchema.safeParse({ runbook: 'queue_check', input: 'Sales' }).success).toBe(true);
    expect(diagInputSchema.safeParse({ runbook: 'rm_rf' }).success).toBe(false);
    expect(diagInputSchema.safeParse({ runbook: 'queue_check', extra: 1 }).success).toBe(false);
  });
});

describe('user voice', () => {
  it('is clean for a well set up user', () => {
    const r = evalUserVoice('anna@contoso.com', goodUser, FRESH, NOW);
    expect(r.status).toBe('ok');
    expect(titles(r, 'fail')).toEqual([]);
    expect(titles(r, 'ok')).toContain('Calling policy matches the design');
  });
  it('finds the usual reasons for "no dial pad"', () => {
    const r = evalUserVoice('anna@contoso.com', { ...goodUser, enterpriseVoice: false, assignedPlans: [{ Capability: 'TEAMS1', CapabilityStatus: 'Enabled' }], lineUri: null, usageLocation: null }, FRESH, NOW);
    expect(r.status).toBe('fail');
    expect(titles(r, 'fail')).toEqual(['Enterprise Voice is off', 'No Teams Phone licence found']);
    expect(titles(r, 'warn')).toContain('No usage location set');
    expect(titles(r, 'warn')).toContain('No phone number assigned');
  });
  it('reports a missing user, an ambiguous name and a disabled account', () => {
    expect(evalUserVoice('bob', { found: false }, FRESH, NOW).findings[0]!.title).toBe('bob is not in the last Discovery');
    expect(evalUserVoice('ann', { found: false, ambiguous: ['a@x.com', 'b@x.com'] }, FRESH, NOW).findings[0]!.title).toBe('"ann" matches 2 people');
    expect(titles(evalUserVoice('a', { ...goodUser, accountEnabled: false, removedAt: '2026-10-10T00:00:00Z' }, FRESH, NOW), 'fail')).toEqual(['This account is gone from the tenant', 'The account is disabled']);
  });
  it('compares with the design and flags a shared line', () => {
    const r = evalUserVoice('a', { ...goodUser, policies: { OnlineVoiceRoutingPolicy: 'UK', TeamsCallingPolicy: 'Basic' }, design: { callingPolicy: 'Standard', requestedNumber: '+441111111111', siteCode: null }, sameLineUsers: ['bob@contoso.com'] }, FRESH, NOW);
    expect(titles(r, 'warn')).toEqual(['Calling policy differs from the design', 'The number differs from the design']);
    expect(titles(r, 'fail')).toEqual(['Another account has the same number']);
  });
});

describe('number check', () => {
  const rec = { number: '+441234567890', numberType: 'DirectRouting', assignmentStatus: 'UserAssigned', activationState: 'Activated', assignedTo: 'Anna', city: 'Reading' };
  it('is fine when the tenant, the inventory and the design agree', () => {
    const r = evalNumber('+441234567890', { record: rec, lineUsers: ['anna@contoso.com'], resourceAccounts: [], inventory: { status: 'assigned', holderType: 'user', holder: 'Anna', range: 'Reading DDI' }, designHolders: [] }, FRESH, NOW);
    expect(r.status).toBe('ok');
  });
  it('fails a number the tenant does not have, and one given to two people', () => {
    expect(evalNumber('+44', { record: null, lineUsers: [], resourceAccounts: [], inventory: null, designHolders: [] }, FRESH, NOW).status).toBe('fail');
    const two = evalNumber('+44', { record: rec, lineUsers: ['a@x.com', 'b@x.com'], resourceAccounts: [], inventory: null, designHolders: [] }, FRESH, NOW);
    expect(titles(two, 'fail')).toEqual(['2 people have this number']);
  });
  it('flags inventory that disagrees and numbers that are not activated', () => {
    const r = evalNumber('+44', { record: { ...rec, activationState: 'AssignmentFailed' }, lineUsers: ['a@x.com'], resourceAccounts: [], inventory: { status: 'available', holderType: null, holder: null, range: null }, designHolders: [] }, FRESH, NOW);
    expect(titles(r, 'fail')).toEqual(['Activation state is AssignmentFailed']);
    expect(titles(r, 'warn')).toEqual(['Inventory says available but the tenant has it assigned']);
  });
  it('says a design holder is missing the number', () => {
    const r = evalNumber('+44', { record: { ...rec, assignmentStatus: 'Unassigned' }, lineUsers: [], resourceAccounts: [], inventory: null, designHolders: ['Cara'] }, FRESH, NOW);
    expect(titles(r, 'warn')).toEqual(['The number is in the tenant but not assigned to anyone', 'The design gives this number to someone who does not have it']);
  });
});

describe('queue check', () => {
  const agent = (id: string, over: Record<string, unknown> = {}) => ({ id, user: { upn: `${id}@x.com`, displayName: id, accountEnabled: true, enterpriseVoice: true, removed: false, ...over } });
  it('is clean for a working queue', () => {
    const r = evalQueue('Sales', { found: true, kind: 'call_queue', name: 'Sales', agents: [agent('a'), agent('b')], targets: [{ label: 'Overflow', kind: 'user', id: 'x', exists: true, detail: 'Reception' }], resourceAccounts: [{ name: 'ra-sales', number: '+441' }], design: { missingFromTenant: [], notInDesign: [] } }, FRESH, NOW);
    expect(r.status).toBe('ok');
  });
  it('fails when no agent can take calls, warns when some cannot', () => {
    const none = evalQueue('Sales', { found: true, kind: 'call_queue', name: 'Sales', agents: [agent('a', { accountEnabled: false }), { id: 'ghost', user: null }], resourceAccounts: [{ name: 'ra', number: '+441' }] }, FRESH, NOW);
    expect(titles(none, 'fail')).toEqual(['No agent can take calls']);
    const some = evalQueue('Sales', { found: true, kind: 'call_queue', name: 'Sales', agents: [agent('a'), agent('b', { enterpriseVoice: false })], resourceAccounts: [{ name: 'ra', number: '+441' }] }, FRESH, NOW);
    expect(titles(some, 'warn')).toEqual(['1 of 2 agents cannot take calls']);
  });
  it('catches an empty queue, a dead target and a missing resource account', () => {
    const r = evalQueue('Sales', { found: true, kind: 'call_queue', name: 'Sales', agents: [], targets: [{ label: 'Time-out', kind: 'user', id: 'u1', exists: false }], resourceAccounts: [] }, FRESH, NOW);
    expect(titles(r, 'fail')).toEqual(['The queue has no agents', 'Time-out goes to something that no longer exists', 'No resource account is linked']);
  });
  it('compares agents with the design and handles auto attendants', () => {
    const r = evalQueue('AA', { found: true, kind: 'auto_attendant', name: 'AA', resourceAccounts: [{ name: 'ra', number: null }], design: { missingFromTenant: ['Cara'], notInDesign: [] } }, FRESH, NOW);
    expect(titles(r, 'warn')).toEqual(['The resource account has no phone number', 'Agents in the design who are not in the live queue']);
    expect(evalQueue('Nope', { found: false }, FRESH, NOW).status).toBe('fail');
  });
});

describe('routing check', () => {
  it('is informational when there is no Direct Routing', () => {
    expect(evalRouting({ gateways: [], routes: [], usages: [] }, FRESH, NOW).findings[0]!.status).toBe('info');
  });
  it('is clean when routes point at enabled gateways', () => {
    const r = evalRouting({ gateways: [{ fqdn: 'sbc1.contoso.com', enabled: true }], routes: [{ name: 'UK', gateways: ['sbc1.contoso.com'], usages: ['UK'], pattern: '.*', priority: 1 }], usages: ['UK'] }, FRESH, NOW);
    expect(r.status).toBe('ok');
  });
  it('fails routes with no gateway, dead gateways or only disabled gateways', () => {
    const r = evalRouting(
      {
        gateways: [{ fqdn: 'sbc1.contoso.com', enabled: false }],
        routes: [
          { name: 'A', gateways: [], usages: [], pattern: null, priority: 1 },
          { name: 'B', gateways: ['Microsoft.Rtc.Management.Hosted.Online.Models.PSTNGateway:sbc9.contoso.com'], usages: ['Missing'], pattern: null, priority: 2 },
          { name: 'C', gateways: ['sbc1.contoso.com'], usages: [], pattern: null, priority: 3 },
        ],
        usages: ['UK'],
      },
      FRESH,
      NOW,
    );
    expect(titles(r, 'fail')).toEqual(['Every gateway is disabled', 'Route "A" has no gateway', 'Route "B" points at gateways that do not exist', 'Route "C" only uses disabled gateways']);
    expect(titles(r, 'warn')).toEqual(['Route "B" uses a PSTN usage that does not exist']);
  });
});

describe('emergency check', () => {
  it('fails without locations and warns about unvalidated ones', () => {
    expect(evalEmergency({ locations: [], civicAddresses: 0, enterpriseVoiceUsers: 5, usersWithEmergencyPolicy: 0, emergencyPolicies: [], sitesWithoutLocation: [] }, FRESH, NOW).status).toBe('fail');
    const r = evalEmergency({ locations: [{ name: 'HQ', civicAddressId: 'c1', validated: false }, { name: 'Annex', civicAddressId: null, validated: true }], civicAddresses: 1, enterpriseVoiceUsers: 10, usersWithEmergencyPolicy: 4, emergencyPolicies: ['HQ'], sitesWithoutLocation: ['RDG02'] }, FRESH, NOW);
    expect(titles(r, 'warn')).toEqual(['1 location not validated', '1 location without a civic address', 'Sites with no emergency location']);
  });
});

describe('recent changes', () => {
  it('lists failures first and warns about removals', () => {
    const r = evalChanges({ days: 7, tenantChanges: [{ type: 'call_queue', name: 'Sales', kind: 'removed', at: '2026-10-13T09:00:00Z', fields: [] }], tenantChangeTotal: 9, deployments: [{ id: 'd1', mode: 'execute', status: 'completed', at: '2026-10-12T10:00:00Z', failedChanges: 2, appliedChanges: 5 }], serviceRequests: [] }, FRESH, NOW);
    expect(titles(r, 'fail')).toEqual(['1 deployment with failures']);
    expect(titles(r, 'warn')).toEqual(['1 object removed from the tenant']);
    expect(r.findings.find((f) => f.title.startsWith('9 changes'))!.detail).toContain('and 8 more');
  });
  it('is clean and says so when nothing changed', () => {
    expect(evalChanges({ days: 7, tenantChanges: [], tenantChangeTotal: 0, deployments: [], serviceRequests: [] }, FRESH, NOW).status).toBe('ok');
  });
});

describe('suggestions', () => {
  it('points a queue incident at the queue and recent changes', () => {
    const s = diagSuggest({ category: 'queues_aa', items: [], answers: { which: 'Sales queue' } });
    expect(s.map((x) => `${x.runbook}:${x.input}`)).toEqual(['queue_check:Sales queue', 'recent_changes:']);
  });
  it('takes numbers and people from items, answers and the description', () => {
    const s = diagSuggest({ category: 'numbers', items: [{ kind: 'user', ref: 'anna@contoso.com', label: null }], answers: { numbers: '+44 1234 567890, 01189 000111' }, description: 'Also bob@contoso.com cannot dial' });
    expect(s.map((x) => x.runbook)).toEqual(['number_check', 'number_check', 'user_voice', 'user_voice', 'recent_changes']);
    expect(s[0]!.input).toBe('+44 1234 567890');
  });
  it('starts emergency incidents with the emergency setup and routing ones with routes', () => {
    expect(diagSuggest({ category: 'emergency', items: [] })[0]!.runbook).toBe('emergency_check');
    expect(diagSuggest({ category: 'direct_routing', items: [] })[0]!.runbook).toBe('routing_check');
  });
  it('never suggests the same check twice', () => {
    const s = diagSuggest({ category: 'users', items: [{ kind: 'user', ref: 'a@x.com', label: null }], description: 'A@x.com again' });
    expect(s.filter((x) => x.runbook === 'user_voice')).toHaveLength(1);
  });
});

describe('teams phone licence and pasted text', () => {
  it('MCOEV must start the capability name; TEAMSPHONE and MCOPSTN may appear anywhere', () => {
    const plan = (Capability: string) => [{ Capability, CapabilityStatus: 'Enabled' }];
    expect(diagHasTeamsPhoneLicence(plan('MCOEV_VIRTUALUSER'), [])).toBe(true);
    expect(diagHasTeamsPhoneLicence(plan('MCOPSTN1'), [])).toBe(true);
    expect(diagHasTeamsPhoneLicence(plan('X_TEAMSPHONE_Y'), [])).toBe(true);
    expect(diagHasTeamsPhoneLicence(plan('NOT_MCOEV'), [])).toBe(false);
    expect(diagHasTeamsPhoneLicence([{ Capability: 'MCOEV', CapabilityStatus: 'Deleted' }], [])).toBe(false);
  });
  it('finds addresses in a description and stays fast on long junk', () => {
    const found = diagSuggest({ category: 'calling', items: [], description: 'cannot call, user cara@contoso.com affected' });
    expect(JSON.stringify(found)).toContain('cara@contoso.com');
    const t = Date.now();
    diagSuggest({ category: 'calling', items: [], description: '%'.repeat(100_000) + ' ' + 'a'.repeat(100_000) });
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('userAccountProblems', () => {
  const phone = [{ Capability: 'MCOEV', CapabilityStatus: 'Enabled' }];
  const teamsOnly = [{ Capability: 'TEAMS1', CapabilityStatus: 'Enabled' }];
  it('flags a disabled account', () => {
    expect(userAccountProblems({ accountEnabled: false, assignedPlans: phone })).toEqual({ accountDisabled: true, noPhoneLicence: false });
    expect(userAccountProblems({ accountEnabled: true, assignedPlans: phone }).accountDisabled).toBe(false);
    expect(userAccountProblems({ accountEnabled: null }).accountDisabled).toBe(false);
  });
  it('flags an account with licence data but no phone plan', () => {
    expect(userAccountProblems({ accountEnabled: true, assignedPlans: teamsOnly }).noPhoneLicence).toBe(true);
    expect(userAccountProblems({ accountEnabled: true, assignedPlans: phone }).noPhoneLicence).toBe(false);
  });
  it('does not guess when no licence data was recorded', () => {
    expect(userAccountProblems({ accountEnabled: true, assignedPlans: [], featureTypes: [] }).noPhoneLicence).toBe(false);
  });
  it('does not ask a number-less resource account for a phone licence', () => {
    expect(userAccountProblems({ accountEnabled: true, assignedPlans: teamsOnly }, false).noPhoneLicence).toBe(false);
  });
});
