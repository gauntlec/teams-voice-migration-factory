import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Select, Text, makeStyles, tokens } from '@fluentui/react-components';
import { INC_PROBLEM_STATUS_LABELS, type IncProblemStatus } from '@tvmf/shared';
import { api } from '../api';
import { errorText } from '../pages/ServiceRequests';
import { ProblemDialog } from './ProblemDialog';

const useStyles = makeStyles({
  card: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  row: { display: 'flex', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  muted: { color: tokens.colorNeutralForeground3 },
  error: { color: tokens.colorPaletteRedForeground1 },
  facts: { display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: tokens.spacingHorizontalL, rowGap: tokens.spacingVerticalXXS },
});

export interface LinkedProblem {
  id: string;
  reference: string;
  title: string;
  status: IncProblemStatus;
  root_cause: string;
  workaround: string;
}

interface KnownError {
  id: string;
  reference: string;
  title: string;
  status: IncProblemStatus;
  workaround: string;
  root_cause: string;
}

/**
 * Engineers: the problem behind this incident, or the known errors that might explain it. Linking an
 * incident to a problem means the fix for the cause is tracked once, not once per incident.
 */
export function IncidentProblemCard({ base, incident, problem, onChanged }: { base: string; incident: { id: string; title: string; category: string; subcategory: string | null }; problem: LinkedProblem | null; onChanged: () => void }) {
  const s = useStyles();
  const qc = useQueryClient();
  const [picked, setPicked] = useState('');
  const [creating, setCreating] = useState(false);
  const known = useQuery({
    queryKey: ['incident-known-errors', base, incident.category, incident.subcategory],
    enabled: !problem,
    queryFn: () => api<KnownError[]>(`${base}/known-errors?category=${incident.category}${incident.subcategory ? `&subcategory=${incident.subcategory}` : ''}`),
  });
  const open = useQuery({ queryKey: ['incident-problems', base, 'open'], enabled: !problem, queryFn: () => api<{ id: string; reference: string; title: string }[]>(`${base}/problems?status=open`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['incident', base, incident.id] });
    qc.invalidateQueries({ queryKey: ['incident-problems'] });
    onChanged();
  };
  const link = useMutation({ mutationFn: (problemId: string | null) => api(`${base}/${incident.id}/problem`, { method: 'POST', body: JSON.stringify({ problemId }) }), onSuccess: () => (setPicked(''), refresh()) });

  return (
    <Card className={s.card}>
      <Text weight="semibold">Problem</Text>
      {problem ? (
        <>
          <div className={s.row}>
            <Text>
              {problem.reference} · {problem.title}
            </Text>
            <Badge appearance="tint" color={problem.status === 'resolved' ? 'success' : problem.status === 'investigating' ? 'informative' : 'warning'}>
              {INC_PROBLEM_STATUS_LABELS[problem.status]}
            </Badge>
            <Button size="small" disabled={link.isPending} onClick={() => link.mutate(null)}>
              Unlink
            </Button>
          </div>
          <div className={s.facts}>
            {problem.root_cause && (
              <>
                <Text className={s.muted}>Root cause</Text>
                <Text style={{ whiteSpace: 'pre-wrap' }}>{problem.root_cause}</Text>
              </>
            )}
            {problem.workaround && (
              <>
                <Text className={s.muted}>Workaround</Text>
                <Text style={{ whiteSpace: 'pre-wrap' }}>{problem.workaround}</Text>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          {(known.data ?? []).length > 0 && (
            <div>
              <Text weight="semibold" size={200}>
                Known errors that may explain this
              </Text>
              {known.data!.map((k) => (
                <div key={k.id} style={{ marginTop: 6 }}>
                  <div className={s.row}>
                    <Text>
                      {k.reference} · {k.title}
                    </Text>
                    <Button size="small" disabled={link.isPending} onClick={() => link.mutate(k.id)}>
                      This is it
                    </Button>
                  </div>
                  <Text size={200} block style={{ whiteSpace: 'pre-wrap' }}>
                    Workaround: {k.workaround}
                  </Text>
                </div>
              ))}
            </div>
          )}
          <div className={s.row}>
            <Select value={picked} onChange={(_, d) => setPicked(d.value)} aria-label="Link to a problem">
              <option value="">Link to an existing problem…</option>
              {(open.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.reference} · {p.title}
                </option>
              ))}
            </Select>
            <Button disabled={!picked || link.isPending} onClick={() => link.mutate(picked)}>
              Link
            </Button>
            <Button onClick={() => setCreating(true)}>New problem from this incident</Button>
          </div>
        </>
      )}
      {link.error && <Text className={s.error}>{errorText(link.error, 'Could not link it')}</Text>}
      {creating && (
        <ProblemDialog
          base={base}
          incidentId={incident.id}
          prefill={{ title: incident.title, category: incident.category, subcategory: incident.subcategory }}
          onClose={() => setCreating(false)}
          onSaved={() => (setCreating(false), refresh())}
        />
      )}
    </Card>
  );
}
