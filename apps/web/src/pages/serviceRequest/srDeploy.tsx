import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Link, Spinner, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Textarea , makeStyles, mergeClasses } from '@fluentui/react-components';
import { WarningRegular } from '@fluentui/react-icons';
import { srInChangeWindow, srChangeWindowText, type DeploymentPreviewRow, type SrChangeWindow, type SrDeploymentRun, type SrDesignSummary } from '@tvmf/shared';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { DataTable } from '../../components/DataTable';
import { LoadError } from '../../components/records';
import { errorText, useSrStyles, when, type RequestDetail } from '../ServiceRequests';
import { OBJECT_TYPE_LABEL, GROUP_ORDER, RESULT_BADGE_COLOR, usePageStyles, type RequestPayload } from './srShared';

const useLocalStyles = makeStyles({
  justifySpacebetween: { justifyContent: "space-between" },
  ml6: { marginLeft: '6px' },
  mt2: { flexShrink: 0, marginTop: '2px' },
  maxW420PreWrap: { maxWidth: '420px', whiteSpace: "pre-wrap" },
  mt12: { marginTop: '12px' },
  colItemsStretch: { flexDirection: "column", alignItems: "stretch" },
});


interface Connection {
  id: string;
  status: string;
}

interface Change {
  id: string;
  seq: number;
  cmdlet: string;
  object_type: string;
  result: string;
  message: string | null;
}

function runBadge(d: SrDeploymentRun): { label: string; color: 'success' | 'danger' | 'informative' } {
  const failed = d.summary?.failed ?? 0;
  if (d.status === 'failed') return { label: 'Failed', color: 'danger' };
  if (d.status === 'completed' && failed > 0) return { label: `Finished, ${failed} failed`, color: 'danger' };
  if (d.status === 'completed') return { label: 'Finished', color: 'success' };
  return { label: d.status === 'queued' ? 'Queued' : 'Running', color: 'informative' };
}

export function DeployTab({
  base,
  tid,
  request: r,
  design,
  changeWindow,
}: {
  base: string;
  tid: string;
  request: RequestDetail;
  design: SrDesignSummary | undefined;
  changeWindow: SrChangeWindow | null;
}) {
  const ls = useLocalStyles();
  const ps = usePageStyles();
  const cs = useSrStyles();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canExecute = can('deployment:execute');
  const [confirm, setConfirm] = useState(false);
  const [outsideReason, setOutsideReason] = useState('');
  const insideWindow = srInChangeWindow(changeWindow);
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<{ id: string; teams_read_only: boolean }[]>('/tenants') });
  const readOnly = tenants.data?.find((x) => x.id === tid)?.teams_read_only ?? false;
  const [runFor, setRunFor] = useState<string | null>(null);

  const connections = useQuery({
    queryKey: ['connections', tid],
    refetchInterval: 4000,
    queryFn: () => api<Connection[]>(`/t/${tid}/deployments/connections`),
  });
  const activeConn = connections.data?.find((c) => c.status === 'active');

  const hasRows = (design?.deployableCount ?? 0) > 0;
  const preview = useQuery({
    queryKey: ['sr-deploy-preview', base, r.id],
    enabled: hasRows,
    queryFn: () => api<DeploymentPreviewRow[]>(`${base}/${r.id}/deploy-preview`),
  });
  const runs = useQuery({
    queryKey: ['sr-runs', base, r.id],
    refetchInterval: 4000,
    queryFn: () => api<SrDeploymentRun[]>(`${base}/${r.id}/runs`),
  });
  const changes = useQuery({
    queryKey: ['changes', tid, runFor],
    enabled: !!runFor,
    queryFn: () => api<Change[]>(`/t/${tid}/deployments/${runFor}/changes`),
  });

  // A finished live run may have moved the request to Deployed (in the
  // worker) - pick that up, and the new preview, as runs finish.
  const finished = (runs.data ?? []).filter((d) => d.status === 'completed' || d.status === 'failed').length;
  useEffect(() => {
    if (!finished) return;
    qc.invalidateQueries({ queryKey: ['service-request', base, r.id] });
    qc.invalidateQueries({ queryKey: ['sr-deploy-preview', base, r.id] });
    qc.invalidateQueries({ queryKey: ['service-requests'] });
  }, [finished, base, r.id, qc]);

  const run = useMutation({
    mutationFn: (mode: 'dry_run' | 'execute') =>
      api(`${base}/${r.id}/deploy`, {
        method: 'POST',
        body: JSON.stringify({
          connectionId: activeConn?.id,
          mode,
          outsideWindowReason: mode === 'execute' && !insideWindow ? outsideReason.trim() : undefined,
        }),
      }),
    onSuccess: () => {
      setConfirm(false);
      setOutsideReason('');
      qc.invalidateQueries({ queryKey: ['sr-runs', base, r.id] });
    },
  });

  const rows = preview.data ?? [];
  const busy = (runs.data ?? []).some((d) => d.status === 'queued' || d.status === 'running');
  const canWhatIf = r.status === 'planned' || r.status === 'built';
  const canLive = r.status === 'built' && canExecute && !readOnly;

  return (
    <>
      <Card className={ps.card}>
        <div className={mergeClasses(cs.actions, ls.justifySpacebetween)}>
          <Text weight="semibold" size={400}>
            Changes for {r.reference} <span className={ps.muted}>({rows.length})</span>
          </Text>
          <div className={cs.actions}>
            <Button disabled={!activeConn || !canWhatIf || !hasRows || busy || run.isPending} onClick={() => run.mutate('dry_run')}>
              What-If
            </Button>
            <Button appearance="primary" disabled={!activeConn || !canLive || !hasRows || busy || run.isPending} onClick={() => setConfirm(true)}>
              Deploy
            </Button>
          </div>
        </div>
        <Text size={200} className={ps.muted}>
          Only this request&apos;s rows are deployed, plus the resource accounts its call queues and auto attendants answer on, and any users
          they route to. What-If checks everything and sends nothing to Microsoft Teams.
          {r.status === 'planned' && ' Deploy is available once the request is marked as designed & built.'}
          {r.status === 'built' && ' A deployment with no failed changes marks the request as deployed and emails the requester.'}
          {r.status === 'deployed' && ' This request is deployed.'}
          {!canExecute && ' You can run What-If; a live deployment needs an engineer who can deploy.'}
          {changeWindow && ` Change window: ${srChangeWindowText(changeWindow)}${insideWindow ? ' - open now.' : ' - closed now.'}`}
        </Text>
        {readOnly && (
          <Text size={200}>
            <WarningRegular /> This customer&apos;s tenant is read-only, so live changes are switched off. What-If still works.
          </Text>
        )}
        {!activeConn && (
          <Text size={200}>
            <WarningRegular /> No active connection to the customer&apos;s tenant. Connect from <RouterLink to="/deployment">Deployment</RouterLink>, then come back.
          </Text>
        )}
        {run.error && <Text className={cs.error}>{errorText(run.error, 'Could not start the run')}</Text>}

        {!hasRows ? (
          <Text size={200}>Nothing designed for this request yet. Add rows on the Design tab.</Text>
        ) : preview.isLoading ? (
          <Spinner size="tiny" />
        ) : preview.isError ? (
          <LoadError message={(preview.error as Error).message} />
        ) : rows.length === 0 ? (
          <Text size={200}>Nothing to change: the request&apos;s rows already match the tenant.</Text>
        ) : (
          <DataTable size="small" minWidth={820}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Object</TableHeaderCell>
                <TableHeaderCell>Commands</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {GROUP_ORDER.flatMap((type) => {
                const group = rows.filter((x) => x.objectType === type);
                if (group.length === 0) return [];
                return [
                  <TableRow key={`g-${type}`}>
                    <TableCell colSpan={2} className={ps.groupHeaderCell}>
                      {OBJECT_TYPE_LABEL[type]} · {group.length}
                    </TableCell>
                  </TableRow>,
                  ...group.map((x) => (
                    <TableRow key={x.rowId}>
                      <TableCell>
                        {x.upn}
                        {x.autoIncluded && (
                          <Badge appearance="tint" color="brand" className={ls.ml6} title="Not on the request itself: included because a call queue or auto attendant on it routes to this user.">
                            included automatically
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {x.renderedCommands.length > 0 && <pre className={ps.commands}>{x.renderedCommands.join('\n')}</pre>}
                        {x.warnings.map((w) => (
                          <div key={w} className={ps.warningRow}>
                            <WarningRegular className={ls.mt2} />
                            <span>{w}</span>
                          </div>
                        ))}
                      </TableCell>
                    </TableRow>
                  )),
                ];
              })}
            </TableBody>
          </DataTable>
        )}
      </Card>

      <Card className={ps.card}>
        <Text weight="semibold" size={400}>
          Runs
        </Text>
        {(runs.data ?? []).length === 0 ? (
          <Text size={200}>No runs yet.</Text>
        ) : (
          <DataTable size="small" minWidth={720}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Started</TableHeaderCell>
                <TableHeaderCell>Kind</TableHeaderCell>
                <TableHeaderCell>Result</TableHeaderCell>
                <TableHeaderCell>Changes</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.data!.map((d) => {
                const b = runBadge(d);
                return (
                  <TableRow key={d.id}>
                    <TableCell>{when(d.created_at)}</TableCell>
                    <TableCell>{d.mode === 'execute' ? 'Deploy' : 'What-If'}</TableCell>
                    <TableCell>
                      <Badge appearance="tint" color={b.color}>
                        {b.label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {Object.entries(d.summary ?? {})
                        .filter(([k]) => k !== 'total')
                        .map(([k, v]) => `${k} ${v}`)
                        .join(' · ') || '—'}
                    </TableCell>
                    <TableCell>
                      <Link onClick={() => setRunFor(runFor === d.id ? null : d.id)}>{runFor === d.id ? 'Hide' : 'View'} changes</Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </DataTable>
        )}
        {runFor &&
          (changes.isLoading ? (
            <Spinner size="tiny" />
          ) : (
            <DataTable size="small" minWidth={820}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>#</TableHeaderCell>
                  <TableHeaderCell>Object</TableHeaderCell>
                  <TableHeaderCell>Cmdlet</TableHeaderCell>
                  <TableHeaderCell>Result</TableHeaderCell>
                  <TableHeaderCell>Detail</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(changes.data ?? []).map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.seq}</TableCell>
                    <TableCell>{c.object_type}</TableCell>
                    <TableCell className={ps.mono}>{c.cmdlet}</TableCell>
                    <TableCell>
                      <Badge appearance="tint" color={RESULT_BADGE_COLOR[c.result] ?? 'informative'}>
                        {c.result}
                      </Badge>
                    </TableCell>
                    <TableCell className={ps.mono}>
                      <div className={ls.maxW420PreWrap}>{c.message ?? ''}</div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </DataTable>
          ))}
      </Card>

      <Dialog open={confirm} onOpenChange={(_, d) => setConfirm(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Deploy {r.reference}?</DialogTitle>
            <DialogContent>
              <Text block>
                This makes the {rows.length} change{rows.length === 1 ? '' : 's'} above live in the customer&apos;s Microsoft Teams tenant. Nothing
                else on the site is touched.
              </Text>
              {!insideWindow && changeWindow && (
                <Field
                  label="Why can't this wait for the change window?"
                  required
                  hint={`The customer's change window is ${srChangeWindowText(changeWindow)}. Your reason is noted on the request.`}
                  className={ls.mt12}
                >
                  <Textarea value={outsideReason} maxLength={1000} onChange={(_, d) => setOutsideReason(d.value)} />
                </Field>
              )}
              {run.error && <Text className={cs.error}>{errorText(run.error, 'Could not start the deployment')}</Text>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={run.isPending || (!insideWindow && outsideReason.trim().length < 3)}
                onClick={() => run.mutate('execute')}
              >
                Deploy now
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

/* -------------------------------- approval -------------------------------- */

export function ApprovalBanner({ base, id, approval, onDone }: { base: string; id: string; approval: NonNullable<RequestPayload['approval']>; onDone: () => void }) {
  const ls = useLocalStyles();
  const ps = usePageStyles();
  const cs = useSrStyles();
  const [note, setNote] = useState('');
  const decide = useMutation({
    mutationFn: (approve: boolean) => api(`${base}/${id}/approval`, { method: 'POST', body: JSON.stringify({ approve, note: note.trim() || undefined }) }),
    onSuccess: onDone,
  });
  if (approval.status !== 'pending') {
    return (
      <Text size={200}>
        {approval.status === 'approved' ? 'Approved' : 'Rejected'} by {approval.by ?? 'the approver'}
        {approval.at ? ` on ${new Date(approval.at).toLocaleDateString()}` : ''}
        {approval.note ? `: ${approval.note}` : '.'}
      </Text>
    );
  }
  return (
    <div className={mergeClasses(ps.waiting, ls.colItemsStretch)}>
      <Text>
        <b>Waiting for approval</b> from {approval.approvers.join(' or ') || 'the customer'}. The team can&apos;t start until it&apos;s approved.
      </Text>
      {approval.canDecide && (
        <>
          <Field label="Note" hint="Needed to reject. Shared with the team and the requester.">
            <Textarea value={note} maxLength={2000} onChange={(_, d) => setNote(d.value)} />
          </Field>
          <div className={cs.actions}>
            <Button appearance="primary" disabled={decide.isPending} onClick={() => decide.mutate(true)}>
              Approve
            </Button>
            <Button disabled={decide.isPending || !note.trim()} onClick={() => decide.mutate(false)}>
              Reject
            </Button>
          </div>
          {decide.error && <Text className={cs.error}>{errorText(decide.error, 'That did not work')}</Text>}
        </>
      )}
    </div>
  );
}

/* ------------------------------ attachments ------------------------------ */
