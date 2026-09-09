import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
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
} from '@fluentui/react-components';
import { ArrowClockwiseRegular } from '@fluentui/react-icons';
import { api } from '../../api';
import { DataTable } from '../../components/DataTable';
import { Page } from '../../components/Page';
import { LoadError } from '../../components/records';

interface EmailMessage {
  id: string;
  to_email: string;
  to_name: string | null;
  template: string;
  subject: string | null;
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  error: string | null;
  attempts: number;
  related_type: string | null;
  related_id: string | null;
  created_at: string;
  sent_at: string | null;
}

interface EmailLogResponse {
  smtp: {
    configured: boolean;
    host: string | null;
    port: number;
    from: string;
    hasCredentials: boolean;
  };
  items: EmailMessage[];
}

const STATUS_COLOR = {
  queued: 'informative',
  sent: 'success',
  failed: 'danger',
  skipped: 'warning',
} as const;

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

const mono: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
};

export function AdminEmailLog() {
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ['email-messages'],
    queryFn: () => api<EmailLogResponse>('/email-messages'),
    refetchInterval: 10_000,
  });

  const resend = useMutation({
    mutationFn: (id: string) => api(`/email-messages/${id}/resend`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email-messages'] }),
  });

  const smtp = q.data?.smtp;
  const items = q.data?.items ?? [];

  return (
    <Page
      title="Email log"
      subtitle="Queued and sent messages, with per-message SMTP delivery status."
    >
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <Text weight="semibold">SMTP relay</Text>
          <Button
            size="small"
            icon={<ArrowClockwiseRegular />}
            onClick={() => q.refetch()}
            disabled={q.isFetching}
          >
            Refresh
          </Button>
        </div>
        {smtp?.configured ? (
          <Text size={200}>
            Sending via <b>{smtp.host}</b>:{smtp.port} as <b>{smtp.from}</b>
            {smtp.hasCredentials ? '' : ' — no SMTP_USER set, authentication will fail'}
          </Text>
        ) : (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>SMTP is not configured</MessageBarTitle>
              Messages are written to the worker container log and marked <b>failed</b>. Set{' '}
              <code style={mono}>SMTP_HOST</code> and the other <code style={mono}>SMTP_*</code>{' '}
              values in the deploy <code style={mono}>.env</code>, then redeploy.
            </MessageBarBody>
          </MessageBar>
        )}
        <Text size={200} style={{ color: '#666' }}>
          The rows below are the delivery record — one per message, with the last SMTP error and
          the retry count. Lower-level SMTP conversation logs are in the worker container
          (<code style={mono}>docker logs</code> on the Docker host).
        </Text>
      </Card>

      <Card>
        {q.isLoading ? (
          <Spinner size="tiny" />
        ) : q.isError ? (
          <LoadError message={(q.error as Error).message} />
        ) : items.length === 0 ? (
          <Text size={200}>No messages yet.</Text>
        ) : (
          <DataTable size="small" minWidth={820}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Queued</TableHeaderCell>
                <TableHeaderCell>To</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Delivery</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{fmt(m.created_at)}</TableCell>
                  <TableCell title={m.to_email}>{m.to_email}</TableCell>
                  <TableCell>{m.template}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={STATUS_COLOR[m.status]}>
                      {m.status}
                    </Badge>
                  </TableCell>
                  <TableCell title={m.status === 'failed' ? m.error ?? undefined : undefined}>
                    {m.status === 'sent' ? (
                      <Text size={200}>sent {fmt(m.sent_at)}</Text>
                    ) : m.status === 'failed' ? (
                      <Text size={200} style={{ color: '#b10e1c' }}>
                        {m.error || 'failed'} · {m.attempts} {m.attempts === 1 ? 'try' : 'tries'}
                      </Text>
                    ) : (
                      <Text size={200} style={{ color: '#666' }}>
                        {m.status === 'queued' ? 'waiting' : m.status}
                        {m.attempts > 0 ? ` · ${m.attempts} tries` : ''}
                      </Text>
                    )}
                  </TableCell>
                  <TableCell>
                    {(m.status === 'failed' || m.status === 'queued') && (
                      <Button
                        size="small"
                        icon={<ArrowClockwiseRegular />}
                        disabled={resend.isPending}
                        onClick={() => resend.mutate(m.id)}
                      >
                        Resend
                      </Button>
                    )}
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
