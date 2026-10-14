import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Field, Input, Select, Text, makeStyles, shorthands, tokens , mergeClasses } from '@fluentui/react-components';
import { AGENT_PROPOSAL_STATE_LABELS, SR_DEPLOY_GUARDRAILS, agentLabel, type AgentProposalState, type SrAutomation } from '@tvmf/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { errorText, when } from '../pages/ServiceRequests';

const useLocalStyles = makeStyles({
  flexColRowGap8: { display: "flex", flexDirection: "column", rowGap: '8px' },
  preWrap: { whiteSpace: "pre-wrap" },
  minW260: { minWidth: '260px' },
  flexColRowGap6: { display: "flex", flexDirection: "column", rowGap: '6px' },
  pl20Margin0: { ...shorthands.margin("0px"), paddingLeft: '20px' },
});


const useStyles = makeStyles({
  card: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  row: { display: 'flex', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  muted: { color: tokens.colorNeutralForeground3 },
  error: { color: tokens.colorPaletteRedForeground1 },
  banner: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalS, ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM), ...shorthands.borderRadius(tokens.borderRadiusMedium), ...shorthands.border('1px', 'solid', tokens.colorBrandStroke2), backgroundColor: tokens.colorBrandBackground2 },
  hold: { ...shorthands.border('1px', 'solid', tokens.colorPaletteYellowBorder1), backgroundColor: tokens.colorPaletteYellowBackground1 },
  proposal: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXS, ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM), ...shorthands.borderRadius(tokens.borderRadiusMedium), ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2) },
  pending: { ...shorthands.border('1px', 'solid', tokens.colorBrandStroke1) },
  commands: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '220px', overflowY: 'auto', ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM), ...shorthands.borderRadius(tokens.borderRadiusMedium), backgroundColor: tokens.colorNeutralBackground3 },
});

export interface SrAssistantProposal {
  id: string;
  kind: string;
  action_class: string;
  summary: string;
  params: { args?: { commands?: { upn: string; commands: string[] }[]; calls?: number } } & Record<string, unknown>;
  rationale: string;
  risk: 'low' | 'medium' | 'high';
  state: AgentProposalState;
  agent_name: string;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  error: string | null;
  created_at: string;
  expires_at: string;
}
export interface SrAssistantInfo {
  hold: boolean;
  claim: { agent_id: string; agent_name: string; expires_at: string; started_at: string; note: string } | null;
  automation: SrAutomation;
  whatif: { summary: string | null; at: string } | null;
  proposals: SrAssistantProposal[];
}

const STATE_COLOR: Record<AgentProposalState, 'brand' | 'success' | 'subtle' | 'danger' | 'warning'> = { proposed: 'brand', approved: 'warning', rejected: 'subtle', running: 'warning', done: 'success', failed: 'danger', expired: 'subtle' };
const RISK_COLOR = { low: 'success', medium: 'warning', high: 'danger' } as const;

/**
 * An AI assistant's side of a service request, for engineers: whether an assistant could carry it through, who holds it (and for
 * how long) with a Take over button, hand-back, and the steps it proposes for you to approve or reject. A deployment shows the exact
 * commands and is approved onto one of your own signed-in tenant sessions: that is the one approval.
 */
export function RequestAssistantCard({ base, requestId, status, agent, assignedAgentName, onChanged }: { base: string; requestId: string; status: string; agent: SrAssistantInfo; assignedAgentName: string | null; onChanged: () => void }) {
  const ls = useLocalStyles();
  const s = useStyles();
  const qc = useQueryClient();
  const { activeTenantId } = useAuth();
  const [handBackTo, setHandBackTo] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [conn, setConn] = useState('');
  const open = ['new', 'planned', 'built'].includes(status);
  const agents = useQuery({ queryKey: ['sr-agents', base], queryFn: () => api<{ id: string; name: string }[]>(`${base}/agents`) });
  const pending = agent.proposals.filter((p) => p.state === 'proposed');
  const earlier = agent.proposals.filter((p) => p.state !== 'proposed');
  const needsSession = pending.some((p) => p.action_class === 'change_deploy');
  const sessions = useQuery({
    queryKey: ['connections', activeTenantId],
    enabled: needsSession && !!activeTenantId,
    refetchInterval: 8000,
    queryFn: () => api<{ id: string; status: string; upn: string | null; tenant_domain: string | null }[]>(`/t/${activeTenantId}/deployments/connections`),
  });
  const live = (sessions.data ?? []).filter((c) => c.status === 'active');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['service-request', base, requestId] });
    qc.invalidateQueries({ queryKey: ['service-request-design', base, requestId] });
    qc.invalidateQueries({ queryKey: ['sr-runs', base, requestId] });
    qc.invalidateQueries({ queryKey: ['service-requests'] });
    onChanged();
  };
  const takeOver = useMutation({ mutationFn: () => api(`${base}/${requestId}/takeover`, { method: 'POST' }), onSuccess: refresh });
  const handBack = useMutation({ mutationFn: () => api(`${base}/${requestId}/hand-back`, { method: 'POST', body: JSON.stringify({ agentId: handBackTo }) }), onSuccess: () => (setHandBackTo(''), refresh()) });
  const decide = useMutation({
    mutationFn: (v: { p: SrAssistantProposal; decision: 'approve' | 'reject' }) =>
      api(`${base}/${requestId}/proposals/${v.p.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: v.decision, note: notes[v.p.id]?.trim() || undefined, ...(v.decision === 'approve' && v.p.action_class === 'change_deploy' ? { connectionId: conn || live[0]?.id } : {}) }) }),
    onSuccess: refresh,
  });
  if (!open && !agent.claim && !agent.hold && !assignedAgentName && agent.proposals.length === 0) return null;
  const error = takeOver.error ?? handBack.error ?? decide.error;
  const a = agent.automation;

  return (
    <Card className={s.card}>
      <Text weight="semibold">Assistant</Text>
      {open && (
        <Text size={200} className={s.muted}>
          {a.eligible ? (
            <>
              An assistant could carry this request through: it would {a.applies.join(', ')}. A deployment still needs your approval, command for command.
              {a.followUps.length ? ` Left for a person afterwards: ${a.followUps.join(' ')}` : ''}
            </>
          ) : (
            <>An assistant can&apos;t carry this request through. {a.reasons.join(' ')}</>
          )}
        </Text>
      )}
      {agent.whatif && (
        <Text size={200} className={s.muted}>
          Latest What-If ({when(agent.whatif.at)}): {agent.whatif.summary}
        </Text>
      )}
      {agent.claim && (
        <div className={s.banner}>
          <Text>
            <b>{agentLabel(agent.claim.agent_name)}</b> is working this request. Its lease runs until {new Date(agent.claim.expires_at).toLocaleTimeString()}.
            {agent.claim.note ? ` ${agent.claim.note}` : ''}
          </Text>
          <Button disabled={takeOver.isPending} onClick={() => window.confirm('Take this over? The assistant stops, and can read the request but not change it until you hand it back.') && takeOver.mutate()}>
            Take over
          </Button>
        </div>
      )}
      {!agent.claim && assignedAgentName && !agent.hold && (
        <div className={s.banner}>
          <Text>
            Assigned to <b>{assignedAgentName}</b>, which is not working it right now.
          </Text>
          <Button disabled={takeOver.isPending} onClick={() => takeOver.mutate()}>
            Take over
          </Button>
        </div>
      )}
      {agent.hold && (
        <div className={`${s.banner} ${s.hold}`}>
          <Text>
            <b>You took this over.</b> Assistants can read this request but not change it until you hand it back.
          </Text>
          <div className={s.row}>
            <Select value={handBackTo} onChange={(_, d) => setHandBackTo(d.value)} aria-label="Hand back to">
              <option value="">Hand back to…</option>
              {(agents.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {agentLabel(x.name)}
                </option>
              ))}
            </Select>
            <Button disabled={!handBackTo || handBack.isPending} onClick={() => handBack.mutate()}>
              Hand back
            </Button>
          </div>
        </div>
      )}

      {pending.length > 0 && (
        <div className={ls.flexColRowGap8}>
          <Text weight="semibold">Waiting for your decision ({pending.length})</Text>
          {pending.map((p) => {
            const deploy = p.action_class === 'change_deploy';
            const cmds = p.params.args?.commands ?? [];
            return (
              <div key={p.id} className={`${s.proposal} ${s.pending}`}>
                <div className={s.row}>
                  <Text weight="semibold">{agentLabel(p.agent_name)} proposes</Text>
                  <Badge appearance="outline" color={RISK_COLOR[p.risk]}>
                    {p.risk} risk
                  </Badge>
                  <Text size={100} className={s.muted}>
                    expires {new Date(p.expires_at).toLocaleString()}
                  </Text>
                </div>
                <Text className={ls.preWrap}>{p.summary}</Text>
                <Text size={200} className={mergeClasses(s.muted, ls.preWrap)}>
                  Why: {p.rationale}
                </Text>
                {deploy && (
                  <>
                    <Text size={200} weight="semibold">
                      You are approving exactly these {p.params.args?.calls ?? cmds.length} command{(p.params.args?.calls ?? cmds.length) === 1 ? '' : 's'}. If anything about the plan changes, the approval no longer applies.
                    </Text>
                    <div className={s.commands}>{cmds.map((c) => `# ${c.upn}\n${c.commands.join('\n')}`).join('\n\n')}</div>
                    <Field label="Run it on this tenant session of yours" validationMessage={!live.length ? 'You have no signed-in session for this customer. Connect on the Deploy tab first.' : undefined}>
                      <Select value={conn || live[0]?.id || ''} onChange={(_, d) => setConn(d.value)}>
                        {live.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.upn ?? 'Signed in'}
                            {c.tenant_domain ? ` · ${c.tenant_domain}` : ''}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Text size={100} className={s.muted}>
                      It runs as you, on your session, then the live tenant is re-read and must match the design before the request is marked Deployed.
                    </Text>
                  </>
                )}
                <div className={s.row}>
                  <Field>
                    <Input size="small" value={notes[p.id] ?? ''} maxLength={1000} placeholder="Note (optional)" onChange={(_, d) => setNotes({ ...notes, [p.id]: d.value })} className={ls.minW260} />
                  </Field>
                  <Button appearance="primary" size="small" disabled={decide.isPending || (deploy && !live.length)} onClick={() => decide.mutate({ p, decision: 'approve' })}>
                    {deploy ? 'Approve and deploy' : 'Approve'}
                  </Button>
                  <Button size="small" disabled={decide.isPending} onClick={() => decide.mutate({ p, decision: 'reject' })}>
                    Reject
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {earlier.length > 0 && (
        <div className={ls.flexColRowGap6}>
          <Text weight="semibold" size={200}>
            Earlier proposals
          </Text>
          {earlier.map((p) => (
            <div key={p.id} className={s.proposal}>
              <div className={s.row}>
                <Badge appearance="tint" color={STATE_COLOR[p.state]}>
                  {AGENT_PROPOSAL_STATE_LABELS[p.state]}
                </Badge>
                <Text size={200}>{p.summary}</Text>
              </div>
              <Text size={100} className={s.muted}>
                {agentLabel(p.agent_name)} · {when(p.created_at)}
                {p.decided_by_name ? ` · decided by ${p.decided_by_name}` : ''}
                {p.decision_note ? ` · "${p.decision_note}"` : ''}
              </Text>
              {p.error && (
                <Text size={200} className={s.error}>
                  {p.error}
                </Text>
              )}
            </div>
          ))}
        </div>
      )}
      <details>
        <summary>
          <Text size={200}>What keeps an assistant&apos;s deployment safe</Text>
        </summary>
        <ul className={ls.pl20Margin0}>
          {SR_DEPLOY_GUARDRAILS.map((g) => (
            <li key={g}>
              <Text size={200}>{g}</Text>
            </li>
          ))}
        </ul>
      </details>
      {error && <Text className={s.error}>{errorText(error, 'That did not work')}</Text>}
    </Card>
  );
}
