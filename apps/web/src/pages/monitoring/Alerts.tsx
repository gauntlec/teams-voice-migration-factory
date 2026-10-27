import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Checkbox, Field, Select, Spinner, Switch, Text, Textarea } from '@fluentui/react-components';
import { DEVICE_ALERT_FREQUENCIES, DEVICE_ALERT_FREQUENCY_LABEL, DEVICE_ALERT_REMINDER_HOURS, DEVICE_ALERT_REMINDER_LABEL, parseRecipients, type DeviceAlertFrequency, type DeviceAlertView } from '@tvmf/shared';
import { api } from '../../api';
import { LoadError } from '../../components/records';
import { DangerText, MutedText } from '../../components/ui';
import { useNotify } from '../../hooks/useNotify';
import { ago, errorText, useStyles } from './common';

/**
 * Monitoring > Alerts: who is emailed when a device goes down or comes back, and how often. Engineers and administrators only (monitoring:manage).
 * The rules are in packages/shared/src/device-alerts.ts; the worker sends (apps/worker/src/device-alerts.ts).
 */
export function Alerts({ base }: { base: string }) {
  const s = useStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  const url = `${base}/alerts`;
  const q = useQuery({ queryKey: ['device-alerts', base], queryFn: () => api<DeviceAlertView>(url) });
  const [f, setF] = useState<{ enabled: boolean; frequency: DeviceAlertFrequency; reminderHours: number; notifyEngineers: boolean; notifyProjectManagers: boolean; recipients: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (q.data && !f) setF({ enabled: q.data.enabled, frequency: q.data.frequency, reminderHours: q.data.reminderHours, notifyEngineers: q.data.notifyEngineers, notifyProjectManagers: q.data.notifyProjectManagers, recipients: q.data.recipients.join('\n') });
  }, [q.data, f]);

  const save = useMutation({
    mutationFn: () => api<DeviceAlertView>(url, { method: 'PUT', body: JSON.stringify({ ...f, recipients: parseRecipients(f!.recipients) }) }),
    onSuccess: (v) => {
      qc.setQueryData(['device-alerts', base], v);
      setError(null);
      notify('Alert settings saved', { body: v.enabled ? `${v.recipientCount} ${v.recipientCount === 1 ? 'person' : 'people'} will be emailed.` : 'Alerts are switched off.' });
    },
    onError: (e) => setError(errorText(e)),
  });
  const test = useMutation({
    mutationFn: () => api<{ sentTo: string }>(`${url}/test`, { method: 'POST', body: '{}' }),
    onSuccess: (r) => notify('Test alert sent', { body: `Check the inbox of ${r.sentTo}.` }),
    onError: (e) => notify('Could not send the test', { intent: 'error', body: errorText(e) }),
  });

  if (q.isLoading || !f) return q.isError ? <LoadError message={(q.error as Error).message} /> : <Spinner size="tiny" />;
  const v = q.data!;
  const set = (patch: Partial<NonNullable<typeof f>>) => { setError(null); setF({ ...f, ...patch }); };

  return (
    <div className={s.page}>
      {v.emailOff && (
        <Card className={s.banner}>
          <DangerText weight="semibold">Email is switched off for this installation.</DangerText>
          <Text size={200}>No alert can be sent until a Super Admin switches it on under Administration &gt; Platform settings.</Text>
        </Card>
      )}
      <Card className={s.wideForm}>
        <Switch checked={f.enabled} onChange={(_, d) => set({ enabled: d.checked })} label="Send email alerts for this customer" />
        <MutedText size={200}>An alert is sent when a device goes down, and when it comes back. Devices that are only being checked, or are in maintenance, do not trigger one.</MutedText>

        <Field label="How often" hint={f.frequency === 'immediate' ? 'An email within about a minute of a device going down or coming back.' : 'One summary email at most this often, and only when something has changed. Anything that happens in between is included.'}>
          <Select value={f.frequency} onChange={(_, d) => set({ frequency: d.value as DeviceAlertFrequency })}>
            {DEVICE_ALERT_FREQUENCIES.map((x) => (
              <option key={x} value={x}>
                {DEVICE_ALERT_FREQUENCY_LABEL[x]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Reminders while a device stays down" hint="Mention it again in an email until it is back. Reminders follow the same how-often setting.">
          <Select value={String(f.reminderHours)} onChange={(_, d) => set({ reminderHours: Number(d.value) })}>
            {DEVICE_ALERT_REMINDER_HOURS.map((h) => (
              <option key={h} value={String(h)}>
                {DEVICE_ALERT_REMINDER_LABEL[h]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Who gets them">
          <Checkbox checked={f.notifyEngineers} onChange={(_, d) => set({ notifyEngineers: !!d.checked })} label="Engineers and administrators for this customer" />
          <Checkbox checked={f.notifyProjectManagers} onChange={(_, d) => set({ notifyProjectManagers: !!d.checked })} label="Project managers for this customer" />
        </Field>
        <Field label="Other email addresses" hint="One per line, or separated by commas. For example a shared service desk mailbox.">
          <Textarea value={f.recipients} onChange={(_, d) => set({ recipients: d.value })} rows={3} resize="vertical" />
        </Field>

        {error && <DangerText size={200}>{error}</DangerText>}
        <div className={s.actions}>
          <Button appearance="primary" onClick={() => save.mutate()} disabled={save.isPending}>
            Save
          </Button>
          <Button onClick={() => test.mutate()} disabled={test.isPending || v.emailOff}>
            Send me a test alert
          </Button>
        </div>
        <MutedText size={200}>
          {v.enabled ? `Alerts go to ${v.recipientCount} ${v.recipientCount === 1 ? 'person' : 'people'} (saved settings).` : 'Alerts are off.'}
          {v.lastSentAt ? ` The last one was sent ${ago(v.lastSentAt)} ago.` : ' None has been sent yet.'} The test goes only to you.
        </MutedText>
      </Card>
    </div>
  );
}
