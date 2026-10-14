import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Link, Select, Spinner, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text , makeStyles, shorthands } from '@fluentui/react-components';
import { ArrowLeftRegular } from '@fluentui/react-icons';
import { INC_CATEGORY_BY_KEY, INC_PROBLEM_STATUSES, INC_PROBLEM_STATUS_LABELS, type IncPriority, type IncProblemStatus, type IncStatus } from '@tvmf/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { IncStatusBadge, PriorityBadge } from '../components/IncidentBits';
import { Page } from '../components/Page';
import { ProblemDialog, type ProblemFields } from '../components/ProblemDialog';
import { LoadError, NoTenant } from '../components/records';
import { useSrStyles, when } from './ServiceRequests';
import { TableSkeleton } from '../components/states';

const useLocalStyles = makeStyles({
  ml4: { marginLeft: '4px' },
  w94vwMaxW720: { maxWidth: "720px", width: "94vw" },
  flexColRowGap12MaxH64vhScroll: { display: "flex", flexDirection: "column", rowGap: '12px', maxHeight: "64vh", overflowY: "auto" },
  preWrap: { whiteSpace: "pre-wrap" },
  pl20Margin0: { ...shorthands.margin("0px"), paddingLeft: '20px' },
});


interface ProblemRow {
  id: string;
  reference: string;
  title: string;
  status: IncProblemStatus;
  category: string | null;
  subcategory: string | null;
  owner_name: string | null;
  known_error: boolean;
  incident_count: number;
  open_incidents: number;
  updated_at: string;
}
interface ProblemDetail extends ProblemFields {
  reference: string;
  incidents: { id: string; reference: string; title: string; status: IncStatus; priority: IncPriority; sitecode: string | null; created_at: string }[];
}

/** Problem records for the customer: the causes behind incidents, and the known errors engineers can use. Engineers and admins only. */
export function Problems() {
  const ls = useLocalStyles();
  const { activeTenantId, me } = useAuth();
  const cs = useSrStyles();
  const qc = useQueryClient();
  const enabled = me?.tenants.find((t) => t.id === activeTenantId)?.managedServices ?? false;
  const base = `/t/${activeTenantId}/incidents`;
  const [status, setStatus] = useState('open');
  const [editing, setEditing] = useState<ProblemFields | 'new' | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  const list = useQuery({ queryKey: ['incident-problems', base, status], enabled: !!activeTenantId && enabled, queryFn: () => api<ProblemRow[]>(`${base}/problems?status=${status}`) });
  const detail = useQuery({ queryKey: ['incident-problem', base, viewing], enabled: !!viewing, queryFn: () => api<ProblemDetail>(`${base}/problems/${viewing}`) });
  const saved = () => {
    setEditing(null);
    qc.invalidateQueries({ queryKey: ['incident-problems'] });
    qc.invalidateQueries({ queryKey: ['incident-problem'] });
    qc.invalidateQueries({ queryKey: ['incident-known-errors'] });
  };

  if (!activeTenantId) return <NoTenant />;
  return (
    <Page
      title="Problems"
      subtitle="The causes behind incidents. A problem with a workaround is a known error, offered to engineers on new incidents of the same kind."
      actions={
        <div className={cs.actions}>
          <RouterLink to="/incidents">
            <Button appearance="subtle" icon={<ArrowLeftRegular />}>
              Incidents
            </Button>
          </RouterLink>
          <Button appearance="primary" onClick={() => setEditing('new')}>
            New problem
          </Button>
        </div>
      }
    >
      <div className={cs.toolbar}>
        <Field label="Show">
          <Select value={status} onChange={(_, d) => setStatus(d.value)}>
            <option value="open">Not resolved</option>
            {INC_PROBLEM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {INC_PROBLEM_STATUS_LABELS[s]}
              </option>
            ))}
            <option value="all">All</option>
          </Select>
        </Field>
      </div>
      {list.isError && <LoadError message={(list.error as Error).message} />}
      <Card>
        {list.isLoading ? (
          <TableSkeleton rows={4} cols={5} />
        ) : (list.data ?? []).length === 0 ? (
          <Text size={200}>No problems here. Create one from an incident when you find a cause worth tracking.</Text>
        ) : (
          <DataTable size="small" minWidth={900}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Ref</TableHeaderCell>
                <TableHeaderCell>Title</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Kind of incident</TableHeaderCell>
                <TableHeaderCell>Owner</TableHeaderCell>
                <TableHeaderCell>Incidents</TableHeaderCell>
                <TableHeaderCell>Updated</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data!.map((p) => (
                <TableRow key={p.id} className={cs.row} onClick={() => setViewing(p.id)}>
                  <TableCell>
                    <Link onClick={() => setViewing(p.id)}>{p.reference}</Link>
                  </TableCell>
                  <TableCell>{p.title}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={p.status === 'resolved' ? 'success' : p.status === 'investigating' ? 'informative' : 'warning'}>
                      {INC_PROBLEM_STATUS_LABELS[p.status]}
                    </Badge>
                    {p.known_error && (
                      <Badge appearance="outline" color="brand" className={ls.ml4} title="Offered to engineers on new incidents of this kind">
                        Known error
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{p.category ? (INC_CATEGORY_BY_KEY[p.category]?.label ?? p.category) : '—'}</TableCell>
                  <TableCell>{p.owner_name ?? '—'}</TableCell>
                  <TableCell>
                    {p.incident_count} ({p.open_incidents} open)
                  </TableCell>
                  <TableCell>{when(p.updated_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Card>

      {viewing && (
        <Dialog open onOpenChange={(_, d) => !d.open && setViewing(null)}>
          <DialogSurface className={ls.w94vwMaxW720}>
            <DialogBody>
              <DialogTitle>{detail.data ? `${detail.data.reference} · ${detail.data.title}` : 'Problem'}</DialogTitle>
              <DialogContent className={ls.flexColRowGap12MaxH64vhScroll}>
                {detail.isLoading && <Spinner size="tiny" />}
                {detail.data && (
                  <>
                    {[
                      ['What we know', detail.data.description],
                      ['Root cause', detail.data.root_cause],
                      ['Workaround', detail.data.workaround],
                      ['Note for customers', detail.data.customer_note],
                    ].map(([label, value]) =>
                      value ? (
                        <div key={label}>
                          <Text weight="semibold" size={200} block>
                            {label}
                          </Text>
                          <Text className={ls.preWrap}>{value}</Text>
                        </div>
                      ) : null,
                    )}
                    <Text weight="semibold" size={200}>
                      Incidents ({detail.data.incidents.length})
                    </Text>
                    {detail.data.incidents.length === 0 ? (
                      <Text size={200}>None linked yet.</Text>
                    ) : (
                      <ul className={ls.pl20Margin0}>
                        {detail.data.incidents.map((i) => (
                          <li key={i.id}>
                            <RouterLink to={`/incidents/${i.id}`}>{i.reference}</RouterLink> · {i.title}
                            {i.sitecode ? ` (${i.sitecode})` : ''} <PriorityBadge priority={i.priority} /> <IncStatusBadge status={i.status} hold={null} staff />
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setViewing(null)}>
                  Close
                </Button>
                {detail.data && (
                  <Button
                    appearance="primary"
                    onClick={() => {
                      setEditing(detail.data!);
                      setViewing(null);
                    }}
                  >
                    Edit
                  </Button>
                )}
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
      {editing && <ProblemDialog base={base} problem={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={saved} />}
    </Page>
  );
}
