import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  Option,
  Switch,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import { AddRegular, DeleteRegular, EditRegular, SendRegular } from '@fluentui/react-icons';
import {
  REPORT_CATALOGUE,
  REPORT_KEYS,
  SCHEDULE_FREQUENCIES,
  SCHEDULE_FREQUENCY_LABELS,
  type MeTenant,
  type Permission,
  type ReportKey,
  type ReportScheduleInput,
  type ReportScheduleView,
  type ScheduleFrequency,
  type ScheduleRecipient,
} from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { DataTable } from '../../components/DataTable';
import { LoadError } from '../../components/records';
import { EmptyState, TableSkeleton } from '../../components/states';
import { DangerText } from '../../components/ui';
import { useNotify } from '../../hooks/useNotify';
import { reportAvailable } from './reportsShared';

const useStyles = makeStyles({
  root: { display: 'grid', ...shorthands.gap('12px') },
  bar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', ...shorthands.gap('8px') },
  muted: { color: tokens.colorNeutralForeground3 },
  people: { display: 'flex', flexWrap: 'wrap', ...shorthands.gap('4px'), whiteSpace: 'normal' },
  wrap: { whiteSpace: 'normal' },
  actions: { display: 'flex', ...shorthands.gap('2px'), justifyContent: 'flex-end' },
  form: { display: 'grid', ...shorthands.gap('12px') },
  list: {
    display: 'grid',
    ...shorthands.gap('2px'),
    maxHeight: '260px',
    overflowY: 'auto',
    ...shorthands.padding('4px', '8px'),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
  },
  role: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

const ROLE_LABEL: Record<string, string> = { SUPER_ADMIN: 'Admin', PROJECT_MANAGER: 'Project manager', ENGINEER: 'Engineer', CUSTOMER: 'Customer' };
const STATUS: Record<string, { label: string; color: 'success' | 'warning' | 'danger' | 'informative' }> = {
  sent: { label: 'Sent', color: 'success' },
  partly_sent: { label: 'Partly sent', color: 'warning' },
  email_off: { label: 'Email is off', color: 'warning' },
  failed: { label: 'Not sent', color: 'danger' },
};
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Reports > Scheduled (docs/INSIGHTS.md, step 4b): reports emailed with their PDF on the 1st of each month or quarter.
 * For staff who can set them up (`reports:schedule`).
 */
export function SchedulesPanel({ tenantId, tenant, can, startWith }: { tenantId: string; tenant: MeTenant; can: (p: Permission) => boolean; startWith?: ReportKey | null }) {
  const s = useStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  const base = `/t/${tenantId}/insights/schedules`;
  const list = useQuery({ queryKey: ['schedules', tenantId], queryFn: () => api<ReportScheduleView[]>(base) });
  const [editing, setEditing] = useState<ReportScheduleView | 'new' | null>(startWith ? 'new' : null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['schedules', tenantId] });

  const sendNow = useMutation({
    mutationFn: (id: string) => api<{ status: string; sent: number; skipped: string[] }>(`${base}/${id}/send-now`, { method: 'POST' }),
    onSuccess: (r) => {
      void refresh();
      if (r.status === 'email_off') notify('Not sent: email is switched off', { intent: 'warning', body: 'A Super Admin can switch it on in Administration > Platform settings.' });
      else if (r.sent === 0) notify('Not sent', { intent: 'error', body: r.skipped.join(' ') });
      else notify(`Sent to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}`, r.skipped.length ? { intent: 'warning', body: r.skipped.join(' ') } : undefined);
    },
    onError: (e) => notify('Not sent', { intent: 'error', body: (e as Error).message }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`${base}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void refresh();
      notify('Schedule deleted');
    },
  });

  return (
    <div className={s.root}>
      <div className={s.bar}>
        <Text className={s.muted}>
          Reports go out with their PDF attached at 07:00 UTC on the 1st: monthly ones cover last month, quarterly ones last quarter. Each person’s copy shows what
          their own role can see.
        </Text>
        <Button appearance="primary" icon={<AddRegular />} onClick={() => setEditing('new')}>
          Schedule a report
        </Button>
      </div>
      {list.isLoading ? (
        <TableSkeleton rows={3} cols={6} />
      ) : list.isError ? (
        <LoadError message={(list.error as Error).message} />
      ) : list.data!.length === 0 ? (
        <EmptyState title="No scheduled reports yet" hint="Schedule the Executive summary to send it to the customer’s leadership every month." />
      ) : (
        <DataTable minWidth={900}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Report</TableHeaderCell>
              <TableHeaderCell>How often</TableHeaderCell>
              <TableHeaderCell>To</TableHeaderCell>
              <TableHeaderCell>Next send</TableHeaderCell>
              <TableHeaderCell>Last send</TableHeaderCell>
              <TableHeaderCell />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data!.map((x) => (
              <TableRow key={x.id}>
                <TableCell>
                  <Text weight="semibold">{x.reportTitle}</Text>
                  {x.createdBy && (
                    <Text size={200} className={s.muted} block>
                      Set up by {x.createdBy}
                    </Text>
                  )}
                </TableCell>
                <TableCell>{SCHEDULE_FREQUENCY_LABELS[x.frequency]}</TableCell>
                <TableCell>
                  <div className={s.people}>
                    {x.recipients.map((r) => (
                      <Badge key={r.id} appearance="tint" color={r.ok ? 'informative' : 'danger'} title={r.ok ? r.email : `${r.name} can no longer open this customer and is skipped`}>
                        {r.name}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>{x.enabled ? when(x.nextRunAt) : <span className={s.muted}>Paused</span>}</TableCell>
                <TableCell>
                  {x.lastRunAt ? (
                    <div className={s.wrap} title={x.lastDetail ?? undefined}>
                      <Badge appearance="tint" color={STATUS[x.lastStatus ?? '']?.color ?? 'informative'}>
                        {STATUS[x.lastStatus ?? '']?.label ?? x.lastStatus}
                      </Badge>{' '}
                      <Text size={200} className={s.muted}>
                        {when(x.lastRunAt)}
                      </Text>
                    </div>
                  ) : (
                    <span className={s.muted}>Not yet</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className={s.actions}>
                    <Button size="small" appearance="subtle" icon={<SendRegular />} disabled={sendNow.isPending} onClick={() => sendNow.mutate(x.id)}>
                      Send now
                    </Button>
                    <Button size="small" appearance="subtle" icon={<EditRegular />} aria-label={`Change the ${x.reportTitle} schedule`} onClick={() => setEditing(x)} />
                    <Button size="small" appearance="subtle" icon={<DeleteRegular />} aria-label={`Delete the ${x.reportTitle} schedule`} disabled={remove.isPending} onClick={() => remove.mutate(x.id)} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      )}
      {editing && (
        <ScheduleDialog
          tenantId={tenantId}
          tenant={tenant}
          can={can}
          schedule={editing === 'new' ? null : editing}
          startWith={editing === 'new' ? (startWith ?? 'executive') : undefined}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function ScheduleDialog({
  tenantId,
  tenant,
  can,
  schedule,
  startWith,
  onClose,
  onSaved,
}: {
  tenantId: string;
  tenant: MeTenant;
  can: (p: Permission) => boolean;
  schedule: ReportScheduleView | null;
  startWith?: ReportKey;
  onClose: () => void;
  onSaved: () => void;
}) {
  const s = useStyles();
  const notify = useNotify();
  const people = useQuery({ queryKey: ['schedule-recipients', tenantId], queryFn: () => api<ScheduleRecipient[]>(`/t/${tenantId}/insights/schedules/recipients`) });
  const [reportKey, setReportKey] = useState<ReportKey>(schedule?.reportKey ?? startWith ?? 'executive');
  const [frequency, setFrequency] = useState<ScheduleFrequency>(schedule?.frequency ?? 'monthly');
  const [chosen, setChosen] = useState<Set<string>>(new Set(schedule?.recipients.map((r) => r.id) ?? []));
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [filter, setFilter] = useState('');
  useEffect(() => setFilter(''), [schedule]);
  const reports = REPORT_KEYS.filter((k) => reportAvailable(k, can, tenant));
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (people.data ?? []).filter((p) => !f || p.name.toLowerCase().includes(f) || p.email.toLowerCase().includes(f));
  }, [people.data, filter]);

  const save = useMutation({
    mutationFn: (body: ReportScheduleInput) =>
      api(schedule ? `/t/${tenantId}/insights/schedules/${schedule.id}` : `/t/${tenantId}/insights/schedules`, { method: schedule ? 'PUT' : 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      notify(schedule ? 'Schedule saved' : 'Report scheduled');
      onSaved();
    },
  });
  const toggle = (id: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ reportKey, frequency, recipients: [...chosen], enabled });
          }}
        >
          <DialogBody>
            <DialogTitle>{schedule ? 'Change the schedule' : 'Schedule a report'}</DialogTitle>
            <DialogContent className={s.form}>
              <Field label="Report">
                <Dropdown value={REPORT_CATALOGUE[reportKey].title} selectedOptions={[reportKey]} onOptionSelect={(_, d) => d.optionValue && setReportKey(d.optionValue as ReportKey)}>
                  {reports.map((k) => (
                    <Option key={k} value={k}>
                      {REPORT_CATALOGUE[k].title}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              <Field label="How often" hint={frequency === 'monthly' ? 'On the 1st of each month, covering the month before.' : 'On 1 January, April, July and October, covering the quarter before.'}>
                <Dropdown value={SCHEDULE_FREQUENCY_LABELS[frequency]} selectedOptions={[frequency]} onOptionSelect={(_, d) => d.optionValue && setFrequency(d.optionValue as ScheduleFrequency)}>
                  {SCHEDULE_FREQUENCIES.map((f) => (
                    <Option key={f} value={f}>
                      {SCHEDULE_FREQUENCY_LABELS[f]}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              <Field label={`Send to${chosen.size ? ` (${chosen.size})` : ''}`} hint="People who can open this customer in Voxshift. Each copy shows what that person’s role can see.">
                <Input placeholder="Find a person" value={filter} onChange={(_, d) => setFilter(d.value)} />
              </Field>
              <div className={s.list} role="group" aria-label="People">
                {people.isLoading ? (
                  <Text size={200}>Loading…</Text>
                ) : shown.length === 0 ? (
                  <Text size={200} className={s.muted}>
                    No one matches.
                  </Text>
                ) : (
                  shown.map((p) => (
                    <Checkbox
                      key={p.id}
                      checked={chosen.has(p.id)}
                      onChange={(_, d) => toggle(p.id, !!d.checked)}
                      label={
                        <span>
                          {p.name} <span className={s.role}>· {ROLE_LABEL[p.role] ?? p.role} · {p.email}</span>
                        </span>
                      }
                    />
                  ))
                )}
              </div>
              {schedule && <Switch label="Send on schedule" checked={enabled} onChange={(_, d) => setEnabled(d.checked)} />}
              {save.isError && <DangerText>{save.error instanceof ApiError ? save.error.message : 'The schedule was not saved.'}</DangerText>}
            </DialogContent>
            <DialogActions>
              <Button onClick={onClose}>Cancel</Button>
              <Button type="submit" appearance="primary" disabled={chosen.size === 0 || save.isPending}>
                {schedule ? 'Save' : 'Schedule'}
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
