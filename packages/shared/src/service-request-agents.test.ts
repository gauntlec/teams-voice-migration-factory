import { describe, expect, it } from 'vitest';
import { AGENT_ACTION_CLASSES, AGENT_DEFAULT_AUTONOMY, AGENT_LEVEL_CAPS, agentLevel } from './agents';
import { SR_AUTOMATION_TYPES, srAutomation, srPlanText, srProposalClass, srProposalSchema, srProposalSummary, srWhatIfVerdict, srProposalDecisionSchema } from './service-request-agents';

const id = '11111111-2222-3333-4444-555555555555';
const jo = { upn: 'Jo@Contoso.com', name: 'Jo' };
const row = (over: Record<string, unknown> = {}) => ({ rowId: 'r1', objectType: 'user' as const, upn: 'jo@contoso.com', calls: [{ cmdlet: 'Set-X' }] as never, warnings: [] as string[], renderedCommands: ['Set-X -Identity jo'], ...over });

describe('which requests an assistant may do', () => {
  it('takes a voicemail change that maps completely', () => {
    const a = srAutomation('change_user', { user: jo, changes: ['Voicemail'], voicemail: 'Turn off' }, 'planned');
    expect(a).toEqual({ eligible: true, reasons: [], applies: ['turn voicemail off'], followUps: [] });
  });
  it('takes adding and removing queue agents, and says what it will do', () => {
    const a = srAutomation('change_call_queue', { queue: { id, label: 'Sales' }, changes: ['Add people', 'Remove people'], add_agents: [jo, { upn: 'a@x.com', name: 'A' }], remove_agents: [{ upn: 'b@x.com', name: 'B' }] }, 'planned');
    expect(a.eligible).toBe(true);
    expect(a.applies).toEqual(['add 2 agents', 'remove 1 agent']);
  });
  it('takes a leaver, with the number clean-up as a follow-up for a person', () => {
    const a = srAutomation('remove_user', { user: jo, number_after: 'Release it so it can be reused' }, 'new');
    expect(a.eligible).toBe(true);
    expect(a.applies).toEqual(['remove its number and Teams calling']);
    expect(a.followUps[0]).toContain('clear the phone number');
  });
  it('is not eligible when a person has to decide something', () => {
    const fwd = srAutomation('change_user', { user: jo, changes: ['Voicemail', 'Call forwarding'], voicemail: 'Turn on', forward_to: { kind: 'voicemail', label: 'Voicemail' } }, 'planned');
    expect(fwd.eligible).toBe(false);
    expect(fwd.reasons[0]).toContain('A person has to decide: Set call forwarding');
    expect(fwd.applies).toEqual(['turn voicemail on']);
    expect(srAutomation('change_user', { user: jo, changes: ['Voicemail'], voicemail: 'Turn on', notes: 'only after 5pm' }, 'planned').eligible).toBe(false);
    expect(srAutomation('change_user', { user: jo, changes: ['Voicemail'], voicemail: 'Turn on', when: 'Monday' }, 'planned').eligible).toBe(false);
    expect(srAutomation('remove_user', { user: jo, number_after: 'Keep it for a replacement', leaving_date: '2026-12-01' }, 'planned').eligible).toBe(false);
  });
  it('never takes new things, finished requests, or requests with nothing to apply', () => {
    for (const t of ['new_user', 'new_users', 'new_call_queue', 'new_auto_attendant', 'new_site', 'new_phone_numbers', 'new_common_area_phone', 'other'] as const) {
      expect(SR_AUTOMATION_TYPES).not.toContain(t);
      expect(srAutomation(t, {}, 'planned').eligible).toBe(false);
    }
    expect(srAutomation('change_user', { user: jo, changes: ['Voicemail'], voicemail: 'Turn on' }, 'deployed').reasons).toEqual(['This request is finished.']);
    expect(srAutomation('change_user', { user: jo, changes: [] }, 'planned').reasons).toEqual(['Nothing in the request can be applied automatically.']);
    expect(srAutomation('change_user', {}, 'planned').reasons).toEqual(['The request has no person.']);
  });
  it('treats a holiday closure as automatable but flags the default message behaviour for a person', () => {
    const a = srAutomation('change_auto_attendant', { auto_attendant: { id, label: 'Main' }, changes: ['Holiday closure'], holiday_name: 'Xmas', holiday_from: '2026-12-25', holiday_to: '2026-12-25' }, 'planned');
    expect(a.eligible).toBe(true);
    expect(a.followUps[0]).toContain('Check the holiday closure');
    // Opening hours and menu changes are decisions, not mappings.
    expect(srAutomation('change_auto_attendant', { auto_attendant: { id, label: 'Main' }, changes: ['Opening hours'], business_hours: '9-5' }, 'planned').eligible).toBe(false);
  });
});

describe('What-If verdict', () => {
  it('is ok with changes and no warnings', () => {
    expect(srWhatIfVerdict([row()])).toEqual({ ok: true, rows: 1, calls: 1, warnings: [], reasons: [] });
  });
  it('is not ok with a warning, nothing to change, or no rows', () => {
    const w = srWhatIfVerdict([row({ warnings: ['no assignment type'] })]);
    expect(w.ok).toBe(false);
    expect(w.reasons[0]).toBe('The What-If has a warning: jo@contoso.com: no assignment type');
    expect(srWhatIfVerdict([row({ calls: [] })]).reasons).toEqual(['Nothing would change: what the request asks for is already in place.']);
    expect(srWhatIfVerdict([]).reasons).toEqual(['There is nothing designed for this request.']);
    expect(srWhatIfVerdict([row({ warnings: ['a'] }), row({ warnings: ['b'] })]).reasons[0]).toContain('2 warnings');
  });
});

describe('the plan fingerprint text', () => {
  it('is the same whatever order the rows come in, and changes when a command does', () => {
    const a = row({ rowId: 'a', renderedCommands: ['One', 'Two'] });
    const b = row({ rowId: 'b', renderedCommands: ['Three'] });
    expect(srPlanText([a, b])).toBe(srPlanText([b, a]));
    expect(srPlanText([a, b])).not.toBe(srPlanText([a, { ...b, renderedCommands: ['Three -Force'] }]));
    expect(srPlanText([a, b])).toBe('# user a\nOne\nTwo\n\n# user b\nThree');
  });
});

describe('proposals', () => {
  it('validates params per kind', () => {
    expect(srProposalSchema.safeParse({ kind: 'comment', params: { body: 'We are on it' }, rationale: 'No update sent' }).success).toBe(true);
    expect(srProposalSchema.safeParse({ kind: 'status', params: { to: 'deployed' }, rationale: 'x y z' }).success).toBe(false);
    expect(srProposalSchema.safeParse({ kind: 'status', params: { to: 'built' }, rationale: 'The design is done' }).success).toBe(true);
    expect(srProposalSchema.safeParse({ kind: 'external', params: { actionClass: 'change_deploy', title: 'Deploy SR-1' }, rationale: 'Approved plan' }).success).toBe(true);
    expect(srProposalSchema.safeParse({ kind: 'external', params: { actionClass: 'resolve', title: 'Close it' }, rationale: 'because' }).success).toBe(false);
    expect(srProposalSchema.safeParse({ kind: 'decline', params: {}, rationale: 'because' }).success).toBe(false);
  });
  it('maps proposals to the autonomy class they need', () => {
    expect(srProposalClass('comment', {})).toBe('customer_update');
    expect(srProposalClass('status', { to: 'planned' })).toBe('triage');
    expect(srProposalClass('status', { to: 'built' })).toBe('change_design');
    expect(srProposalClass('external', { actionClass: 'change_deploy' })).toBe('change_deploy');
  });
  it('summarises for the approval card', () => {
    expect(srProposalSummary('status', { to: 'built' })).toBe('Move the request to Designed & built');
    expect(srProposalSummary('external', { title: 'Apply the request', detail: 'turn voicemail off' })).toBe('Apply the request - turn voicemail off');
  });
  it('needs the session ID only as a uuid', () => {
    expect(srProposalDecisionSchema.safeParse({ decision: 'approve', connectionId: 'nope' }).success).toBe(false);
    expect(srProposalDecisionSchema.safeParse({ decision: 'approve', connectionId: id }).success).toBe(true);
  });
});

describe('autonomy for the design step', () => {
  it('is its own class, off by default, and can be acted on alone', () => {
    expect(AGENT_ACTION_CLASSES).toContain('change_design');
    expect(AGENT_DEFAULT_AUTONOMY.change_design).toBe(0);
    expect(AGENT_LEVEL_CAPS.change_design).toBe(3);
    expect(agentLevel({ change_design: 3 }, 'change_design')).toBe(3);
    // Deploying is never unattended.
    expect(agentLevel({ change_deploy: 3 }, 'change_deploy')).toBe(2);
  });
});
