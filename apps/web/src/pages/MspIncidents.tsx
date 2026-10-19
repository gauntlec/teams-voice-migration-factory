import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Link,
  Radio,
  RadioGroup,
  Select,
  Spinner,
  Tab,
  TabList,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { INC_CATEGORY_BY_KEY, INC_PRIORITIES, INC_PRIORITY_LABELS, INC_STATUSES, INC_STATUS_LABELS, type IncMajorClock, type IncPriority, type IncStatus } from '@tvmf/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { IncQueueTiles, IncSlaBadge, IncStatusBadge, MajorBadge, MajorClockBadge, PriorityBadge, incQueueFilter, type IncQueueFilter, type IncidentRow } from '../components/IncidentBits';
import { useSort } from '../lib/sort';
import { Page } from '../components/Page';
import { LoadError } from '../components/records';
import { DangerText } from '../components/ui';
import { TableSkeleton } from '../components/states';

const useLocalStyles = makeStyles({
  preWrap: { whiteSpace: "pre-wrap" },
  maxW620: { maxWidth: "620px" },
  flexColRowGap12: { display: "flex", flexDirection: "column", rowGap: '12px' },
  mt4: { marginTop: '4px' },
  flex: { display: "flex", columnGap: '8px' },
  grow1: { flexGrow: 1 },
});


type QueueItem = Omit<IncidentRow, 'impact' | 'urgency' | 'updated_at' | 'site_id'> & {
  tenant_id: string;
  tenant_name: string;
  msp_name: string | null;
  can_open: boolean;
};

interface QueueResponse {
  msp: { id: string; name: string } | null;
  customers: { id: string; name: string; msp_name: string | null; can_open: boolean }[];
  items: QueueItem[];
}

interface BoardItem {
  id: string;
  reference: string;
  title: string;
  priority: IncPriority;
  status: IncStatus;
  sitecode: string | null;
  tenant_id: string;
  tenant_name: string;
  can_open: boolean;
  lead_name: string | null;
  comms_name: string | null;
  major_declared_at: string | null;
  update_clock: IncMajorClock;
  update_interval_minutes: number | null;
  children: number;
  open_children: number;
  latest_update: { body: string | null; created_at: string } | null;
}

const useStyles = makeStyles({
  toolbar: { display: 'flex', columnGap: tokens.spacingHorizontalM, alignItems: 'end', flexWrap: 'wrap', marginBottom: tokens.spacingVerticalM },
  muted: { color: tokens.colorNeutralForeground3 },
  stack: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  board: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  boardCard: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS },
  boardHead: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalXS },
  facts: { display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: tokens.spacingHorizontalL, rowGap: tokens.spacingVerticalXXS },
});

/**
 * The MSP incident console: every incident across the customers your MSP looks after,
 * in one queue, plus the board of live major incidents. Opening an incident switches
 * to that customer, where it is worked as usual; customers you're not on the team for
 * are read-only here. Mirrors the service-request admin.
 */
export function MspIncidents() {
  const ls = useLocalStyles();
  const cs = useStyles();
  const navigate = useNavigate();
  const { me, setActiveTenant } = useAuth();
  const superAdmin = me?.role === 'SUPER_ADMIN';
  const [tab, setTab] = useState<'queue' | 'major'>('queue');
  const [status, setStatus] = useState('open');
  const [priority, setPriority] = useState('');
  const [mspId, setMspId] = useState('');
  const [customer, setCustomer] = useState('');
  const [mine, setMine] = useState(false);
  const [tile, setTile] = useState<IncQueueFilter>('all');
  const [acting, setActing] = useState<QueueItem | null>(null);

  const q = useQuery({
    queryKey: ['msp-incidents', status, mspId, mine, priority],
    refetchInterval: 30_000,
    queryFn: () => api<QueueResponse>(`/msp/incidents?status=${status}${mspId ? `&mspId=${mspId}` : ''}${mine ? '&mine=true' : ''}${priority ? `&priority=${priority}` : ''}`),
  });
  const board = useQuery({
    queryKey: ['msp-incidents', 'major', mspId],
    refetchInterval: 30_000,
    queryFn: () => api<{ msp: { id: string; name: string } | null; items: BoardItem[] }>(`/msp/incidents/major${mspId ? `?mspId=${mspId}` : ''}`),
  });
  const msps = useQuery({ queryKey: ['msp-incidents', 'msps'], enabled: superAdmin, queryFn: () => api<{ id: string; name: string }[]>('/msp/incidents/msps') });

  const open = (tenantId: string, id: string, canOpen: boolean) => {
    if (!canOpen) return;
    setActiveTenant(tenantId);
    navigate(`/incidents/${id}`);
  };

  const inCustomer = (q.data?.items ?? []).filter((i) => !customer || i.tenant_id === customer);
  const items = inCustomer.filter(incQueueFilter(status === 'open' ? tile : 'all'));
  const { sorted: sortedItems, header } = useSort(items, {
    customer: (i) => i.tenant_name,
    ref: (i) => i.reference,
    title: (i) => i.title,
    category: (i) => INC_CATEGORY_BY_KEY[i.category]?.label ?? i.category,
    site: (i) => i.sitecode,
    priority: (i) => i.priority,
    status: (i) => i.status,
    target: (i) => i.sla.clock.leftMs,
    assigned: (i) => i.assigned_agent_name ?? i.assigned_to_name,
    raised: (i) => i.created_at,
  });
  const majors = (board.data?.items ?? []).filter((i) => !customer || i.tenant_id === customer);
  const subtitle = superAdmin ? 'Every incident across all customers with Managed Services switched on.' : q.data?.msp ? `Every incident across ${q.data.msp.name}'s customers.` : "Every incident across your MSP's customers.";

  return (
    <Page platform title="Incident console" subtitle={subtitle}>
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
        <Tab value="queue">Queue</Tab>
        <Tab value="major">Major incidents{majors.length ? ` (${majors.length})` : ''}</Tab>
      </TabList>
      <div className={cs.toolbar}>
        {tab === 'queue' && (
          <>
            <Field label="Show">
              <Select value={status} onChange={(_, d) => setStatus(d.value)}>
                <option value="open">Not closed yet</option>
                {INC_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {INC_STATUS_LABELS[s]}
                  </option>
                ))}
                <option value="all">All</option>
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
          </>
        )}
        {superAdmin && (
          <Field label="MSP">
            <Select
              value={mspId}
              onChange={(_, d) => {
                setMspId(d.value);
                setCustomer('');
              }}
            >
              <option value="">All MSPs</option>
              <option value="none">No MSP</option>
              {(msps.data ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {tab === 'queue' && <Checkbox label="Assigned to me" checked={mine} onChange={(_, d) => setMine(!!d.checked)} />}
        <Field label="Customer">
          <Select value={customer} onChange={(_, d) => setCustomer(d.value)}>
            <option value="">All customers</option>
            {(q.data?.customers ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {tab === 'queue' && (
        <>
          {q.isError && <LoadError message={(q.error as Error).message} />}
          {status === 'open' && q.data && q.data.customers.length > 0 && <IncQueueTiles items={inCustomer} filter={tile} onFilter={setTile} />}
          <Card>
            {q.isLoading ? (
              <TableSkeleton rows={4} cols={5} />
            ) : !superAdmin && !q.data?.msp ? (
              <Text>Your account isn&apos;t linked to an MSP, so there&apos;s no queue to show. A Super Admin can add your email domain to an MSP, or link your account to one.</Text>
            ) : (q.data?.customers.length ?? 0) === 0 ? (
              <Text>No customers here have Managed Services switched on yet. A Super Admin can switch it on, and choose each customer&apos;s MSP, from Customers.</Text>
            ) : items.length === 0 ? (
              <Text size={200}>Nothing here. {status === 'open' ? 'No open incidents across these customers.' : ''}</Text>
            ) : (
              <DataTable size="small" minWidth={1100}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell {...header('customer')}>Customer</TableHeaderCell>
                    <TableHeaderCell {...header('ref')}>Ref</TableHeaderCell>
                    <TableHeaderCell {...header('title')}>Title</TableHeaderCell>
                    <TableHeaderCell {...header('category')}>Category</TableHeaderCell>
                    <TableHeaderCell {...header('site')}>Site</TableHeaderCell>
                    <TableHeaderCell {...header('priority')}>Priority</TableHeaderCell>
                    <TableHeaderCell {...header('status')}>Status</TableHeaderCell>
                    <TableHeaderCell {...header('target')}>Next target</TableHeaderCell>
                    <TableHeaderCell {...header('assigned')}>Assigned to</TableHeaderCell>
                    <TableHeaderCell {...header('raised')}>Raised</TableHeaderCell>
                    <TableHeaderCell />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedItems.map((i) => (
                    <TableRow key={`${i.tenant_id}:${i.id}`}>
                      <TableCell>
                        {i.tenant_name}
                        {superAdmin && i.msp_name && (
                          <Text size={100} block className={cs.muted}>
                            {i.msp_name}
                          </Text>
                        )}
                      </TableCell>
                      <TableCell>
                        {i.can_open ? (
                          <Link onClick={() => open(i.tenant_id, i.id, i.can_open)}>{i.reference}</Link>
                        ) : (
                          <Tooltip content="You're not on this customer's team, so you can see this incident but not open it." relationship="description">
                            <Text className={cs.muted}>{i.reference}</Text>
                          </Tooltip>
                        )}
                      </TableCell>
                      <TableCell>
                        {i.title}
                        <MajorBadge row={i} />
                      </TableCell>
                      <TableCell>{INC_CATEGORY_BY_KEY[i.category]?.label ?? i.category}</TableCell>
                      <TableCell>{i.sitecode ?? '—'}</TableCell>
                      <TableCell>
                        <PriorityBadge priority={i.priority} />
                      </TableCell>
                      <TableCell>
                        <IncStatusBadge status={i.status} hold={i.hold_reason} staff />
                      </TableCell>
                      <TableCell>
                        <IncSlaBadge clock={i.sla.clock} which={i.sla.which} />
                        {i.major && <MajorClockBadge clock={i.major_clock} />}
                      </TableCell>
                      <TableCell>{i.assigned_agent_name ? `${i.assigned_agent_name} (AI)` : (i.assigned_to_name ?? '—')}</TableCell>
                      <TableCell>
                        {i.reporter_name ?? '—'}
                        <Text size={100} block className={cs.muted}>
                          {new Date(i.created_at).toLocaleString()}
                        </Text>
                      </TableCell>
                      <TableCell>
                        {i.can_open && ['new', 'in_progress', 'on_hold', 'restored', 'resolved'].includes(i.status) && (
                          <Button size="small" onClick={() => setActing(i)}>
                            Work it
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </DataTable>
            )}
          </Card>
        </>
      )}

      {tab === 'major' && (
        <>
          {board.isError && <LoadError message={(board.error as Error).message} />}
          {board.isLoading ? (
            <TableSkeleton rows={4} cols={5} />
          ) : majors.length === 0 ? (
            <Card>
              <Text>No live major incidents. Declare one from an incident page when a problem is serious enough to need a lead and regular customer updates.</Text>
            </Card>
          ) : (
            <div className={cs.board}>
              {majors.map((m) => (
                <Card key={`${m.tenant_id}:${m.id}`} className={cs.boardCard}>
                  <div className={cs.boardHead}>
                    <Text weight="semibold" size={400}>
                      {m.can_open ? <Link onClick={() => open(m.tenant_id, m.id, m.can_open)}>{m.reference}</Link> : m.reference} · {m.title}
                    </Text>
                    <PriorityBadge priority={m.priority} />
                    <IncStatusBadge status={m.status} hold={null} staff />
                    <MajorClockBadge clock={m.update_clock} />
                  </div>
                  <div className={cs.facts}>
                    <Text className={cs.muted}>Customer</Text>
                    <Text>
                      {m.tenant_name}
                      {m.sitecode ? ` · ${m.sitecode}` : ' · all sites'}
                    </Text>
                    <Text className={cs.muted}>Lead</Text>
                    <Text>{m.lead_name ?? '—'}</Text>
                    <Text className={cs.muted}>Comms owner</Text>
                    <Text>{m.comms_name ?? '—'}</Text>
                    <Text className={cs.muted}>Declared</Text>
                    <Text>
                      {m.major_declared_at ? new Date(m.major_declared_at).toLocaleString() : '—'}
                      {m.update_interval_minutes ? ` · updates every ${m.update_interval_minutes} min` : ''}
                    </Text>
                    <Text className={cs.muted}>Child incidents</Text>
                    <Text>{m.children === 0 ? 'None linked' : `${m.open_children} open of ${m.children}`}</Text>
                    <Text className={cs.muted}>Latest update</Text>
                    <Text className={ls.preWrap}>
                      {m.latest_update?.body ?? '—'}
                      {m.latest_update && (
                        <Text size={100} block className={cs.muted}>
                          {new Date(m.latest_update.created_at).toLocaleString()}
                        </Text>
                      )}
                    </Text>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
      {acting && <QuickActionDialog item={acting} onClose={() => setActing(null)} />}
    </Page>
  );
}

/** Acknowledge, assign or reply to an incident without switching to its customer. */
function QuickActionDialog({ item, onClose }: { item: QueueItem; onClose: () => void }) {
  const ls = useLocalStyles();
  const qc = useQueryClient();
  const base = `/msp/incidents/${item.tenant_id}`;
  const [assignee, setAssignee] = useState(item.assigned_to ?? '');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<'public' | 'question' | 'internal'>('public');
  const staff = useQuery({ queryKey: ['msp-inc-assignees', item.tenant_id], queryFn: () => api<{ id: string; display_name: string }[]>(`${base}/assignees`) });
  const done = () => qc.invalidateQueries({ queryKey: ['msp-incidents'] });
  const ack = useMutation({ mutationFn: () => api(`${base}/${item.id}/status`, { method: 'POST', body: JSON.stringify({ to: 'in_progress' }) }), onSuccess: done });
  const assign = useMutation({ mutationFn: () => api(`${base}/${item.id}/assign`, { method: 'POST', body: JSON.stringify({ userId: assignee || null }) }), onSuccess: done });
  const reply = useMutation({
    mutationFn: () => api(`${base}/${item.id}/comments`, { method: 'POST', body: JSON.stringify({ body, internal: kind === 'internal', waitForReply: kind === 'question' }) }),
    onSuccess: () => {
      setBody('');
      done();
    },
  });
  const error = ack.error ?? assign.error ?? reply.error;
  const canAck = item.status === 'new';
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={ls.maxW620}>
        <DialogBody>
          <DialogTitle>
            {item.reference} · {item.tenant_name}
          </DialogTitle>
          <DialogContent className={ls.flexColRowGap12}>
            <Text>{item.title}</Text>
            {canAck && (
              <div>
                <Button appearance="primary" disabled={ack.isPending || ack.isSuccess} onClick={() => ack.mutate()}>
                  {ack.isSuccess ? 'Acknowledged' : 'Acknowledge'}
                </Button>
                <Text size={200} block className={ls.mt4}>
                  You become the assignee if nobody has it.
                </Text>
              </div>
            )}
            <Field label="Assigned to">
              <div className={ls.flex}>
                <Select value={assignee} onChange={(_, d) => setAssignee(d.value)} className={ls.grow1}>
                  <option value="">Unassigned</option>
                  {(staff.data ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.display_name}
                    </option>
                  ))}
                </Select>
                <Button disabled={assign.isPending || assignee === (item.assigned_to ?? '')} onClick={() => assign.mutate()}>
                  {assign.isSuccess ? 'Saved' : 'Save'}
                </Button>
              </div>
            </Field>
            <Field label="Reply">
              <Textarea value={body} maxLength={4000} resize="vertical" onChange={(_, d) => setBody(d.value)} />
            </Field>
            <RadioGroup layout="horizontal" value={kind} onChange={(_, d) => setKind(d.value as typeof kind)}>
              <Radio value="public" label="Update the customer" />
              <Radio value="question" label="Ask and wait for their reply" />
              <Radio value="internal" label="Internal note" />
            </RadioGroup>
            {reply.isSuccess && <Text>Sent.</Text>}
            {error && <DangerText>{error instanceof ApiError ? error.message : 'That did not work'}</DangerText>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Close
            </Button>
            <Button appearance="primary" disabled={!body.trim() || reply.isPending} onClick={() => reply.mutate()}>
              Send
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
