import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
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
  Textarea,
  Select,
  Spinner,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { SR_STATUS_LABELS, SR_STATUSES, SR_TYPE_DEFS, type SrClock, type SrPriority, type SrStatus, type SrType } from '@tvmf/shared';
import { api, ApiError } from '../api';
import { QueueTiles, SlaBadge, queueFilter, type QueueFilter } from '../components/SrTarget';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { Page } from '../components/Page';
import { LoadError } from './DataCollection';

interface QueueItem {
  id: string;
  reference: string;
  type: SrType;
  title: string;
  priority: SrPriority;
  status: SrStatus;
  sitecode: string | null;
  requested_by_name: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  created_at: string;
  waiting_since: string | null;
  /** The target that matters now. */
  sla: { which: 'response' | 'resolution'; clock: SrClock };
  tenant_id: string;
  tenant_name: string;
  msp_name: string | null;
  can_open: boolean;
}

interface QueueResponse {
  msp: { id: string; name: string } | null;
  customers: { id: string; name: string; msp_name: string | null; can_open: boolean }[];
  items: QueueItem[];
}

const STATUS_COLOR: Record<SrStatus, 'informative' | 'brand' | 'warning' | 'success' | 'subtle' | 'danger'> = {
  new: 'informative',
  planned: 'brand',
  built: 'warning',
  deployed: 'success',
  cancelled: 'subtle',
  declined: 'danger',
};
const PRIORITY_LABEL: Record<SrPriority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

const useStyles = makeStyles({
  toolbar: { display: 'flex', columnGap: tokens.spacingHorizontalM, alignItems: 'end', flexWrap: 'wrap', marginBottom: tokens.spacingVerticalM },
  muted: { color: tokens.colorNeutralForeground3 },
});

/**
 * MSP service-request admin: every request across the customers your MSP looks
 * after, in one queue. Opening a request switches to that customer, where it is
 * actioned as usual; customers you're not on the team for are read-only here.
 */
export function MspServiceRequests() {
  const cs = useStyles();
  const navigate = useNavigate();
  const { me, setActiveTenant } = useAuth();
  const superAdmin = me?.role === 'SUPER_ADMIN';
  const [status, setStatus] = useState('open');
  const [mspId, setMspId] = useState('');
  const [customer, setCustomer] = useState('');
  const [mine, setMine] = useState(false);
  const [tile, setTile] = useState<QueueFilter>('all');
  const [acting, setActing] = useState<QueueItem | null>(null);

  const q = useQuery({
    queryKey: ['msp-service-requests', status, mspId, mine],
    refetchInterval: 60_000,
    queryFn: () => api<QueueResponse>(`/msp/service-requests?status=${status}${mspId ? `&mspId=${mspId}` : ''}${mine ? '&mine=true' : ''}`),
  });
  const msps = useQuery({
    queryKey: ['msp-service-requests', 'msps'],
    enabled: superAdmin,
    queryFn: () => api<{ id: string; name: string }[]>('/msp/service-requests/msps'),
  });

  const open = (i: QueueItem) => {
    if (!i.can_open) return;
    setActiveTenant(i.tenant_id);
    navigate(`/service-requests/${i.id}`);
  };

  const inCustomer = (q.data?.items ?? []).filter((i) => !customer || i.tenant_id === customer);
  // Most urgent first: overdue, then at risk, then by how much time is left.
  const rank = (i: QueueItem) => ({ overdue: 0, at_risk: 1, on_track: 2, paused: 3 } as Record<string, number>)[i.sla.clock.state] ?? 4;
  const items = inCustomer
    .filter(queueFilter(status === 'open' ? tile : 'all'))
    .sort((a, b) => rank(a) - rank(b) || (a.sla.clock.leftMs ?? Infinity) - (b.sla.clock.leftMs ?? Infinity));
  const subtitle = superAdmin
    ? 'Every service request across all customers with Managed Services switched on.'
    : q.data?.msp
      ? `Every service request across ${q.data.msp.name}'s customers.`
      : 'Every service request across your MSP’s customers.';

  return (
    <Page title="Service request admin" subtitle={subtitle}>
      <div className={cs.toolbar}>
        <Field label="Status">
          <Select value={status} onChange={(_, d) => setStatus(d.value)}>
            <option value="open">Open</option>
            {SR_STATUSES.map((s) => (
              <option key={s} value={s}>
                {SR_STATUS_LABELS[s]}
              </option>
            ))}
            <option value="all">All</option>
          </Select>
        </Field>
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
        <Checkbox label="Assigned to me" checked={mine} onChange={(_, d) => setMine(!!d.checked)} />
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
      {q.isError && <LoadError message={(q.error as Error).message} />}
      {status === 'open' && q.data && q.data.customers.length > 0 && <QueueTiles items={inCustomer} filter={tile} onFilter={setTile} />}
      <Card>
        {q.isLoading ? (
          <Spinner size="tiny" />
        ) : !superAdmin && !q.data?.msp ? (
          <Text>
            Your account isn&apos;t linked to an MSP, so there&apos;s no queue to show. A Super Admin can add your email domain to an MSP, or link your
            account to one.
          </Text>
        ) : (q.data?.customers.length ?? 0) === 0 ? (
          <Text>No customers here have Managed Services switched on yet. A Super Admin can switch it on, and choose each customer&apos;s MSP, from Customers.</Text>
        ) : items.length === 0 ? (
          <Text size={200}>No requests here.</Text>
        ) : (
          <DataTable size="small" minWidth={1000}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Customer</TableHeaderCell>
                <TableHeaderCell>Ref</TableHeaderCell>
                <TableHeaderCell>Title</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Site</TableHeaderCell>
                <TableHeaderCell>Priority</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Target</TableHeaderCell>
                <TableHeaderCell>Assigned to</TableHeaderCell>
                <TableHeaderCell>Raised</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((i) => (
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
                      <Link onClick={() => open(i)}>{i.reference}</Link>
                    ) : (
                      <Tooltip content="You're not on this customer's team, so you can see this request but not open it." relationship="description">
                        <Text className={cs.muted}>{i.reference}</Text>
                      </Tooltip>
                    )}
                  </TableCell>
                  <TableCell>{i.title}</TableCell>
                  <TableCell>{SR_TYPE_DEFS[i.type].label}</TableCell>
                  <TableCell>{i.sitecode ?? '—'}</TableCell>
                  <TableCell>{PRIORITY_LABEL[i.priority]}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={STATUS_COLOR[i.status]}>
                      {SR_STATUS_LABELS[i.status]}
                    </Badge>
                    {i.waiting_since && (
                      <Badge appearance="outline" color="warning" style={{ marginLeft: 4 }}>
                        Waiting on customer
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <SlaBadge clock={i.sla.clock} which={i.sla.which} />
                  </TableCell>
                  <TableCell>{i.assigned_to_name ?? '—'}</TableCell>
                  <TableCell>
                    {i.requested_by_name ?? '—'}
                    <Text size={100} block className={cs.muted}>
                      {new Date(i.created_at).toLocaleDateString()}
                    </Text>
                  </TableCell>
                  <TableCell>
                    {i.can_open && ['new', 'planned', 'built'].includes(i.status) && (
                      <Button size="small" onClick={() => setActing(i)}>
                        Assign / reply
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Card>
      {acting && <QuickActionDialog item={acting} onClose={() => setActing(null)} />}
    </Page>
  );
}

/** Assign a request or reply to it without switching to its customer. */
function QuickActionDialog({ item, onClose }: { item: QueueItem; onClose: () => void }) {
  const qc = useQueryClient();
  const base = `/msp/service-requests/${item.tenant_id}`;
  const [assignee, setAssignee] = useState(item.assigned_to ?? '');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<'public' | 'question' | 'internal'>('public');
  const staff = useQuery({
    queryKey: ['msp-sr-assignees', item.tenant_id],
    queryFn: () => api<{ id: string; display_name: string }[]>(`${base}/assignees`),
  });
  const done = () => qc.invalidateQueries({ queryKey: ['msp-service-requests'] });
  const assign = useMutation({
    mutationFn: () => api(`${base}/${item.id}/assign`, { method: 'POST', body: JSON.stringify({ userId: assignee || null }) }),
    onSuccess: done,
  });
  const reply = useMutation({
    mutationFn: () =>
      api(`${base}/${item.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body, internal: kind === 'internal', waitForReply: kind === 'question' }),
      }),
    onSuccess: () => {
      setBody('');
      done();
    },
  });
  const error = assign.error ?? reply.error;
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: '620px' }}>
        <DialogBody>
          <DialogTitle>
            {item.reference} · {item.tenant_name}
          </DialogTitle>
          <DialogContent style={{ display: 'flex', flexDirection: 'column', rowGap: 12 }}>
            <Text>{item.title}</Text>
            <Field label="Assigned to">
              <div style={{ display: 'flex', columnGap: 8 }}>
                <Select value={assignee} onChange={(_, d) => setAssignee(d.value)} style={{ flexGrow: 1 }}>
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
              <Radio value="public" label="Reply to the customer" />
              <Radio value="question" label="Ask and wait for their reply" />
              <Radio value="internal" label="Internal note" />
            </RadioGroup>
            {reply.isSuccess && <Text>Sent.</Text>}
            {error && <Text style={{ color: tokens.colorPaletteRedForeground1 }}>{error instanceof ApiError ? error.message : 'That did not work'}</Text>}
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
