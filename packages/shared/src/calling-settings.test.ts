import { describe, expect, it } from 'vitest';
import { delegateMatchesLive, forwardingMatchesLive, parseLiveCallingSettings, pickupGroupMatchesLive, timeSpanSeconds, unansweredMatchesLive } from './calling-settings';

describe('Get-CsUserCallingSettings', () => {
  it('reads "unanswered after 20 seconds goes to voicemail"', () => {
    const s = parseLiveCallingSettings({ IsForwardingEnabled: false, ForwardingType: 'Immediate', ForwardingTargetType: 'Voicemail', IsUnansweredEnabled: true, UnansweredTargetType: 'Voicemail', UnansweredDelay: '00:00:20', CallGroupOrder: 'InOrder', CallGroupTargets: [] });
    expect(s.callForwarding).toEqual({ forwarding: { enabled: false }, unanswered: { enabled: true, delaySeconds: 20, targetType: 'Voicemail' } });
    expect(s.pickupGroup).toBeNull();
    expect(s.delegates).toEqual([]);
  });

  it('reads simultaneous ring to one person, a call group, delegates and busy on busy', () => {
    const s = parseLiveCallingSettings({
      IsForwardingEnabled: true, ForwardingType: 'Simultaneous', ForwardingTarget: 'sip:user3@contoso.com', ForwardingTargetType: 'SingleTarget',
      IsUnansweredEnabled: true, UnansweredTarget: 'tel:+442079460000', UnansweredTargetType: 'SingleTarget', UnansweredDelay: { Hours: 0, Minutes: 0, Seconds: 30 },
      CallGroupOrder: 'InOrder', CallGroupTargets: ['sip:user5@contoso.com'],
      Delegates: [{ Id: 'sip:user8@contoso.com', MakeCalls: true, ReceiveCalls: true, ManageSettings: false, PickUpHeldCalls: true, JoinActiveCalls: false }],
      BusyOnBusyOption: 'PlayBusySignal',
    });
    expect(s.callForwarding).toEqual({
      forwarding: { enabled: true, type: 'Simultaneous', targetType: 'SingleTarget', target: 'user3@contoso.com' },
      unanswered: { enabled: true, delaySeconds: 30, targetType: 'SingleTarget', target: 'tel:+442079460000' },
      busyOnBusy: 'PlayBusySignal',
    });
    expect(s.pickupGroup).toEqual({ order: 'InOrder', targets: ['user5@contoso.com'] });
    expect(s.delegates).toEqual([{ delegateUpn: 'user8@contoso.com', makeCalls: true, receiveCalls: true, manageSettings: false, pickUpHeldCalls: true, joinActiveCalls: false }]);
  });

  it('leaves a user who never changed anything with no designed settings', () => {
    const s = parseLiveCallingSettings({ IsForwardingEnabled: null, IsUnansweredEnabled: null, UnansweredDelay: '00:00:20', CallGroupOrder: 'Simultaneous', CallGroupTargets: [] });
    expect(s.callForwarding).toEqual({});
    expect(s.pickupGroup).toBeNull();
  });

  it('reads time spans', () => {
    expect(timeSpanSeconds('00:00:20')).toBe(20);
    expect(timeSpanSeconds('00:01:00')).toBe(60);
    expect(timeSpanSeconds({ TotalSeconds: 45 })).toBe(45);
  });

  it('compares a design with what is live, by what the design sets', () => {
    const live = parseLiveCallingSettings({ IsUnansweredEnabled: true, UnansweredTargetType: 'Voicemail', UnansweredDelay: '00:00:20', IsForwardingEnabled: true, ForwardingType: 'Simultaneous', ForwardingTarget: 'sip:a@x.test', ForwardingTargetType: 'SingleTarget' });
    expect(unansweredMatchesLive({ enabled: true, delaySeconds: 20, targetType: 'Voicemail' }, live.callForwarding.unanswered)).toBe(true);
    expect(unansweredMatchesLive({ enabled: true, delaySeconds: 30, targetType: 'Voicemail' }, live.callForwarding.unanswered)).toBe(false);
    expect(forwardingMatchesLive({ enabled: true, type: 'Simultaneous', targetType: 'SingleTarget', target: 'A@x.test' }, live.callForwarding.forwarding)).toBe(true);
    expect(forwardingMatchesLive({ enabled: false }, live.callForwarding.forwarding)).toBe(false);
    expect(pickupGroupMatchesLive({ order: 'InOrder', targets: [] }, null)).toBe(true);
    expect(delegateMatchesLive({ delegateUpn: 'd@x.test', makeCalls: true, receiveCalls: true, manageSettings: true, pickUpHeldCalls: true, joinActiveCalls: true }, [])).toBe(false);
  });
});
