import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Card,
  Field,
  Link,
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
import { SR_STATUS_LABELS, SR_STATUSES, SR_TYPE_DEFS, type SrPriority, type SrStatus, type SrType } from '@tvmf/shared';
import { api } from '../api';
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
  assigned_to_name: string | null;
  created_at: string;
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

const STATUS_COLOR: Record<SrStatus, 'informative' | 'brand' | 'warning' | 'success' | 'subtle'> = {
  new: 'informative',
  planned: 'brand',
  built: 'warning',
  deployed: 'success',
  cancelled: 'subtle',
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

  const q = useQuery({
    queryKey: ['msp-service-requests', status, mspId],
    queryFn: () => api<QueueResponse>(`/msp/service-requests?status=${status}${mspId ? `&mspId=${mspId}` : ''}`),
  });
  const msps = useQuery({
    queryKey: ['msp-service-requests', 'msps'],
    enabled: superAdmin,
    queryFn: () => api<{ id: string; name: string }[]>('/msp/service-requests/msps'),
  });

  const open = (i: QueueItem) => {
    if (!i.can_open) return;
    setActiveTenant(i.tenant_id);
    navigate(`/service-requests?id=${i.id}`);
  };

  const items = (q.data?.items ?? []).filter((i) => !customer || i.tenant_id === customer);
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
                <TableHeaderCell>Assigned to</TableHeaderCell>
                <TableHeaderCell>Raised</TableHeaderCell>
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
                  </TableCell>
                  <TableCell>{i.assigned_to_name ?? '—'}</TableCell>
                  <TableCell>
                    {i.requested_by_name ?? '—'}
                    <Text size={100} block className={cs.muted}>
                      {new Date(i.created_at).toLocaleDateString()}
                    </Text>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Card>
    </Page>
  );
}
