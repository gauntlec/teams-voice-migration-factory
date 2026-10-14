import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  tokens,
} from '@fluentui/react-components';
import { ArrowClockwiseRegular } from '@fluentui/react-icons';
import { MAINTENANCE_FREEZE_MINUTES, type MaintenanceNoticeView, type ReleaseCheck } from '@tvmf/shared';
import { api } from '../../api';
import { DataTable } from '../../components/DataTable';
import { Page } from '../../components/Page';
import { LoadError } from '../../components/records';

const fmt = (iso: string) => new Date(iso).toLocaleString();
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function ago(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min ago`;
}

/** `<input type="datetime-local">` value for a Date, in the browser's own time zone. */
function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Next quarter hour at least 30 minutes away - a sensible default update time. */
function defaultUpdateTime() {
  const d = new Date(Date.now() + 30 * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  return d;
}

function Owner({ name, email }: { name: string | null; email: string | null }) {
  return <span title={email ?? undefined}>{name ?? email ?? 'Unknown user'}</span>;
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <Text weight="semibold">
        {title} ({count})
      </Text>
      {children}
    </div>
  );
}

export function AdminReleaseCheck() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['release-check'],
    queryFn: () => api<ReleaseCheck>('/platform/release-check'),
    refetchInterval: 15_000,
  });

  const initialTime = defaultUpdateTime();
  const [when, setWhen] = useState(toLocalInput(initialTime));
  const [message, setMessage] = useState(`Update at ${fmtTime(initialTime.toISOString())} - live tenant sessions will end`);
  const [err, setErr] = useState<string | null>(null);

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['release-check'] });
    void qc.invalidateQueries({ queryKey: ['maintenance'] }); // the AppShell banner
  };
  const setNotice = useMutation({
    mutationFn: () =>
      api<MaintenanceNoticeView | null>('/platform/maintenance', {
        method: 'PUT',
        body: JSON.stringify({ message, startsAt: new Date(when).toISOString() }),
      }),
    onSuccess: () => {
      setErr(null);
      refreshAll();
    },
    onError: (e) => setErr((e as Error).message),
  });
  const clearNotice = useMutation({
    mutationFn: () => api('/platform/maintenance', { method: 'DELETE' }),
    onSuccess: refreshAll,
    onError: (e) => setErr((e as Error).message),
  });

  const data = q.data;
  const notice = data?.maintenance ?? null;

  return (
    <Page narrow platform
      title="Release check"
      subtitle="What a release would interrupt right now. Releasing restarts the worker, which ends every customer-tenant sign-in and fails every queued or running discovery and deployment run."
      actions={
        <Button icon={<ArrowClockwiseRegular />} onClick={() => q.refetch()} disabled={q.isFetching}>
          Check again
        </Button>
      }
    >
      <Card>
        {q.isLoading ? (
          <Spinner size="tiny" />
        ) : q.isError ? (
          <LoadError message={(q.error as Error).message} />
        ) : data!.safe ? (
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>Safe to release</MessageBarTitle>
              Nobody is signed in to a customer tenant and no discovery or deployment run is in progress.
            </MessageBarBody>
          </MessageBar>
        ) : (
          <>
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>
                  {data!.total} {data!.total === 1 ? 'thing' : 'things'} in progress
                </MessageBarTitle>
                {data!.headline} A release now would end {data!.total === 1 ? 'it' : 'them'} - the people below would have to sign in
                again and start their runs again. Ask them first, or set a maintenance notice below.
              </MessageBarBody>
            </MessageBar>

            <Section title="Deployment runs" count={data!.deployments.length}>
              <DataTable size="small" minWidth={640}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Customer</TableHeaderCell>
                    <TableHeaderCell>Run by</TableHeaderCell>
                    <TableHeaderCell>Kind</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>Started</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data!.deployments.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell>{d.tenantName}</TableCell>
                      <TableCell>
                        <Owner name={d.ownerName} email={d.ownerEmail} />
                      </TableCell>
                      <TableCell>
                        {d.mode === 'execute' ? (
                          <Badge appearance="filled" color="danger">
                            Live deployment
                          </Badge>
                        ) : (
                          <Badge appearance="tint">What-If</Badge>
                        )}
                      </TableCell>
                      <TableCell>{d.status}</TableCell>
                      <TableCell title={fmt(d.startedAt)}>{ago(d.startedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </DataTable>
            </Section>

            <Section title="Discovery runs" count={data!.discoveryRuns.length}>
              <DataTable size="small" minWidth={640}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Customer</TableHeaderCell>
                    <TableHeaderCell>Run by</TableHeaderCell>
                    <TableHeaderCell>Kind</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>Started</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data!.discoveryRuns.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{r.tenantName}</TableCell>
                      <TableCell>
                        <Owner name={r.ownerName} email={r.ownerEmail} />
                      </TableCell>
                      <TableCell>{r.kind === 'targeted' ? 'Validate check' : 'Discovery'}</TableCell>
                      <TableCell>{r.status}</TableCell>
                      <TableCell title={fmt(r.startedAt)}>{ago(r.startedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </DataTable>
            </Section>

            <Section title="Customer-tenant sign-ins" count={data!.connections.length}>
              <DataTable size="small" minWidth={640}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Customer</TableHeaderCell>
                    <TableHeaderCell>Engineer</TableHeaderCell>
                    <TableHeaderCell>Signed in as</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>Started</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data!.connections.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>{c.tenantName}</TableCell>
                      <TableCell>
                        <Owner name={c.ownerName} email={c.ownerEmail} />
                      </TableCell>
                      <TableCell>{c.upn ?? '—'}</TableCell>
                      <TableCell>{c.status === 'pending' ? 'signing in' : 'signed in'}</TableCell>
                      <TableCell title={fmt(c.startedAt)}>{ago(c.startedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </DataTable>
            </Section>
          </>
        )}
        {data && (
          <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
            Checked {fmt(data.checkedAt)} - refreshes every 15 seconds.
          </Text>
        )}
      </Card>

      <Card>
        <Text weight="semibold">Maintenance notice</Text>
        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
          Shown as a banner to every signed-in staff member. For the final {MAINTENANCE_FREEZE_MINUTES} minutes before the time
          (and until you clear it, or 30 minutes after), nobody can start a new deployment run, discovery run or customer-tenant
          sign-in - so nothing new is cut off by the release. Clear it once the release is done.
        </Text>
        {notice && (
          <MessageBar intent={notice.phase === 'freeze' ? 'warning' : 'info'}>
            <MessageBarBody>
              <MessageBarTitle>
                {notice.phase === 'freeze' ? 'New live work is paused' : `Scheduled for ${fmt(notice.startsAt)}`}
              </MessageBarTitle>
              {notice.message}
              {notice.createdByName ? ` - set by ${notice.createdByName}` : ''}
            </MessageBarBody>
          </MessageBar>
        )}
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label="Update time" style={{ minWidth: 220 }}>
            <Input type="datetime-local" value={when} onChange={(_, d) => setWhen(d.value)} />
          </Field>
          <Field label="Message" style={{ flex: 1, minWidth: 280 }}>
            <Input value={message} maxLength={300} onChange={(_, d) => setMessage(d.value)} />
          </Field>
          <Button appearance="primary" disabled={setNotice.isPending || !message.trim() || !when} onClick={() => setNotice.mutate()}>
            {notice ? 'Update notice' : 'Set notice'}
          </Button>
          {notice && (
            <Button disabled={clearNotice.isPending} onClick={() => clearNotice.mutate()}>
              Clear notice
            </Button>
          )}
        </div>
        {err && <Text style={{ color: tokens.colorPaletteRedForeground1 }}>{err}</Text>}
      </Card>
    </Page>
  );
}
