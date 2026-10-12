import { describe, expect, it } from 'vitest';
import { planIdentityRow, type BuildIdentityRow, type LiveIdentityState } from './deployment';
import { planRollback, renderRollbackScript, type RollbackChangeInput } from './deployment-rollback';
import { identityBeforeState, verificationHeadline, verificationRowDifferences } from './deployment-verify';

const snap = (before: Record<string, unknown>) => ({ source: 'discovery_snapshot', ...before });
let seq = 0;
const change = (cmdlet: string, parameters: Record<string, unknown>, before: Record<string, unknown> = {}, more: Partial<RollbackChangeInput> = {}): RollbackChangeInput => ({
  seq: ++seq,
  object_type: 'user',
  cmdlet,
  parameters,
  before,
  result: 'applied',
  ...more,
});

describe('planRollback', () => {
  it('restores the previous number with its number type', () => {
    const plan = planRollback([
      change(
        'Set-CsPhoneNumberAssignment',
        { Identity: 'jo@contoso.com', PhoneNumber: '+15550000002', PhoneNumberType: 'DirectRouting' },
        snap({ lineUri: 'tel:+15550000001', phoneNumberType: 'CallingPlan', enterpriseVoiceEnabled: true }),
      ),
    ]);
    expect(plan.steps.map((s) => s.command)).toEqual([
      "Set-CsPhoneNumberAssignment -Identity 'jo@contoso.com' -PhoneNumber '+15550000001' -PhoneNumberType 'CallingPlan'",
    ]);
    expect(plan.notReversible).toEqual([]);
  });

  it('removes a number from someone who had none, keeping Enterprise Voice as it was', () => {
    const plan = planRollback([
      change('Set-CsPhoneNumberAssignment', { Identity: 'a@c.com', PhoneNumber: '+1555', PhoneNumberType: 'CallingPlan' }, snap({ lineUri: null, enterpriseVoiceEnabled: true })),
      change('Set-CsPhoneNumberAssignment', { Identity: 'b@c.com', PhoneNumber: '+1556', PhoneNumberType: 'CallingPlan' }, snap({ lineUri: null, enterpriseVoiceEnabled: false })),
    ]);
    expect(plan.steps.map((s) => s.command)).toEqual([
      "Remove-CsPhoneNumberAssignment -Identity 'b@c.com' -RemoveAll:$true",
      "Remove-CsPhoneNumberAssignment -Identity 'a@c.com' -PhoneNumber '+1555' -PhoneNumberType 'CallingPlan'",
    ]);
  });

  it('lists a previous number whose type is unknown instead of guessing it', () => {
    const plan = planRollback([
      change('Set-CsPhoneNumberAssignment', { Identity: 'jo@c.com', PhoneNumber: '+2', PhoneNumberType: 'CallingPlan' }, snap({ lineUri: 'tel:+1', phoneNumberType: null })),
    ]);
    expect(plan.steps).toEqual([]);
    expect(plan.notReversible[0]?.reason).toMatch(/previous number \+1 - its number type is not known/);
  });

  it('grants the previous policy, and Global as -PolicyName $null', () => {
    const plan = planRollback([
      change('Grant-CsTeamsCallingPolicy', { Identity: 'jo@c.com', PolicyName: 'AllowCalling' }, snap({ policyName: null })),
      change('Grant-CsOnlineVoiceRoutingPolicy', { Identity: 'jo@c.com', PolicyName: { $var: 'null' } }, snap({ policyName: 'UK-National' })),
      change('Grant-CsTenantDialPlan', { Identity: 'jo@c.com', PolicyName: 'UK' }, snap({ policyName: 'Global' })),
    ]);
    expect(plan.steps.map((s) => s.command)).toEqual([
      "Grant-CsTenantDialPlan -Identity 'jo@c.com' -PolicyName $null",
      "Grant-CsOnlineVoiceRoutingPolicy -Identity 'jo@c.com' -PolicyName 'UK-National'",
      "Grant-CsTeamsCallingPolicy -Identity 'jo@c.com' -PolicyName $null",
    ]);
  });

  it('undoes in reverse order - newest change first', () => {
    seq = 0;
    const plan = planRollback([
      change('Grant-CsTeamsCallingPolicy', { Identity: 'x', PolicyName: 'A' }, snap({ policyName: null })),
      change('Grant-CsTeamsCallingPolicy', { Identity: 'x', PolicyName: 'B' }, snap({ policyName: 'A' })),
    ]);
    expect(plan.steps.map((s) => s.seq)).toEqual([2, 1]);
    expect(plan.steps[0]?.command).toContain("-PolicyName 'A'");
    expect(plan.steps[1]?.command).toContain('-PolicyName $null');
  });

  it('restores a number and Enterprise Voice after a revoke', () => {
    const plan = planRollback([
      change('Remove-CsPhoneNumberAssignment', { Identity: 'a', RemoveAll: true }, snap({ lineUri: 'tel:+44201;ext=5', phoneNumberType: 'OperatorConnect', enterpriseVoiceEnabled: true })),
      change('Remove-CsPhoneNumberAssignment', { Identity: 'b', RemoveAll: true }, snap({ lineUri: null, enterpriseVoiceEnabled: true })),
    ]);
    expect(plan.steps.map((s) => s.command)).toEqual([
      "Set-CsPhoneNumberAssignment -Identity 'b' -EnterpriseVoiceEnabled:$true",
      "Set-CsPhoneNumberAssignment -Identity 'a' -PhoneNumber '+44201' -PhoneNumberType 'OperatorConnect'",
    ]);
  });

  it('puts voicemail back and removes a delegate this run added', () => {
    const plan = planRollback([
      change('Set-CsOnlineVoicemailUserSettings', { Identity: 'a', VoicemailEnabled: false }, snap({ voicemailEnabled: true, voicemailPromptLanguage: 'en-GB' })),
      change('New-CsUserCallingDelegate', { Identity: 'a', Delegate: 'pa@c.com', MakeCalls: true }),
    ]);
    expect(plan.steps.map((s) => s.command)).toEqual([
      "Remove-CsUserCallingDelegate -Identity 'a' -Delegate 'pa@c.com'",
      "Set-CsOnlineVoicemailUserSettings -Identity 'a' -VoicemailEnabled:$true -PromptLanguage 'en-GB'",
    ]);
  });

  it("lists what it can't reverse: no snapshot, call forwarding, queues/attendants, created resource accounts", () => {
    const plan = planRollback([
      change('Grant-CsTeamsCallingPolicy', { Identity: 'old-run', PolicyName: 'X' }, {}), // runs before before-capture existed
      change('Set-CsUserCallingSettings', { Identity: 'a', IsForwardingEnabled: true }),
      change('Set-CsOnlineVoicemailUserSettings', { Identity: 'a', VoicemailEnabled: true }, {}),
      change('New-CsCallQueue', { Name: 'Sales' }, {}, { object_type: 'call_queue' }),
      change('Set-CsAutoAttendant', { Instance: { $var: 'aa' } }, {}, { object_type: 'auto_attendant' }),
      change('New-CsOnlineApplicationInstance', { UserPrincipalName: 'ra@c.com' }, {}, { object_type: 'resource_account', result: 'whatif' }),
      change('Grant-CsTeamsCallingPolicy', { Identity: 'f', PolicyName: 'X' }, snap({ policyName: null }), { result: 'failed' }),
    ]);
    expect(plan.steps).toEqual([]);
    expect(plan.notReversible.map((n) => n.cmdlet)).toEqual([
      'Set-CsAutoAttendant',
      'New-CsCallQueue',
      'Set-CsOnlineVoicemailUserSettings',
      'Set-CsUserCallingSettings',
      'Grant-CsTeamsCallingPolicy',
    ]);
    expect(plan.notReversible.find((n) => n.cmdlet === 'New-CsCallQueue')?.identity).toBe('Sales');
    expect(plan.externallyCreated).toEqual([{ seq: expect.any(Number), identity: 'ra@c.com' }]);
    expect(plan.failedCount).toBe(1);
  });
});

describe('renderRollbackScript', () => {
  it('wraps the steps and lists the manual items in the header', () => {
    seq = 0;
    const script = renderRollbackScript(
      [
        change('Grant-CsTeamsCallingPolicy', { Identity: 'jo@c.com', PolicyName: 'X' }, snap({ policyName: 'Old' })),
        change('New-CsCallQueue', { Name: 'Sales' }, {}, { object_type: 'call_queue' }),
      ],
      { deploymentId: 'dep-1', generatedAt: '2026-10-12T00:00:00Z' },
    );
    expect(script).toContain('# Voxshift ROLLBACK for deployment dep-1');
    expect(script).toContain('# NOT REVERSED BY THIS SCRIPT (1)');
    expect(script).toContain('#   #2 New-CsCallQueue Sales - created by this run');
    expect(script).toContain("  Grant-CsTeamsCallingPolicy -Identity 'jo@c.com' -PolicyName 'Old'");
    expect(script.indexOf('Connect-MicrosoftTeams')).toBeLessThan(script.indexOf('Grant-CsTeamsCallingPolicy -Identity'));
    expect(script).toContain('} finally {\n  Disconnect-MicrosoftTeams\n}');
  });

  it('keeps tenant text with line breaks inside its comment', () => {
    const script = renderRollbackScript(
      [change('New-CsCallQueue', { Name: "Sales\nRemove-CsCallQueue -Identity 'x'" }, {}, { object_type: 'call_queue' })],
      { deploymentId: 'd' },
    );
    expect(script.split('\n').filter((l) => l.startsWith('Remove-CsCallQueue'))).toEqual([]);
  });

  it('says so when nothing can be reversed', () => {
    expect(renderRollbackScript([], { deploymentId: 'd' })).toContain('Nothing in this run can be reversed automatically');
  });
});

describe('identityBeforeState + verification', () => {
  const live: LiveIdentityState = {
    enterpriseVoiceEnabled: true,
    lineUri: 'tel:+15550000001',
    policies: { TeamsCallingPolicy: 'Old', OnlineVoiceRoutingPolicy: null },
    voicemailEnabled: true,
    voicemailPromptLanguage: 'en-US',
  };

  it('records only what the cmdlet changes, and nothing without a snapshot', () => {
    expect(identityBeforeState({ cmdlet: 'Set-CsPhoneNumberAssignment' }, live, 'CallingPlan')).toEqual({
      source: 'discovery_snapshot',
      lineUri: 'tel:+15550000001',
      phoneNumberType: 'CallingPlan',
      enterpriseVoiceEnabled: true,
    });
    expect(identityBeforeState({ cmdlet: 'Grant-CsOnlineVoiceRoutingPolicy' }, live)).toEqual({ source: 'discovery_snapshot', policyName: null });
    expect(identityBeforeState({ cmdlet: 'Set-CsUserCallingSettings' }, live)).toEqual({});
    expect(identityBeforeState({ cmdlet: 'Grant-CsTeamsCallingPolicy' }, undefined)).toEqual({});
    expect(identityBeforeState({ cmdlet: 'Set-CsOnlineVoicemailUserSettings' }, { ...live, voicemailEnabled: undefined })).toEqual({});
  });

  const row: BuildIdentityRow = {
    id: 'r1',
    upn: 'jo@c.com',
    e164: '+15550000002',
    number_type: 'CallingPlan',
    revoke_ev: false,
    policies: { calling_policy: 'New', voice_routing_policy: 'Global' },
    voicemail: null,
    call_forwarding: { forwarding: { enabled: true, type: 'Immediate', targetType: 'Voicemail' } },
    pickup_group: null,
    delegates: null,
  };

  it('a design that landed has no differences (call forwarding is not part of the verdict)', () => {
    const landed: LiveIdentityState = { ...live, lineUri: 'tel:+15550000002', policies: { TeamsCallingPolicy: 'New', OnlineVoiceRoutingPolicy: null } };
    expect(verificationRowDifferences(planIdentityRow(row, 'user', landed), landed)).toEqual([]);
  });

  it('describes what still differs', () => {
    expect(verificationRowDifferences(planIdentityRow(row, 'user', live), live)).toEqual([
      'Phone number: designed +15550000002, live +15550000001',
      'Teams Calling Policy: designed New, live Old',
    ]);
    expect(verificationRowDifferences(planIdentityRow(row, 'user', undefined), undefined)).toEqual(['Not found in Teams when re-checked']);
  });

  it('headline', () => {
    const base = { status: 'verified' as const, checkedAt: '', discoveryRunId: 'r', notChecked: 0, unverifiableSettings: 0 };
    expect(verificationHeadline({ ...base, checked: 50, matched: 48, differing: [{}, {}] as never })).toBe('Verified: 48/50 match - 2 still differ');
    expect(verificationHeadline({ ...base, checked: 3, matched: 3, differing: [] })).toBe('Verified: 3/3 match');
  });
});
