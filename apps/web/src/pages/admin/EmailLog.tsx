import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  SearchBox,
  Spinner,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  tokens,

  makeStyles,
  shorthands,
} from '@fluentui/react-components';
import { ArrowClockwiseRegular } from '@fluentui/react-icons';
import { api } from '../../api';
import { DataTable } from '../../components/DataTable';
import { Page } from '../../components/Page';
import { useDebounced } from '../../hooks/useDebounced';
import { LoadError } from '../../components/records';
import { DangerText, MutedText } from '../../components/ui';

const useLocalStyles = makeStyles({
  flexItemsCenterJustifySpacebetweenGap12: { display: "flex", alignItems: "center", justifyContent: "space-between", ...shorthands.gap('12px') },
  maxW320: { maxWidth: '320px' },
});


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
  /** set when a test customer's email was redirected - who it was really for */
  original_to_email: string | null;
}

interface EmailLogResponse {
  smtp: {
    mode: 'none' | 'smtp' | 'hub';
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
  const ls = useLocalStyles();
  const qc = useQueryClient();

  const [searchInput, setSearchInput] = useState('');
  const search = useDebounced(searchInput);
  const q = useQuery({
    queryKey: ['email-messages', search],
    queryFn: () => api<EmailLogResponse>(`/email-messages${search ? `?q=${encodeURIComponent(search)}` : ''}`),
    refetchInterval: 10_000,
  });

  const resend = useMutation({
    mutationFn: (id: string) => api(`/email-messages/${id}/resend`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email-messages'] }),
  });

  const smtp = q.data?.smtp;
  const items = q.data?.items ?? [];

  return (
    <Page platform
      title="Email log"
      subtitle="Queued and sent messages, with per-message SMTP delivery status."
    >
      <Card>
        <div className={ls.flexItemsCenterJustifySpacebetweenGap12}>
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
            {smtp.mode === 'hub' ? (
              <>Sending through <b>the Voxshift Hub</b>'s mail service</>
            ) : (
              <>
                Sending via <b>{smtp.host}</b>:{smtp.port} as <b>{smtp.from}</b>
                {smtp.hasCredentials ? '' : ' — no user name set, authentication will fail'}
              </>
            )}
          </Text>
        ) : (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Email is not set up</MessageBarTitle>
              Messages are written to the worker container log and marked <b>failed</b>. Choose how email is sent in{' '}
              <b>Administration &gt; Platform settings &gt; Email</b>.
            </MessageBarBody>
          </MessageBar>
        )}
        <MutedText size={200}>
          The rows below are the delivery record — one per message, with the last SMTP error and
          the retry count. Lower-level SMTP conversation logs are in the worker container
          (<code style={mono}>docker logs</code> on the Docker host).
        </MutedText>
      </Card>

      <Card>
        <SearchBox
          size="small"
          placeholder="Search by recipient, subject or template…"
          value={searchInput}
          onChange={(_, d) => setSearchInput(d.value)}
          className={ls.maxW320}
        />
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
                  <TableCell title={m.to_email}>
                    {m.to_email}
                    {m.original_to_email && (
                      <MutedText size={200} block>
                        <Badge appearance="tint" color="warning" size="small">
                          Test customer
                        </Badge>{' '}
                        would have gone to {m.original_to_email}
                      </MutedText>
                    )}
                  </TableCell>
                  <TableCell>{m.template}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={STATUS_COLOR[m.status]}>
                      {m.status}
                    </Badge>
                  </TableCell>
                  <TableCell title={m.status === 'failed' || m.status === 'skipped' ? m.error ?? undefined : undefined}>
                    {m.status === 'sent' ? (
                      <Text size={200}>sent {fmt(m.sent_at)}</Text>
                    ) : m.status === 'failed' ? (
                      <DangerText size={200}>
                        {m.error || 'failed'} · {m.attempts} {m.attempts === 1 ? 'try' : 'tries'}
                      </DangerText>
                    ) : (
                      <MutedText size={200}>
                        {m.status === 'queued' ? 'waiting' : m.status}
                        {m.attempts > 0 ? ` · ${m.attempts} tries` : ''}
                      </MutedText>
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
