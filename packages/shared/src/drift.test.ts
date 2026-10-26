import { describe, expect, it } from 'vitest';
import { classifyDrift, driftEvidence, identityDriftNotAccepted } from './drift';

const deployed = '2026-10-20T10:00:00Z';
const base = {
  planned: true,
  history: { lastCleanAt: deployed, failedSince: false },
  rowUpdatedAt: '2026-10-19T09:00:00Z',
  lastSyncAt: '2026-10-25T08:00:00Z',
};

describe('classifyDrift', () => {
  it('is drift when a deployed, unedited row plans commands after a later sync', () => {
    expect(classifyDrift(base)).toBe('drift');
  });

  it('is nothing when the row plans no commands', () => {
    expect(classifyDrift({ ...base, planned: false })).toBeNull();
  });

  it('is nothing for a row that was never deployed - that is a design, not drift', () => {
    expect(classifyDrift({ ...base, history: undefined })).toBeNull();
    expect(classifyDrift({ ...base, history: { lastCleanAt: null, failedSince: false } })).toBeNull();
  });

  it('is nothing when the row was edited after its deployment - a pending change', () => {
    expect(classifyDrift({ ...base, rowUpdatedAt: '2026-10-21T00:00:00Z' })).toBeNull();
  });

  it('is nothing when a later live run failed for the row', () => {
    expect(classifyDrift({ ...base, history: { lastCleanAt: deployed, failedSince: true } })).toBeNull();
  });

  it('waits for a sync when none has read the tenant since the deployment', () => {
    expect(classifyDrift({ ...base, lastSyncAt: '2026-10-20T09:00:00Z' })).toBe('awaiting_sync');
    expect(classifyDrift({ ...base, lastSyncAt: null })).toBe('awaiting_sync');
  });
});

describe('identityDriftNotAccepted', () => {
  it('lists what Accept into design leaves to the engineer', () => {
    expect(
      identityDriftNotAccepted(['Set-CsUserCallingSettings', 'Set-CsPhoneNumberAssignment', 'Grant-CsOnlineVoiceRoutingPolicy', 'Set-CsPhoneNumberAssignment']),
    ).toEqual(['Set-CsPhoneNumberAssignment', 'Grant-CsOnlineVoiceRoutingPolicy']);
    expect(identityDriftNotAccepted(['Set-CsOnlineVoicemailUserSettings', 'New-CsUserCallingDelegate'])).toEqual([]);
  });
});

describe('driftEvidence', () => {
  it('drops voicemail and calling-settings commands while Discovery has not read those settings', () => {
    const cmds = ['Set-CsOnlineVoicemailUserSettings', 'Set-CsUserCallingSettings', 'Grant-CsOnlineVoiceRoutingPolicy'];
    expect(driftEvidence(cmds, { voicemail: false, callingSettings: false })).toEqual(['Grant-CsOnlineVoiceRoutingPolicy']);
    expect(driftEvidence(cmds, { voicemail: true, callingSettings: true })).toEqual(cmds);
  });
});
