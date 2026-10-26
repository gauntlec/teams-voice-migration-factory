/*
 * Two people's Teams voice setup side by side ("why can Anna call international numbers and Ben cannot?"), from Discovery.
 * Teams Admin Center shows each user's policies on separate pages; this lines them up and, where two people have different
 * policies of one type, lists the settings inside those policies that differ.
 */
import type { LiveCallingSettings } from './calling-settings';

export interface VoiceProfilePolicy {
  /** the policy name; 'Global' when the user has none assigned directly */
  name: string;
  /** the policy's settings as Discovery stored them; null when the policy itself was not found */
  settings: Record<string, unknown> | null;
}

export interface VoiceProfile {
  id: string;
  upn: string;
  displayName: string | null;
  accountEnabled: boolean | null;
  accountType: string | null;
  enterpriseVoice: boolean;
  number: string | null;
  usageLocation: string | null;
  featureTypes: string[];
  policies: Record<string, VoiceProfilePolicy>;
  callingSettings: LiveCallingSettings | null;
  voicemail: { enabled: boolean | null; language: string | null };
  /** when Discovery last read the calling settings; null = never */
  voiceSettingsAt: string | null;
}

export type VoiceCompareSection = 'Account' | 'Policies' | 'Calling settings' | 'Voicemail';

export interface VoiceCompareRow {
  section: VoiceCompareSection;
  label: string;
  a: string;
  b: string;
  differs: boolean;
  /** For a policy type with different policies: the settings inside them that differ. */
  detail?: { label: string; a: string; b: string }[];
}

/** Policy fields that identify the object rather than configure it. */
const POLICY_META = new Set(['Identity', 'Anchor', 'Key', 'ScopeClass', 'Element', 'XsAnchor', 'PSComputerName', 'RunspaceId', 'PSShowComputerName', 'DataSource', 'Name']);

const NONE = '—';

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return NONE;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.length ? v.map(formatValue).join(', ') : NONE;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** The settings that differ between two policies of the same type, in key order. */
export function policySettingDifferences(a: Record<string, unknown> | null, b: Record<string, unknown> | null): { label: string; a: string; b: string }[] {
  if (!a || !b) return [];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !POLICY_META.has(k)).sort();
  return keys
    .map((k) => ({ label: k, a: formatValue(a[k]), b: formatValue(b[k]) }))
    .filter((d) => d.a !== d.b);
}

function forwardingText(cs: LiveCallingSettings | null): { forward: string; unanswered: string; busy: string; group: string; delegates: string } {
  if (!cs) return { forward: 'Not read yet', unanswered: 'Not read yet', busy: 'Not read yet', group: 'Not read yet', delegates: 'Not read yet' };
  const f = cs.callForwarding.forwarding;
  const u = cs.callForwarding.unanswered;
  const target = (type?: string, t?: string | null) => (type === 'SingleTarget' ? t ?? 'a number or person' : type === 'MyDelegates' ? 'delegates' : type === 'Group' ? 'call group' : type ?? 'voicemail');
  return {
    forward: f?.enabled ? `${f.type === 'Simultaneous' ? 'Also ring' : 'Forward'} to ${target(f.targetType, f.target)}` : 'Off',
    unanswered: u?.enabled === false ? 'Off' : `After ${u?.delaySeconds ?? 20} s to ${target(u?.targetType ?? 'Voicemail', u?.target)}`,
    busy: cs.callForwarding.busyOnBusy ?? 'Default',
    group: cs.pickupGroup?.targets.length ? `${cs.pickupGroup.targets.join(', ')} (${cs.pickupGroup.order === 'InOrder' ? 'in order' : 'all at once'})` : 'None',
    delegates: cs.delegates.length ? cs.delegates.map((d) => d.delegateUpn).join(', ') : 'None',
  };
}

export function compareVoiceProfiles(a: VoiceProfile, b: VoiceProfile): VoiceCompareRow[] {
  const rows: VoiceCompareRow[] = [];
  const add = (section: VoiceCompareSection, label: string, av: unknown, bv: unknown, detail?: VoiceCompareRow['detail']) => {
    const sa = formatValue(av);
    const sb = formatValue(bv);
    rows.push({ section, label, a: sa, b: sb, differs: sa !== sb, ...(detail?.length ? { detail } : {}) });
  };
  add('Account', 'Account enabled', a.accountEnabled, b.accountEnabled);
  add('Account', 'Account type', a.accountType, b.accountType);
  add('Account', 'Enterprise Voice', a.enterpriseVoice, b.enterpriseVoice);
  add('Account', 'Phone number', a.number, b.number);
  add('Account', 'Usage location', a.usageLocation, b.usageLocation);
  add('Account', 'Licensed features', [...a.featureTypes].sort(), [...b.featureTypes].sort());

  const types = [...new Set([...Object.keys(a.policies), ...Object.keys(b.policies)])].sort();
  for (const t of types) {
    const pa = a.policies[t];
    const pb = b.policies[t];
    const detail = pa && pb && pa.name !== pb.name ? policySettingDifferences(pa.settings, pb.settings) : [];
    add('Policies', t, pa?.name ?? 'Global', pb?.name ?? 'Global', detail);
  }

  const fa = forwardingText(a.callingSettings);
  const fb = forwardingText(b.callingSettings);
  add('Calling settings', 'Call forwarding', fa.forward, fb.forward);
  add('Calling settings', 'Unanswered calls', fa.unanswered, fb.unanswered);
  add('Calling settings', 'When busy', fa.busy, fb.busy);
  add('Calling settings', 'Call group', fa.group, fb.group);
  add('Calling settings', 'Delegates', fa.delegates, fb.delegates);

  add('Voicemail', 'Voicemail', a.voicemail.enabled, b.voicemail.enabled);
  add('Voicemail', 'Prompt language', a.voicemail.language, b.voicemail.language);
  return rows;
}
