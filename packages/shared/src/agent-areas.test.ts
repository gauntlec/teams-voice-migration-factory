import { describe, expect, it } from 'vitest';
import { AGENT_ACTION_CLASSES, AGENT_CLASSES_BY_DOMAIN, AGENT_DOMAINS, agentClassesFor, agentWorksOnText } from './agents';
import { BUILTIN_AGENTS } from './builtin-agents';

describe('where an assistant works', () => {
  it('asks only about the actions that matter for its areas', () => {
    expect(agentClassesFor(['incidents'])).toEqual(['triage', 'internal_note', 'customer_update', 'diagnostic_read', 'resolve']);
    expect(agentClassesFor(['service_requests'])).toEqual(['triage', 'internal_note', 'customer_update', 'change_design', 'change_whatif', 'change_deploy']);
    expect(agentClassesFor(['incidents', 'service_requests'])).toEqual([...AGENT_ACTION_CLASSES]);
    expect(agentClassesFor([])).toEqual([]);
  });

  it('puts every kind of action in at least one area, and only the shared three in both', () => {
    const both = AGENT_CLASSES_BY_DOMAIN.incidents.filter((c) => AGENT_CLASSES_BY_DOMAIN.service_requests.includes(c));
    expect(both.sort()).toEqual(['customer_update', 'internal_note', 'triage']);
    for (const c of AGENT_ACTION_CLASSES) expect(AGENT_DOMAINS.some((d) => AGENT_CLASSES_BY_DOMAIN[d].includes(c))).toBe(true);
  });

  it('describes the areas in words', () => {
    expect(agentWorksOnText(['incidents'])).toBe('Incidents');
    expect(agentWorksOnText(['service_requests'])).toBe('Service requests');
    expect(agentWorksOnText(['service_requests', 'incidents'])).toBe('Incidents and service requests');
  });

  it('keeps the built-in assistants to their one job', () => {
    expect(BUILTIN_AGENTS.changes.worksOn).toEqual(['service_requests']);
    for (const k of ['triage', 'diagnose', 'comms'] as const) expect(BUILTIN_AGENTS[k].worksOn).toEqual(['incidents']);
  });
});
