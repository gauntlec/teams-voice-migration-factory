import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Text,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import type { TenantDeletionCounts, TenantDeletionResult, TenantDeletionSummary } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { useAuth } from '../../auth';
import { useNotify } from '../../hooks/useNotify';
import { DangerText, MutedText } from '../../components/ui';

const useStyles = makeStyles({
  body: { display: 'grid', ...shorthands.gap('12px'), minWidth: '420px', maxWidth: '560px' },
  list: { margin: 0, paddingLeft: '20px', display: 'grid', ...shorthands.gap('4px') },
  fields: { display: 'grid', ...shorthands.gap('12px') },
  code: { maxWidth: '160px' },
  working: { display: 'flex', alignItems: 'center', ...shorthands.gap('8px') },
  dangerFill: { backgroundColor: tokens.colorPaletteRedBackground3, color: tokens.colorNeutralForegroundOnBrand, ':hover': { backgroundColor: tokens.colorPaletteRedForeground1 } },
});

/** 1,234 files / 5.2 MB, in the words a person uses. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The plain-language list of what will be deleted. Only things that exist are listed. */
export function deletionLines(c: TenantDeletionCounts): string[] {
  const lines: string[] = [];
  if (c.sites) lines.push(`${plural(c.sites, 'site')} and everything collected about them`);
  if (c.usersDeleted) lines.push(`${plural(c.usersDeleted, 'customer user account')}, for people who belong only to this customer`);
  if (c.files) lines.push(`${plural(c.files, 'stored file')} (${formatBytes(c.fileBytes)}), such as handover packs, change documents and the logo`);
  if (c.incidents) lines.push(plural(c.incidents, 'incident'));
  if (c.serviceRequests) lines.push(plural(c.serviceRequests, 'service request'));
  if (c.discoveryRuns) lines.push(`${plural(c.discoveryRuns, 'Discovery run')}, each a saved snapshot of the customer's Microsoft Teams set-up`);
  if (c.deployments) lines.push(plural(c.deployments, 'deployment record'));
  if (c.numberPorts) lines.push(plural(c.numberPorts, 'number porting request'));
  if (c.emailRecords) lines.push(`${plural(c.emailRecords, 'entry', 'entries')} in the email log`);
  return lines;
}

/**
 * Permanently deletes a customer and all of its data. Super Admin only: the Customers page shows the action only to someone with
 * `tenant:delete`, and the server refuses everyone else anyway. Needs the exact name typed and a current authenticator code.
 * `resume` is the "Finish deleting" case, where an earlier attempt stopped part way.
 */
export function DeleteCustomerDialog({ tenant, resume, onClose }: { tenant: { id: string; name: string }; resume?: boolean; onClose: () => void }) {
  const s = useStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  const { refreshMe, activeTenantId, setActiveTenant } = useAuth();
  const [typed, setTyped] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const errRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (err) errRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [err]);

  const summary = useQuery({
    queryKey: ['tenant-deletion-summary', tenant.id],
    queryFn: () => api<TenantDeletionSummary>(`/tenants/${tenant.id}/deletion-summary`),
    refetchOnWindowFocus: false,
  });
  const blockers = summary.data?.blockers ?? [];
  const nameOk = typed === tenant.name;
  const codeOk = /^\d{6}$/.test(code);

  const del = useMutation({
    mutationFn: () => api<TenantDeletionResult>(`/tenants/${tenant.id}/delete`, { method: 'POST', body: JSON.stringify({ confirmName: typed, totpCode: code }) }),
    onSuccess: async () => {
      if (activeTenantId === tenant.id) setActiveTenant(null);
      await qc.invalidateQueries({ queryKey: ['tenants'] });
      await refreshMe();
      notify(`${tenant.name} was deleted`, { body: 'The customer and all of its data have been removed.' });
      onClose();
    },
    onError: (e) => {
      setCode(''); // a code is good for one try
      if (e instanceof ApiError && e.status === 409) void summary.refetch(); // the reason may have changed
      setErr(e instanceof Error ? e.message : 'Something went wrong. Nothing more has been deleted; you can try again.');
    },
  });

  const canDelete = !!summary.data && blockers.length === 0 && nameOk && codeOk && !del.isPending;

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && !del.isPending && onClose()} modalType="alert">
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{resume ? `Finish deleting ${tenant.name}` : `Delete ${tenant.name}?`}</DialogTitle>
          <DialogContent>
            <div className={s.body}>
              {resume && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>An earlier attempt did not finish</MessageBarTitle>
                    This customer is already hidden and nobody can open it. Finish the deletion to remove what is left.
                  </MessageBarBody>
                </MessageBar>
              )}
              <Text>
                This permanently deletes <b>{tenant.name}</b> and everything about it. <b>It cannot be undone.</b>
              </Text>

              {summary.isLoading && <Spinner size="tiny" label="Counting what will be deleted…" />}
              {summary.isError && <DangerText>{(summary.error as Error).message}</DangerText>}
              {summary.data && (
                <>
                  <Text weight="semibold">What will be deleted</Text>
                  <ul className={s.list}>
                    {deletionLines(summary.data.counts).map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                    <li>The customer's own database, settings, branding and assistant permissions</li>
                  </ul>
                  {summary.data.counts.usersLoseAccess > 0 && (
                    <MutedText size={200}>
                      {plural(summary.data.counts.usersLoseAccess, 'person', 'people')} who work for you or also belong to another customer will not be
                      deleted. They only lose access to this customer.
                    </MutedText>
                  )}
                  {summary.data.openSessions > 0 && (
                    <MutedText size={200}>
                      {plural(summary.data.openSessions, 'Microsoft Teams sign-in')} {summary.data.openSessions === 1 ? 'is' : 'are'} open and will be closed.
                    </MutedText>
                  )}
                  {blockers.map((b) => (
                    <MessageBar key={b.kind} intent="error">
                      <MessageBarBody>
                        <MessageBarTitle>Not right now</MessageBarTitle>
                        {b.message}
                      </MessageBarBody>
                    </MessageBar>
                  ))}
                </>
              )}

              <MutedText size={200}>
                Backups taken earlier still contain this customer's data until they are removed or expire. The record that the customer existed, who
                deleted it and when stays in the audit log. If you may need a copy of the data, take a backup first (run <code>voxshift backup</code> on the
                server) before you go on.
              </MutedText>

              <div className={s.fields}>
                <Field label={`Type the customer's name, exactly as shown: ${tenant.name}`}>
                  <Input value={typed} onChange={(_, d) => setTyped(d.value)} autoComplete="off" spellCheck={false} disabled={del.isPending} />
                </Field>
                <Field label="Code from your authenticator app" hint="The 6-digit code that changes every 30 seconds.">
                  <Input
                    className={s.code}
                    value={code}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    onChange={(_, d) => setCode(d.value.replace(/\D/g, ''))}
                    disabled={del.isPending}
                  />
                </Field>
              </div>

              {del.isPending && (
                <div className={s.working}>
                  <Spinner size="tiny" />
                  <Text>Deleting. This can take a minute. Please keep this window open.</Text>
                </div>
              )}
              {err && (
                <div ref={errRef} role="alert">
                  <DangerText>{err}</DangerText>
                </div>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" disabled={del.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              className={mergeClasses(canDelete && s.dangerFill)}
              disabled={!canDelete}
              onClick={() => {
                setErr(null);
                del.mutate();
              }}
            >
              {resume ? 'Finish deleting' : 'Delete customer permanently'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
