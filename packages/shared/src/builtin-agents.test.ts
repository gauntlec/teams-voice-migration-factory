import { describe, expect, it } from 'vitest';
import { BUILTIN_AGENTS, BUILTIN_AGENT_KEYS, commsDraft, commsDue, diagnoseOutcome, triageAnalysis, type TriageContext } from './builtin-agents';
import { AGENT_ACTION_CLASSES, AGENT_KINDS, agentLevel } from './agents';
import { diagFinish } from './diagnostics';

const NOW = new Date('2026-10-14T12:00:00Z');
const mins = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const base = (over: Partial<TriageContext> = {}): TriageContext => ({
  incident: { reference: 'INC-0042', title: 'No audio', priority: 'p2', status: 'new', category: 'call_quality', sitecode: 'RDG01', created_at: mins(1), problem_id: null, major: false },
  knownErrors: [],
  similar: [],
  now: NOW,
  ...over,
});

describe('the catalogue', () => {
  it('has a definition for each key, with a valid kind and autonomy within the caps', () => {
    for (const k of BUILTIN_AGENT_KEYS) {
      const d = BUILTIN_AGENTS[k];
      expect(d.key).toBe(k);
      expect(AGENT_KINDS).toContain(d.kind);
      for (const [cls, lvl] of Object.entries(d.suggestedAutonomy)) {
        expect(AGENT_ACTION_CLASSES).toContain(cls);
        expect(agentLevel(d.suggestedAutonomy, cls as never)).toBe(lvl);
      }
      expect(d.name).toMatch(/^Voxshift /);
    }
  });
});

describe('triage', () => {
  it('says plainly when there is nothing to go on', () => {
    const t = triageAnalysis(base());
    expect(t.proposals).toEqual([]);
    expect(t.confidence).toBe('low');
    expect(t.note).toContain('Nothing to go on yet');
    expect(t.note).toContain('automated assistant');
  });
  it('matches a known error, and proposes linking it only if the incident has no problem yet', () => {
    const ke = [{ id: 'p1', reference: 'PRB-0003', title: 'Wifi drops RTP', workaround: 'Use wired handsets' }];
    const t = triageAnalysis(base({ knownErrors: ke }));
    expect(t.confidence).toBe('medium');
    expect(t.note).toContain('Workaround: Use wired handsets');
    expect(t.proposals).toMatchObject([{ kind: 'link_problem', params: { problemId: 'p1' }, risk: 'low' }]);
    expect(triageAnalysis(base({ knownErrors: ke, incident: { ...base().incident, problem_id: 'p1' } })).proposals).toEqual([]);
  });
  it('proposes a duplicate only for a very recent, same-site, same-kind incident, and never for a major', () => {
    const sim = (m: number, site = 'RDG01') => ({ id: `i${m}`, reference: `INC-00${m}`, title: 'x', status: 'in_progress' as const, priority: 'p2' as const, sitecode: site, created_at: mins(m) });
    const t = triageAnalysis(base({ similar: [sim(10)] }));
    expect(t.proposals).toMatchObject([{ kind: 'status_change', params: { to: 'duplicate', duplicateOf: 'i10' }, risk: 'medium' }]);
    expect(triageAnalysis(base({ similar: [sim(10, 'LON01')] })).proposals).toEqual([]);
    expect(triageAnalysis(base({ similar: [sim(120)] })).proposals).toEqual([]);
    expect(triageAnalysis(base({ similar: [sim(10)], incident: { ...base().incident, major: true } })).proposals).toEqual([]);
  });
  it('suggests a wider problem when several are open at one site', () => {
    const sim = (n: number) => ({ id: `i${n}`, reference: `INC-00${n}`, title: 'x', status: 'new' as const, priority: 'p3' as const, sitecode: 'RDG01', created_at: mins(300 + n) });
    const t = triageAnalysis(base({ similar: [sim(1), sim(2)] }));
    expect(t.found.join(' ')).toContain('3 open incidents of this kind at RDG01');
    expect(t.recommendation).toContain('major incident');
  });
});

describe('diagnose', () => {
  const fresh = '2026-10-13T12:00:00Z';
  it('writes up problems first and recommends the first one', () => {
    const r = diagFinish('user_voice', 'anna@x.com', [{ status: 'fail', title: 'Enterprise Voice is off' }, { status: 'ok', title: 'o' }], fresh, NOW);
    const d = diagnoseOutcome('INC-0042', [r]);
    expect(d.hasProblem).toBe(true);
    expect(d.confidence).toBe('high');
    expect(d.recommendation).toBe('Start with: anna@x.com: Enterprise Voice is off.');
    expect(d.tried).toEqual(['User voice setup: anna@x.com']);
    expect(d.note).toContain('not the live tenant');
  });
  it('is honest when it found nothing, and when the data is old', () => {
    const r = diagFinish('routing_check', 'Routes and gateways', [{ status: 'ok', title: 'fine' }], '2026-10-01T00:00:00Z', NOW);
    const d = diagnoseOutcome('INC-1', [r]);
    expect(d.hasProblem).toBe(false);
    expect(d.confidence).toBe('low');
    expect(d.recommendation).toContain('out of date');
    expect(d.tried).toEqual(['Calling routes and gateways']);
  });
});

describe('comms', () => {
  const c = (over = {}) => ({ priority: 'p1' as const, status: 'in_progress' as const, holdReason: null, major: false, createdAt: mins(10), lastPublicUpdateAt: null, title: 'No calls at Reading', now: NOW, ...over });
  it('is due on P1 after 30 minutes and on P2 after 2 hours, never on P3', () => {
    expect(commsDue(c({ createdAt: mins(29) }))).toBe(false);
    expect(commsDue(c({ createdAt: mins(31) }))).toBe(true);
    expect(commsDue(c({ createdAt: mins(300), lastPublicUpdateAt: mins(5) }))).toBe(false);
    expect(commsDue(c({ priority: 'p2', createdAt: mins(100) }))).toBe(false);
    expect(commsDue(c({ priority: 'p2', createdAt: mins(130) }))).toBe(true);
    expect(commsDue(c({ priority: 'p3', createdAt: mins(5000) }))).toBe(false);
  });
  it('leaves majors, finished incidents and ones waiting on the customer alone', () => {
    expect(commsDue(c({ createdAt: mins(60), major: true }))).toBe(false);
    expect(commsDue(c({ createdAt: mins(60), status: 'resolved' }))).toBe(false);
    expect(commsDue(c({ createdAt: mins(60), status: 'on_hold', holdReason: 'customer' }))).toBe(false);
    expect(commsDue(c({ createdAt: mins(60), status: 'on_hold', holdReason: 'carrier' }))).toBe(true);
  });
  it('drafts only what the record says', () => {
    expect(commsDraft(c({ createdAt: mins(60) }))).toBe('An update on "No calls at Reading". An engineer is working on it. We will update you again within 30 minutes, or sooner if anything changes. Reply here if anything changes at your end.');
    expect(commsDraft(c({ status: 'on_hold', holdReason: 'carrier', priority: 'p2' }))).toContain('We are waiting on your carrier, and we are chasing them.');
    expect(commsDraft(c({ status: 'new', priority: 'p2' }))).toContain('within 2 hours');
    expect(commsDraft(c({ status: 'new' }))).toContain('an engineer is picking it up');
  });
});
