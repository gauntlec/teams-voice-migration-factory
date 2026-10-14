import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Field, Input, Select, Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { AGENT_PROPOSAL_STATE_LABELS, agentLabel, type AgentProposalState } from '@tvmf/shared';
import { api } from '../api';
import { errorText, when } from '../pages/ServiceRequests';

const useStyles = makeStyles({
  card: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  row: { display: 'flex', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  muted: { color: tokens.colorNeutralForeground3 },
  error: { color: tokens.colorPaletteRedForeground1 },
  banner: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalS, ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM), ...shorthands.borderRadius(tokens.borderRadiusMedium), ...shorthands.border('1px', 'solid', tokens.colorBrandStroke2), backgroundColor: tokens.colorBrandBackground2 },
  hold: { ...shorthands.border('1px', 'solid', tokens.colorPaletteYellowBorder1), backgroundColor: tokens.colorPaletteYellowBackground1 },
  proposal: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXS, ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM), ...shorthands.borderRadius(tokens.borderRadiusMedium), ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2) },
  pending: { ...shorthands.border('1px', 'solid', tokens.colorBrandStroke1) },
});

export interface AssistantProposal {
  id: string;
  kind: string;
  action_class: string;
  summary: string;
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
export interface AssistantInfo {
  hold: boolean;
  claim: { agent_id: string; agent_name: string; expires_at: string; started_at: string; note: string } | null;
  proposals: AssistantProposal[];
}

const STATE_COLOR: Record<AgentProposalState, 'brand' | 'success' | 'subtle' | 'danger' | 'warning'> = { proposed: 'brand', approved: 'warning', rejected: 'subtle', running: 'warning', done: 'success', failed: 'danger', expired: 'subtle' };
const RISK_COLOR = { low: 'success', medium: 'warning', high: 'danger' } as const;

/**
 * An AI assistant's side of an incident, for engineers: who is working it (and for how long), a Take over button that
 * locks the assistant out of writing, hand-back, and the next steps it proposes for you to approve or reject.
 */
export function IncidentAssistantCard({ base, incidentId, agent, assignedAgentName, onChanged }: { base: string; incidentId: string; agent: AssistantInfo; assignedAgentName: string | null; onChanged: () => void }) {
  const s = useStyles();
  const qc = useQueryClient();
  const [handBackTo, setHandBackTo] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const agents = useQuery({ queryKey: ['incident-agents', base], queryFn: () => api<{ id: string; name: string }[]>(`${base}/agents`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['incident', base, incidentId] });
    qc.invalidateQueries({ queryKey: ['incidents'] });
    onChanged();
  };
  const takeOver = useMutation({ mutationFn: () => api(`${base}/${incidentId}/takeover`, { method: 'POST' }), onSuccess: refresh });
  const handBack = useMutation({ mutationFn: () => api(`${base}/${incidentId}/hand-back`, { method: 'POST', body: JSON.stringify({ agentId: handBackTo }) }), onSuccess: () => (setHandBackTo(''), refresh()) });
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'approve' | 'reject' }) => api(`${base}/${incidentId}/proposals/${v.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: v.decision, note: notes[v.id]?.trim() || undefined }) }),
    onSuccess: refresh,
  });
  const pending = agent.proposals.filter((p) => p.state === 'proposed');
  const earlier = agent.proposals.filter((p) => p.state !== 'proposed');
  if (!agent.claim && !agent.hold && !assignedAgentName && agent.proposals.length === 0) return null;
  const error = takeOver.error ?? handBack.error ?? decide.error;

  return (
    <Card className={s.card}>
      <Text weight="semibold">Assistant</Text>
      {agent.claim && (
        <div className={s.banner}>
          <Text>
            <b>{agentLabel(agent.claim.agent_name)}</b> is working this incident. Its lease runs until {new Date(agent.claim.expires_at).toLocaleTimeString()}.
            {agent.claim.note ? ` ${agent.claim.note}` : ''}
          </Text>
          <Button disabled={takeOver.isPending} onClick={() => window.confirm('Take this over? The assistant stops, and can read the incident but not change it until you hand it back.') && takeOver.mutate()}>
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
            <b>You took this over.</b> Assistants can read this incident but not change it until you hand it back.
          </Text>
          <div className={s.row}>
            <Select value={handBackTo} onChange={(_, d) => setHandBackTo(d.value)} aria-label="Hand back to">
              <option value="">Hand back to…</option>
              {(agents.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {agentLabel(a.name)}
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
        <div style={{ display: 'flex', flexDirection: 'column', rowGap: 8 }}>
          <Text weight="semibold">Waiting for your decision ({pending.length})</Text>
          {pending.map((p) => (
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
              <Text style={{ whiteSpace: 'pre-wrap' }}>{p.summary}</Text>
              <Text size={200} className={s.muted} style={{ whiteSpace: 'pre-wrap' }}>
                Why: {p.rationale}
              </Text>
              <div className={s.row}>
                <Field>
                  <Input size="small" value={notes[p.id] ?? ''} maxLength={1000} placeholder="Note (optional)" onChange={(_, d) => setNotes({ ...notes, [p.id]: d.value })} style={{ minWidth: 260 }} />
                </Field>
                <Button appearance="primary" size="small" disabled={decide.isPending} onClick={() => decide.mutate({ id: p.id, decision: 'approve' })}>
                  Approve
                </Button>
                <Button size="small" disabled={decide.isPending} onClick={() => decide.mutate({ id: p.id, decision: 'reject' })}>
                  Reject
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {earlier.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', rowGap: 6 }}>
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
              {p.error && <Text size={200} className={s.error}>{p.error}</Text>}
            </div>
          ))}
        </div>
      )}
      {error && <Text className={s.error}>{errorText(error, 'That did not work')}</Text>}
    </Card>
  );
}
