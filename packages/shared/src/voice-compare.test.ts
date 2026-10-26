import { describe, expect, it } from 'vitest';
import { compareVoiceProfiles, policySettingDifferences, type VoiceProfile } from './voice-compare';

const profile = (over: Partial<VoiceProfile> = {}): VoiceProfile => ({
  id: 'a',
  upn: 'anna@contoso.test',
  displayName: 'Anna',
  accountEnabled: true,
  accountType: 'User',
  enterpriseVoice: true,
  number: '+441582000001',
  usageLocation: 'GB',
  featureTypes: ['Teams', 'PhoneSystem'],
  policies: {
    OnlineVoiceRoutingPolicy: { name: 'UK-International', settings: { Identity: 'Tag:UK-International', OnlinePstnUsages: ['UK', 'International'], Description: 'All calls' } },
    TeamsCallingPolicy: { name: 'Global', settings: { AllowVoicemail: 'UserOverride' } },
  },
  callingSettings: { callForwarding: { unanswered: { enabled: true, delaySeconds: 20, targetType: 'Voicemail' } }, pickupGroup: null, delegates: [] },
  voicemail: { enabled: true, language: 'en-GB' },
  voiceSettingsAt: '2026-10-26T08:00:00Z',
  ...over,
});

describe('compareVoiceProfiles', () => {
  it('finds the policy that explains the difference, and the settings inside it that differ', () => {
    const ben = profile({
      id: 'b',
      upn: 'ben@contoso.test',
      featureTypes: ['PhoneSystem', 'Teams'],
      policies: {
        OnlineVoiceRoutingPolicy: { name: 'UK-National', settings: { Identity: 'Tag:UK-National', OnlinePstnUsages: ['UK'], Description: 'All calls' } },
        TeamsCallingPolicy: { name: 'Global', settings: { AllowVoicemail: 'UserOverride' } },
      },
    });
    const rows = compareVoiceProfiles(profile(), ben);
    const routing = rows.find((r) => r.label === 'OnlineVoiceRoutingPolicy')!;
    expect(routing).toMatchObject({ a: 'UK-International', b: 'UK-National', differs: true });
    expect(routing.detail).toEqual([{ label: 'OnlinePstnUsages', a: 'UK, International', b: 'UK' }]);
    // the same features in another order are not a difference
    expect(rows.find((r) => r.label === 'Licensed features')!.differs).toBe(false);
    expect(rows.filter((r) => r.differs).map((r) => r.label)).toEqual(['OnlineVoiceRoutingPolicy']);
  });

  it('treats a policy type one person lacks as the Global policy', () => {
    const ben = profile({ policies: { OnlineVoiceRoutingPolicy: { name: 'UK-International', settings: {} } } });
    expect(compareVoiceProfiles(profile(), ben).find((r) => r.label === 'TeamsCallingPolicy')).toMatchObject({ a: 'Global', b: 'Global', differs: false });
  });

  it('says calling settings were not read yet rather than guessing', () => {
    const rows = compareVoiceProfiles(profile(), profile({ callingSettings: null }));
    expect(rows.find((r) => r.label === 'Unanswered calls')).toMatchObject({ a: 'After 20 s to Voicemail', b: 'Not read yet', differs: true });
  });
});

describe('policySettingDifferences', () => {
  it('ignores identity fields and returns nothing when a policy is missing', () => {
    expect(policySettingDifferences({ Identity: 'Tag:A', X: 1 }, { Identity: 'Tag:B', X: 1 })).toEqual([]);
    expect(policySettingDifferences(null, { X: 1 })).toEqual([]);
  });
});
