import { describe, expect, it } from 'vitest';
import {
  AGENT_ACTION_CLASSES,
  AGENT_DEFAULT_AUTONOMY,
  AGENT_LEVEL_CAPS,
  AGENT_PROPOSAL_KINDS,
  agentClaimSchema,
  agentEffectiveAutonomy,
  agentHandoffSchema,
  agentLabel,
  agentLevel,
  agentMayActDirectly,
  agentMayExecuteApproved,
  agentMayNote,
  agentMayPropose,
  agentParseProposal,
  agentPolicySchema,
  agentProposalClass,
  agentProposalSchema,
  agentProposalSummary,
  agentTokenHint,
  createAgentSchema,
  createAgentTokenSchema,
  createAgentWebhookSchema,
  formatAgentToken,
  parseAgentToken,
  type AgentProposalKind,
} from './agents';
import { can } from './rbac';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('agent tokens', () => {
  const secret = 'A'.repeat(43);
  it('round-trip through their format', () => {
    const t = formatAgentToken(UUID, secret);
    expect(t).toBe(`vxs_agent_${UUID}_${secret}`);
    expect(parseAgentToken(t)).toEqual({ tokenId: UUID, secret });
    expect(parseAgentToken(`  ${t}\n`)).toEqual({ tokenId: UUID, secret });
  });
  it('reject anything else', () => {
    for (const bad of ['', 'Bearer x', 'vxs_agent_', `vxs_agent_${UUID}`, `vxs_agent_${UUID}_short`, `vxs_agent_not-a-uuid_${secret}`, `vxs_user_${UUID}_${secret}`, `vxs_agent_${UUID}_${secret}!`]) {
      expect(parseAgentToken(bad)).toBeNull();
    }
  });
  it('are only ever hinted at, never shown', () => {
    expect(agentTokenHint('wXyZ')).toBe('vxs_agent_…wXyZ');
  });
  it('get a scope list, an expiry and optional address limits', () => {
    expect(createAgentTokenSchema.parse({ name: 'Runner' })).toMatchObject({ scopes: ['read', 'note', 'propose'], expiresInDays: 90, ipAllow: [] });
    expect(createAgentTokenSchema.safeParse({ name: 'Runner', scopes: [] }).success).toBe(false);
    expect(createAgentTokenSchema.safeParse({ name: 'Runner', scopes: ['sudo'] }).success).toBe(false);
    expect(createAgentTokenSchema.safeParse({ name: 'Runner', expiresInDays: 1000 }).success).toBe(false);
    expect(createAgentTokenSchema.safeParse({ name: 'Runner', ipAllow: ['203.0.113.0/24', '2001:db8::1'] }).success).toBe(true);
    expect(createAgentTokenSchema.safeParse({ name: 'Runner', ipAllow: ['everywhere'] }).success).toBe(false);
  });
});

describe('autonomy', () => {
  it('starts at suggest-only, with no changes', () => {
    const d = agentEffectiveAutonomy(null);
    expect(d.triage).toBe(1);
    expect(d.change_whatif).toBe(0);
    expect(d.change_deploy).toBe(0);
    expect(Object.keys(d).sort()).toEqual([...AGENT_ACTION_CLASSES].sort());
  });
  it('uses what the customer policy says, but never past the cap', () => {
    expect(agentLevel({ triage: 3 }, 'triage')).toBe(3);
    expect(agentLevel({ customer_update: 3 }, 'customer_update')).toBe(2); // customer text stays with a person
    expect(agentLevel({ change_deploy: 3 }, 'change_deploy')).toBe(2); // a deployment is never unattended
    expect(agentLevel({ internal_note: 0 }, 'internal_note')).toBe(0);
    for (const c of AGENT_ACTION_CLASSES) {
      expect(AGENT_DEFAULT_AUTONOMY[c]).toBeLessThanOrEqual(AGENT_LEVEL_CAPS[c]);
      expect(agentLevel({ [c]: 3 }, c)).toBeLessThanOrEqual(AGENT_LEVEL_CAPS[c]);
    }
  });
  it('says what each level allows', () => {
    expect([0, 1, 2, 3].map((l) => agentMayNote(l as 0))).toEqual([false, true, true, true]);
    expect([0, 1, 2, 3].map((l) => agentMayPropose(l as 0))).toEqual([false, true, true, true]);
    expect([0, 1, 2, 3].map((l) => agentMayExecuteApproved(l as 0))).toEqual([false, false, true, true]);
    expect([0, 1, 2, 3].map((l) => agentMayActDirectly(l as 0))).toEqual([false, false, false, true]);
  });
  it('is validated per class, 0 to 3', () => {
    expect(agentPolicySchema.safeParse({ enabled: true, autonomy: { triage: 3, resolve: 1 } }).success).toBe(true);
    expect(agentPolicySchema.safeParse({ enabled: true, autonomy: { triage: 4 } }).success).toBe(false);
    expect(agentPolicySchema.safeParse({ enabled: true, autonomy: { sleep: 1 } }).success).toBe(false);
    expect(agentPolicySchema.parse({ enabled: false })).toEqual({ enabled: false, autonomy: {} });
  });
});

describe('proposals', () => {
  const ok: Record<AgentProposalKind, Record<string, unknown>> = {
    customer_update: { body: 'We have found the cause.' },
    ask_customer: { body: 'Which handsets?' },
    status_change: { to: 'on_hold', holdReason: 'carrier', note: 'Waiting on the carrier' },
    set_priority: { priority: 'p2', reason: 'More people affected' },
    assign_user: { userId: UUID },
    declare_major: { leadId: UUID, summary: 'Calls are failing at Reading.' },
    link_problem: { problemId: UUID },
    link_item: { kind: 'user', ref: 'jo@contoso.test' },
    external: { actionClass: 'diagnostic_read', title: 'Check the number assignment' },
  };
  it('are accepted for every kind with valid params, and refused with bad ones', () => {
    for (const [kind, params] of Object.entries(ok)) {
      expect(agentProposalSchema.safeParse({ kind, params, rationale: 'Because the logs say so' }).success, kind).toBe(true);
    }
    expect(agentProposalSchema.safeParse({ kind: 'status_change', params: { to: 'sideways' }, rationale: 'x y z' }).success).toBe(false);
    expect(agentProposalSchema.safeParse({ kind: 'customer_update', params: {}, rationale: 'x y z' }).success).toBe(false);
    expect(agentProposalSchema.safeParse({ kind: 'customer_update', params: { body: 'Hi', extra: 1 }, rationale: 'x y z' }).success).toBe(false);
    expect(agentProposalSchema.safeParse({ kind: 'teleport', params: {}, rationale: 'x y z' }).success).toBe(false);
    expect(agentProposalSchema.safeParse({ kind: 'customer_update', params: { body: 'Hi' }, rationale: '' }).success).toBe(false);
    expect(agentProposalSchema.safeParse({ kind: 'external', params: { actionClass: 'change_deploy' , title: 'x' }, rationale: 'Because' }).success).toBe(false); // title too short
  });
  it('default to low risk and a day to be decided', () => {
    const p = agentProposalSchema.parse({ kind: 'customer_update', params: { body: 'Hi' }, rationale: 'Because' });
    expect(p).toMatchObject({ risk: 'low', expiresInMinutes: 1440 });
  });
  it('belong to the action class that must allow them', () => {
    expect(agentProposalClass('customer_update', {})).toBe('customer_update');
    expect(agentProposalClass('ask_customer', {})).toBe('customer_update');
    expect(agentProposalClass('status_change', { to: 'on_hold' })).toBe('triage');
    expect(agentProposalClass('status_change', { to: 'in_progress' })).toBe('triage');
    for (const to of ['restored', 'resolved', 'closed']) expect(agentProposalClass('status_change', { to })).toBe('resolve');
    expect(agentProposalClass('set_priority', {})).toBe('triage');
    expect(agentProposalClass('declare_major', {})).toBe('triage');
    expect(agentProposalClass('external', { actionClass: 'change_deploy' })).toBe('change_deploy');
    expect(agentProposalClass('external', { actionClass: 'diagnostic_read' })).toBe('diagnostic_read');
  });
  it('are carried out by the platform when approved, except steps only the agent can do', () => {
    expect(Object.entries(AGENT_PROPOSAL_KINDS).filter(([, v]) => !v.server).map(([k]) => k)).toEqual(['external']);
  });
  it('read back as one line for the approval card', () => {
    for (const [kind, params] of Object.entries(ok)) expect(agentProposalSummary(kind as AgentProposalKind, params).length).toBeGreaterThan(5);
    expect(agentProposalSummary('set_priority', ok.set_priority!)).toBe('Change the priority to P2: More people affected');
    expect(agentParseProposal('assign_user', { userId: 'nope' }).ok).toBe(false);
  });
});

describe('claims, handoffs, webhooks and agents', () => {
  it('claims default to ten minutes and cap at an hour', () => {
    expect(agentClaimSchema.parse({}).ttlSeconds).toBe(600);
    expect(agentClaimSchema.safeParse({ ttlSeconds: 7200 }).success).toBe(false);
    expect(agentClaimSchema.safeParse({ ttlSeconds: 10 }).success).toBe(false);
  });
  it('handoffs need a recommendation and a confidence', () => {
    const ok = { summary: { tried: ['Checked the licence'], found: ['No Phone System licence'], recommendation: 'Assign the licence', confidence: 'high' } };
    expect(agentHandoffSchema.parse(ok)).toMatchObject({ to: 'queue', summary: { evidence: [] } });
    expect(agentHandoffSchema.safeParse({ summary: { ...ok.summary, confidence: 'certain' } }).success).toBe(false);
    expect(agentHandoffSchema.safeParse({ summary: { tried: [], found: [], confidence: 'low' } }).success).toBe(false);
  });
  it('webhooks must be https, or local for development', () => {
    expect(createAgentWebhookSchema.safeParse({ url: 'https://agent.example.com/hook' }).success).toBe(true);
    expect(createAgentWebhookSchema.safeParse({ url: 'http://localhost:8080/hook' }).success).toBe(true);
    expect(createAgentWebhookSchema.safeParse({ url: 'http://agent.example.com/hook' }).success).toBe(false);
    expect(createAgentWebhookSchema.safeParse({ url: 'ftp://agent.example.com/hook' }).success).toBe(false);
    expect(createAgentWebhookSchema.safeParse({ url: 'https://agent.example.com/hook', kinds: ['incident.created', 'sla.breached'] }).success).toBe(true);
    expect(createAgentWebhookSchema.safeParse({ url: 'https://agent.example.com/hook', kinds: ['incident.exploded'] }).success).toBe(false);
  });
  it('agents are created with a kind, and labelled as AI wherever they appear', () => {
    expect(createAgentSchema.parse({ name: 'Triage-bot' })).toMatchObject({ kind: 'general', description: '' });
    expect(createAgentSchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(agentLabel('Triage-bot')).toBe('Triage-bot (AI)');
  });
  it('are managed by Super Admins only', () => {
    expect(can('SUPER_ADMIN', 'agent:manage')).toBe(true);
    for (const r of ['ENGINEER', 'PROJECT_MANAGER', 'CUSTOMER'] as const) expect(can(r, 'agent:manage')).toBe(false);
  });
});
