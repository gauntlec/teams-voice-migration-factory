import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Spinner, Text } from '@fluentui/react-components';
import { Link } from 'react-router';
import { DEVICE_CHECK_LABEL, DEVICE_KIND_LABEL } from '@tvmf/shared';
import { api } from '../../api';
import { LoadError } from '../../components/records';
import { EmptyState } from '../../components/states';
import { DangerText, MutedText } from '../../components/ui';
import { useNotify } from '../../hooks/useNotify';
import { DeviceFields, deviceFormComplete, emptyDeviceForm, errorText, formToBody, isConfigured, useAutoSetup, useOverview, useStyles, type DeviceFormValues } from './common';

/**
 * Monitoring > Add devices: add the phones, paging units, DECT bases and gateways Voxshift should watch. Engineers and administrators only
 * (monitoring:manage). The form stays open after an add and keeps the site, type and check, so a whole site's equipment can be entered quickly.
 */
export function AddDevices({ base }: { base: string }) {
  const s = useStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  const q = useOverview(base);
  const autoSetup = useAutoSetup(base);
  const [f, setF] = useState<DeviceFormValues | null>(null);
  const [added, setAdded] = useState<Array<{ name: string; line: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: (v: DeviceFormValues) => api(`${base}/devices`, { method: 'POST', body: formToBody(v) }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['device-status', base] });
      setAdded((a) => [{ name: v.name, line: `${v.siteCode} · ${DEVICE_KIND_LABEL[v.kind]} · ${DEVICE_CHECK_LABEL[v.checkType]} ${v.address}${v.checkType === 'port' ? `:${v.port}` : ''}` }, ...a]);
      setF({ ...v, name: '', address: '', port: '' });
      notify('Device added', { body: 'Voxshift sets up the checking within about 15 seconds.' });
    },
    onError: (e) => setError(errorText(e)),
  });

  if (q.isLoading) return <Spinner size="tiny" />;
  if (q.isError) return <LoadError message={(q.error as Error).message} />;
  const data = q.data!;

  if (!isConfigured(data)) {
    return (
      <EmptyState
        title="Monitoring is not set up yet"
        hint="Set it up first and Voxshift will start watching whatever you add. It only takes a moment."
        action={
          <div className={s.actions}>
            <Button appearance="primary" onClick={() => autoSetup.mutate()} disabled={autoSetup.isPending}>
              Set up automatically
            </Button>
            <Link to="/monitoring/watch-list">
              <Button>More options</Button>
            </Link>
          </div>
        }
      />
    );
  }
  if (data.siteOptions.length === 0) {
    return <EmptyState title="This customer has no sites yet" hint="Devices belong to a site. Add the customer's sites in Data Collection first, then come back." />;
  }

  const form = f ?? emptyDeviceForm(data.siteOptions[0]!.sitecode);
  return (
    <div className={s.page}>
      <Card className={s.wideForm}>
        <DeviceFields value={form} onChange={(p) => { setError(null); setF({ ...form, ...p }); }} sites={data.siteOptions} />
        {error && <DangerText size={200}>{error}</DangerText>}
        <div className={s.actions}>
          <Button appearance="primary" onClick={() => add.mutate(form)} disabled={add.isPending || !deviceFormComplete(form)}>
            Add device
          </Button>
          <MutedText size={200}>The site, type and check stay as they are, so you can add the next one straight away.</MutedText>
        </div>
      </Card>

      {added.length > 0 && (
        <div className={s.section}>
          <Text weight="semibold">Added just now</Text>
          {added.map((a, i) => (
            <Text key={i} size={200}>
              {a.name}: <MutedText size={200}>{a.line}</MutedText>
            </Text>
          ))}
          <Link to="/monitoring/watch-list">See the watch list</Link>
        </div>
      )}
    </div>
  );
}
