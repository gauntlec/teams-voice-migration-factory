import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Text } from '@fluentui/react-components';
import { type DeviceStatusOverview } from '@tvmf/shared';
import { api } from '../../api';
import { DangerText, MutedText } from '../../components/ui';
import { useNotify } from '../../hooks/useNotify';
import { DeviceFields, deviceFormComplete, emptyDeviceForm, errorText, formToBody, useStyles, type DeviceFormValues } from './common';

/**
 * The form at the top of Monitoring > Watch list: add a phone, paging unit, DECT base or gateway. It stays open after an add and keeps the site, type and check,
 * so a whole site's equipment can be entered one after the other; the list below it updates as each one is added.
 */
export function AddDeviceForm({ base, data }: { base: string; data: DeviceStatusOverview }) {
  const s = useStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  const [f, setF] = useState<DeviceFormValues | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: (v: DeviceFormValues) => api(`${base}/devices`, { method: 'POST', body: formToBody(v) }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['device-status', base] });
      setF({ ...v, name: '', address: '', port: '' });
      notify('Device added', { body: 'Voxshift sets up the checking within about 15 seconds.' });
    },
    onError: (e) => setError(errorText(e)),
  });

  if (data.siteOptions.length === 0) {
    return <MutedText size={200}>This customer has no sites yet. Devices belong to a site: add the customer's sites in Site Data first.</MutedText>;
  }
  const form = f ?? emptyDeviceForm(data.siteOptions[0]!.sitecode);
  return (
    <Card className={s.wideForm}>
      <Text weight="semibold">Add a device</Text>
      <DeviceFields value={form} onChange={(p) => { setError(null); setF({ ...form, ...p }); }} sites={data.siteOptions} />
      {error && <DangerText size={200}>{error}</DangerText>}
      <div className={s.actions}>
        <Button appearance="primary" onClick={() => add.mutate(form)} disabled={add.isPending || !deviceFormComplete(form)}>
          Add device
        </Button>
        <MutedText size={200}>The site, type and check stay as they are, so you can add the next one straight away.</MutedText>
      </div>
    </Card>
  );
}
