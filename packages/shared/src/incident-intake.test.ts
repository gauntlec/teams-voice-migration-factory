import { describe, expect, it } from 'vitest';
import { formatIntakeToken, intakeAlertSchema, intakeDedupKey, intakeIncidentFields, intakeSourceCreateSchema, intakeWanted, normaliseIntakeBody, parseIntakeToken } from './incident-intake';
import { incPriority } from './incidents';

const alert = (over = {}) => intakeAlertSchema.parse({ dedupKey: 'sbc1-trunk', title: 'SBC trunk down', ...over });

describe('alerts', () => {
  it('defaults to a major, firing alert and refuses anything unknown', () => {
    expect(alert()).toMatchObject({ severity: 'major', state: 'firing' });
    expect(intakeAlertSchema.safeParse({ dedupKey: 'x', title: 'hi', severity: 'apocalyptic' }).success).toBe(false);
    expect(intakeAlertSchema.safeParse({ dedupKey: 'x', title: 'hello', extra: 1 }).success).toBe(false);
    expect(intakeAlertSchema.safeParse({ title: 'hello' }).success).toBe(false);
  });
  it('turns an alert into an incident with the severity map, the kind\'s category and the source defaults', () => {
    const f = intakeIncidentFields('sbc', { siteCode: 'RDG01' }, alert({ severity: 'critical', description: 'Trunk 1 is not answering OPTIONS', link: 'https://mon/1', details: { trunk: 'carrier-1' } }));
    expect(f).toMatchObject({ title: 'SBC trunk down', category: 'direct_routing', impact: 'company', urgency: 'cannot_call', siteCode: 'RDG01' });
    expect(f.description).toContain('Trunk 1 is not answering OPTIONS');
    expect(f.description).toContain('Link: https://mon/1');
    expect(f.description).toContain('trunk: carrier-1');
    expect(incPriority(f.impact, f.urgency, f.category).priority).toBe('p1');
    // The alert and the source can override.
    expect(intakeIncidentFields('sbc', { category: 'numbers' }, alert({ category: 'users', siteCode: 'LON01' }))).toMatchObject({ category: 'users', siteCode: 'LON01' });
    expect(intakeIncidentFields('generic', { severityMap: { major: { impact: 'team', urgency: 'degraded' } } }, alert())).toMatchObject({ category: 'other', impact: 'team', urgency: 'degraded' });
    expect(intakeIncidentFields('generic', {}, alert({ title: 'Short title' })).description.length).toBeGreaterThanOrEqual(10);
  });
  it('ignores alerts below the minimum severity', () => {
    expect(intakeWanted({}, 'info')).toBe(true);
    expect(intakeWanted({ minSeverity: 'major' }, 'critical')).toBe(true);
    expect(intakeWanted({ minSeverity: 'major' }, 'major')).toBe(true);
    expect(intakeWanted({ minSeverity: 'major' }, 'minor')).toBe(false);
  });
  it('namespaces the dedup key by source', () => {
    expect(intakeDedupKey('s1', 'k')).toBe('s1:k');
  });
});

describe('Microsoft 365 service health', () => {
  const issue = { id: 'MO12345', title: 'Users can\'t make Teams calls', service: 'Microsoft Teams', classification: 'incident', status: 'investigating', impactDescription: 'Some users cannot place PSTN calls.' };
  it('maps an issue to an alert, and a resolved one to a clearing alert with the same key', () => {
    const r = normaliseIntakeBody('microsoft_health', issue);
    expect(r.ok && r.alert).toMatchObject({ dedupKey: 'ms:MO12345', severity: 'major', state: 'firing', category: 'microsoft_service' });
    expect(r.ok && r.alert.title).toBe("Microsoft Teams: Users can't make Teams calls");
    const done = normaliseIntakeBody('microsoft_health', { ...issue, status: 'serviceRestored', isResolved: true });
    expect(done.ok && done.alert).toMatchObject({ dedupKey: 'ms:MO12345', state: 'resolved' });
    expect(normaliseIntakeBody('microsoft_health', { ...issue, classification: 'advisory' }).ok && (normaliseIntakeBody('microsoft_health', { ...issue, classification: 'advisory' }) as { alert: { severity: string } }).alert.severity).toBe('minor');
  });
  it('takes a canonical alert on any kind, and explains what is expected otherwise', () => {
    expect(normaliseIntakeBody('sbc', { dedupKey: 'a', title: 'Hello there' }).ok).toBe(true);
    expect(normaliseIntakeBody('sbc', { dedupKey: 'a', title: 'x' })).toMatchObject({ ok: false });
    expect(normaliseIntakeBody('sbc', { nope: 1 })).toMatchObject({ ok: false, error: expect.stringContaining('dedupKey') });
    expect(normaliseIntakeBody('microsoft_health', {})).toMatchObject({ ok: false });
  });
});

describe('tokens and sources', () => {
  it('round-trips a token and rejects the malformed', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const secret = 'a'.repeat(43);
    expect(parseIntakeToken(formatIntakeToken(id, secret))).toEqual({ sourceId: id, secret });
    expect(parseIntakeToken('vxs_agent_x')).toBeNull();
    expect(parseIntakeToken(`vxs_intake_${id}_short`)).toBeNull();
  });
  it('validates a new source', () => {
    expect(intakeSourceCreateSchema.parse({ name: 'SBC monitor' })).toMatchObject({ kind: 'generic', config: {}, ipAllow: [] });
    expect(intakeSourceCreateSchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(intakeSourceCreateSchema.safeParse({ name: 'SBC', config: { category: 'nope' } }).success).toBe(false);
    expect(intakeSourceCreateSchema.safeParse({ name: 'SBC', config: { minSeverity: 'major', autoRestore: true } }).success).toBe(true);
  });
});
