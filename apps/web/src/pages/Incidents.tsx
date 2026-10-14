import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Field, Input, Link, Select, Spinner, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text } from '@fluentui/react-components';
import { INC_CATEGORIES, INC_CATEGORY_BY_KEY, INC_PRIORITIES, INC_PRIORITY_LABELS, INC_STATUSES, INC_STATUS_CUSTOMER_LABELS, INC_STATUS_LABELS } from '@tvmf/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { IncidentNotices } from '../components/IncidentNotices';
import { IncidentReportsDialog } from '../components/IncidentReports';
import { IncidentSettingsDialog } from '../components/IncidentSettings';
import { IncQueueTiles, IncSlaBadge, IncStatusBadge, MajorBadge, MajorClockBadge, PriorityBadge, incQueueFilter, type IncQueueFilter, type IncidentRow } from '../components/IncidentBits';
import { Page } from '../components/Page';
import { LoadError, NoTenant } from '../components/records';
import { useDebounced } from '../hooks/useDebounced';
import { useSrStyles } from './ServiceRequests';

/**
 * Incidents: something that worked has stopped working, or is working badly.
 * Customers raise them and follow progress; the engineers and admins on the
 * customer work them. See docs/INCIDENT-MANAGEMENT.md.
 */
export function Incidents() {
  const { activeTenantId, can, me } = useAuth();
  const cs = useSrStyles();
  const navigate = useNavigate();
  const [status, setStatus] = useState('open');
  const [category, setCategory] = useState('');
  const [priority, setPriority] = useState('');
  const [assigned, setAssigned] = useState('');
  const [qInput, setQInput] = useState('');
  const q = useDebounced(qInput);
  const [tile, setTile] = useState<IncQueueFilter>('all');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reportsOpen, setReportsOpen] = useState(false);
  const staff = can('inc:manage');

  const enabled = me?.tenants.find((t) => t.id === activeTenantId)?.managedServices ?? false;
  const base = `/t/${activeTenantId}/incidents`;
  const params = new URLSearchParams({ status });
  if (category) params.set('category', category);
  if (priority) params.set('priority', priority);
  if (assigned) params.set('assigned', assigned);
  if (q) params.set('q', q);

  const list = useQuery({
    queryKey: ['incidents', activeTenantId, params.toString()],
    enabled: !!activeTenantId && enabled,
    queryFn: () => api<IncidentRow[]>(`${base}?${params.toString()}`),
    refetchInterval: 30_000,
  });

  const open = (id: string) => navigate(`/incidents/${id}`);

  if (!activeTenantId) return <NoTenant />;
  if (!enabled) {
    return (
      <Page title="Incidents" subtitle="Report and track problems with your Teams calling.">
        <Card>
          <Text>
            Managed Services isn&apos;t switched on for this customer. A Super Admin can switch it on from <b>Customers</b>.
          </Text>
        </Card>
      </Page>
    );
  }

  const rows = (list.data ?? []).filter(incQueueFilter(staff && status === 'open' ? tile : 'all'));
  const statusLabel = staff ? INC_STATUS_LABELS : INC_STATUS_CUSTOMER_LABELS;

  return (
    <Page
      title="Incidents"
      subtitle="Something not working, or not working well? Raise an incident and follow it here. You're emailed as it moves on."
      actions={
        <div className={cs.actions}>
          <Button onClick={() => setReportsOpen(true)}>Reports</Button>
          {staff && (
            <Button onClick={() => navigate('/incidents/problems')}>Problems</Button>
          )}
          <Button onClick={() => setSettingsOpen(true)}>{staff ? 'Settings' : 'Our targets'}</Button>
          {can('inc:create') && (
            <Button appearance="primary" onClick={() => navigate('/incidents/new')}>
              Raise an incident
            </Button>
          )}
        </div>
      }
    >
      <div className={cs.toolbar}>
        <Field label="Show">
          <Select value={status} onChange={(_, d) => setStatus(d.value)}>
            <option value="open">Not closed yet</option>
            {INC_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel[s]}
              </option>
            ))}
            <option value="all">All</option>
          </Select>
        </Field>
        <Field label="Category">
          <Select value={category} onChange={(_, d) => setCategory(d.value)}>
            <option value="">All categories</option>
            {INC_CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={priority} onChange={(_, d) => setPriority(d.value)}>
            <option value="">Any priority</option>
            {INC_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {INC_PRIORITY_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>
        {staff && (
          <Field label="Assigned">
            <Select value={assigned} onChange={(_, d) => setAssigned(d.value)}>
              <option value="">Anyone</option>
              <option value="me">Assigned to me</option>
              <option value="none">Unassigned</option>
              <option value="agent">With an assistant (AI)</option>
            </Select>
          </Field>
        )}
        <Field label="Search">
          <Input value={qInput} placeholder="Title or INC-0042" onChange={(_, d) => setQInput(d.value)} />
        </Field>
      </div>
      <IncidentNotices base={base} enabled={enabled} />
      {list.isError && <LoadError message={(list.error as Error).message} />}
      {staff && status === 'open' && list.data && <IncQueueTiles items={list.data} filter={tile} onFilter={setTile} />}
      <Card>
        {list.isLoading ? (
          <Spinner size="tiny" />
        ) : rows.length === 0 ? (
          <Text size={200}>
            {list.data && list.data.length > 0 ? 'Nothing matches that filter.' : status === 'open' ? 'No open incidents. Nothing is being worked on right now.' : 'No incidents here.'}
          </Text>
        ) : (
          <DataTable size="small" minWidth={980}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Ref</TableHeaderCell>
                <TableHeaderCell>Title</TableHeaderCell>
                <TableHeaderCell>Category</TableHeaderCell>
                <TableHeaderCell>Site</TableHeaderCell>
                <TableHeaderCell>Priority</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                {staff && <TableHeaderCell>Next target</TableHeaderCell>}
                <TableHeaderCell>Assigned to</TableHeaderCell>
                <TableHeaderCell>Raised</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className={cs.row} onClick={() => open(r.id)}>
                  <TableCell>
                    <Link onClick={() => open(r.id)}>{r.reference}</Link>
                  </TableCell>
                  <TableCell>
                    {r.title}
                    <MajorBadge row={r} />
                  </TableCell>
                  <TableCell>{INC_CATEGORY_BY_KEY[r.category]?.label ?? r.category}</TableCell>
                  <TableCell>{r.sitecode ?? '—'}</TableCell>
                  <TableCell>
                    <PriorityBadge priority={r.priority} staff={staff} />
                  </TableCell>
                  <TableCell>
                    <IncStatusBadge status={r.status} hold={r.hold_reason} staff={staff} />
                  </TableCell>
                  {staff && (
                    <TableCell>
                      <IncSlaBadge clock={r.sla.clock} which={r.sla.which} />
                      {r.major && <MajorClockBadge clock={r.major_clock} />}
                    </TableCell>
                  )}
                  <TableCell>{r.assigned_agent_name ? `${r.assigned_agent_name} (AI)` : (r.assigned_to_name ?? (r.status === 'new' ? 'Not yet' : '—'))}</TableCell>
                  <TableCell>
                    {r.reporter_name ?? '—'}
                    <Text size={100} block>
                      {new Date(r.created_at).toLocaleString()}
                    </Text>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Card>
      {settingsOpen && <IncidentSettingsDialog base={base} onClose={() => setSettingsOpen(false)} />}
      {reportsOpen && <IncidentReportsDialog base={base} onClose={() => setReportsOpen(false)} />}
    </Page>
  );
}
