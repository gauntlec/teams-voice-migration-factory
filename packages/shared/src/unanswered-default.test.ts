import { describe, expect, it } from 'vitest';
import { defaultUnanswered, setUnansweredChoice, unansweredMatchesLive, VOICEMAIL_UNANSWERED_DEFAULT } from './calling-settings';
import { planIdentityRow, renderCommand, type BuildIdentityRow } from './deployment';

const row = (over: Partial<BuildIdentityRow> = {}): BuildIdentityRow => ({ id: 'r1', upn: 'jo@contoso.test', e164: null, number_type: null, revoke_ev: false, policies: null, voicemail: { enabled: true }, call_forwarding: null, pickup_group: null, delegates: null, ...over });
const unanswered = (calls: ReturnType<typeof planIdentityRow>) => calls.filter((c) => c.cmdlet === 'Set-CsUserCallingSettings' && 'IsUnansweredEnabled' in c.parameters);
const live = (u: unknown) => ({ voicemailEnabled: true, callingSettings: { callForwarding: { unanswered: u } } }) as never;

describe("a user's unanswered calls", () => {
  it("go to voicemail after 20 seconds when voicemail is on, with Microsoft's documented command", () => {
    const [call] = unanswered(planIdentityRow(row(), 'user'));
    expect(call).toMatchObject({ byDefault: true });
    expect(renderCommand(call!)).toBe("Set-CsUserCallingSettings -Identity 'jo@contoso.test' -IsUnansweredEnabled:$true -UnansweredDelay '00:00:20' -UnansweredTargetType 'Voicemail'");
  });

  it('are left alone with voicemail off or not set, and for a common area phone', () => {
    expect(unanswered(planIdentityRow(row({ voicemail: { enabled: false } }), 'user'))).toEqual([]);
    expect(unanswered(planIdentityRow(row({ voicemail: null }), 'user'))).toEqual([]);
    expect(unanswered(planIdentityRow(row(), 'cap'))).toEqual([]);
  });

  it('fix "Do nothing" in Teams, but never overwrite a rule someone set there', () => {
    expect(unanswered(planIdentityRow(row(), 'user', live({ enabled: false })))).toHaveLength(1);
    expect(unanswered(planIdentityRow(row(), 'user', live({ enabled: true, delaySeconds: 30, targetType: 'MyDelegates' })))).toEqual([]);
    // already right: nothing to send, so the row drops off the planned changes
    expect(unanswered(planIdentityRow(row(), 'user', live({ enabled: true, delaySeconds: 20, targetType: 'Voicemail' })))).toEqual([]);
  });

  it("follow the row's own choice ahead of the default, which then counts as design", () => {
    const off = unanswered(planIdentityRow(row({ call_forwarding: { unanswered: { enabled: false } } }), 'user', live({ enabled: true, delaySeconds: 20, targetType: 'Voicemail' })));
    expect(off[0]!.parameters).toEqual({ Identity: 'jo@contoso.test', IsUnansweredEnabled: false });
    expect(off[0]!.byDefault).toBeUndefined();
    const person = unanswered(planIdentityRow(row({ call_forwarding: { unanswered: { enabled: true, delaySeconds: 30, targetType: 'SingleTarget', target: 'sam@contoso.test' } } }), 'user'));
    expect(person[0]!.parameters).toMatchObject({ UnansweredDelay: '00:00:30', UnansweredTargetType: 'SingleTarget', UnansweredTarget: 'sam@contoso.test' });
  });

  it('match Teams once the default has been applied', () => {
    expect(unansweredMatchesLive(VOICEMAIL_UNANSWERED_DEFAULT, { enabled: true, delaySeconds: 20, targetType: 'Voicemail' } as never)).toBe(true);
  });
});

describe('choosing in the edit dialogs', () => {
  it('stores nothing when the choice is the default, so the row keeps following voicemail', () => {
    expect(setUnansweredChoice({}, { ...VOICEMAIL_UNANSWERED_DEFAULT }, true)).toEqual({});
    expect(setUnansweredChoice({ unanswered: { enabled: false } }, { ...VOICEMAIL_UNANSWERED_DEFAULT }, true)).toEqual({});
    expect(setUnansweredChoice({ unanswered: { enabled: true, targetType: 'Voicemail' } }, { enabled: false }, false)).toEqual({});
  });
  it('stores anything else, and keeps the rest of the call forwarding', () => {
    expect(setUnansweredChoice({ busyOnBusy: 'PlayBusySignal' }, { enabled: false }, true)).toEqual({ busyOnBusy: 'PlayBusySignal', unanswered: { enabled: false } });
    expect(setUnansweredChoice({}, { ...VOICEMAIL_UNANSWERED_DEFAULT, delaySeconds: 30 }, true)).toEqual({ unanswered: { enabled: true, delaySeconds: 30, targetType: 'Voicemail' } });
  });
  it('shows do nothing as the default without voicemail', () => {
    expect(defaultUnanswered(false)).toEqual({ enabled: false });
    expect(defaultUnanswered(true)).toEqual(VOICEMAIL_UNANSWERED_DEFAULT);
  });
});
