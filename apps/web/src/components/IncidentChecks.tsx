import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Field, Input, Select, Spinner, Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { DIAG_RUNBOOKS, type DiagFinding, type DiagOutcome, type DiagRunbookDef, type DiagRunbookKey, type DiagSuggestion } from '@tvmf/shared';
import { api } from '../api';
import { errorText, when } from '../pages/ServiceRequests';

const useStyles = makeStyles({
  card: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  row: { display: 'flex', columnGap: tokens.spacingHorizontalS, rowGap: tokens.spacingVerticalS, flexWrap: 'wrap', alignItems: 'flex-end' },
  muted: { color: tokens.colorNeutralForeground3 },
  error: { color: tokens.colorPaletteRedForeground1 },
  result: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXS, ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM), ...shorthands.borderRadius(tokens.borderRadiusMedium), ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2) },
  head: { display: 'flex', columnGap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  findings: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXXS, marginTop: tokens.spacingVerticalXS },
  finding: { display: 'flex', columnGap: tokens.spacingHorizontalS, alignItems: 'flex-start' },
  dot: { flexShrink: 0, width: '10px', height: '10px', marginTop: '6px', ...shorthands.borderRadius('50%') },
  field: { minWidth: '260px', flexGrow: 1 },
});

interface Stored {
  id: string;
  runbook: DiagRunbookKey;
  input: string;
  subject: string;
  status: DiagOutcome;
  summary: string;
  findings: DiagFinding[];
  dataAsOf: string | null;
  created_at: string;
  actor_type: 'user' | 'agent' | 'system';
  run_by_name: string | null;
}
interface Payload {
  runbooks: DiagRunbookDef[];
  results: Stored[];
  suggestions: DiagSuggestion[];
}

const OUTCOME: Record<DiagOutcome, { label: string; color: 'success' | 'warning' | 'danger' | 'subtle' }> = {
  ok: { label: 'Nothing wrong', color: 'success' },
  warn: { label: 'Look at this', color: 'warning' },
  fail: { label: 'Problem found', color: 'danger' },
  unknown: { label: 'Could not tell', color: 'subtle' },
};
const DOT: Record<DiagFinding['status'], string> = {
  ok: tokens.colorPaletteGreenBackground3,
  warn: tokens.colorPaletteYellowBackground3,
  fail: tokens.colorPaletteRedBackground3,
  info: tokens.colorNeutralStroke1,
};

/**
 * Read-only checks for engineers: what Discovery and the design say about the people, numbers, queues and routes an
 * incident is about. Nothing here touches the customer's tenant, and every result says how old its data is.
 */
export function IncidentChecks({ base, incidentId }: { base: string; incidentId: string }) {
  const s = useStyles();
  const qc = useQueryClient();
  const key = ['incident-diagnostics', base, incidentId];
  const q = useQuery({ queryKey: key, queryFn: () => api<Payload>(`${base}/${incidentId}/diagnostics`) });
  const [runbook, setRunbook] = useState<DiagRunbookKey>('user_voice');
  const [input, setInput] = useState('');
  const run = useMutation({
    mutationFn: (v: { runbook: DiagRunbookKey; input?: string }) => api<Stored>(`${base}/${incidentId}/diagnostics`, { method: 'POST', body: JSON.stringify({ runbook: v.runbook, input: v.input || undefined }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ['incident', base, incidentId] });
    },
  });
  const def = DIAG_RUNBOOKS[runbook];
  const done = (r: DiagSuggestion) => q.data?.results.some((x) => x.runbook === r.runbook && x.input.toLowerCase() === r.input.toLowerCase());
  const todo = (q.data?.suggestions ?? []).filter((x) => !done(x));

  return (
    <Card className={s.card}>
      <div>
        <Text weight="semibold">Checks</Text>
        <div className={s.muted}>
          <Text size={200}>Read-only. They look at the last Discovery and the design, not the live tenant, and say how old that is.</Text>
        </div>
      </div>
      {todo.length > 0 && (
        <div className={s.row}>
          {todo.map((x) => (
            <Button key={`${x.runbook}|${x.input}`} size="small" disabled={run.isPending} title={x.why} onClick={() => run.mutate({ runbook: x.runbook, input: x.input })}>
              {DIAG_RUNBOOKS[x.runbook].label}
              {x.input ? `: ${x.input}` : ''}
            </Button>
          ))}
        </div>
      )}
      <div className={s.row}>
        <Field label="Check" className={s.field}>
          <Select value={runbook} onChange={(_, d) => (setRunbook(d.value as DiagRunbookKey), setInput(''))}>
            {Object.values(DIAG_RUNBOOKS).map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
        {def.input !== 'none' && (
          <Field label={def.inputLabel ?? 'What to check'} className={s.field}>
            <Input value={input} onChange={(_, d) => setInput(d.value)} />
          </Field>
        )}
        <Button appearance="primary" disabled={run.isPending || (def.input !== 'none' && !input.trim())} onClick={() => run.mutate({ runbook, input: input.trim() })}>
          {run.isPending ? 'Checking…' : 'Run check'}
        </Button>
      </div>
      <Text size={200} className={s.muted}>
        {def.help}
      </Text>
      {run.error && <Text className={s.error}>{errorText(run.error, 'The check could not be run.')}</Text>}
      {q.isLoading && <Spinner size="tiny" />}
      {q.data?.results.map((r) => (
        <div key={r.id} className={s.result}>
          <div className={s.head}>
            <Badge appearance="filled" color={OUTCOME[r.status].color}>
              {OUTCOME[r.status].label}
            </Badge>
            <Text weight="semibold">
              {DIAG_RUNBOOKS[r.runbook]?.label ?? r.runbook}: {r.subject}
            </Text>
            <Text size={200} className={s.muted}>
              {r.run_by_name ?? (r.actor_type === 'agent' ? 'An assistant' : 'Someone')} · {when(r.created_at)}
              {r.dataAsOf ? ` · data from ${when(r.dataAsOf)}` : ' · no Discovery yet'}
            </Text>
          </div>
          <Text>{r.summary}</Text>
          <details>
            <summary>
              <Text size={200}>All {r.findings.length} findings</Text>
            </summary>
            <div className={s.findings}>
              {r.findings.map((f, i) => (
                <div key={i} className={s.finding}>
                  <span className={s.dot} style={{ backgroundColor: DOT[f.status] }} aria-label={f.status} />
                  <div>
                    <Text>{f.title}</Text>
                    {f.detail && (
                      <div className={s.muted}>
                        <Text size={200}>{f.detail}</Text>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </details>
        </div>
      ))}
      {q.data && q.data.results.length === 0 && !q.isLoading && <Text className={s.muted}>Nothing has been checked yet.</Text>}
    </Card>
  );
}
