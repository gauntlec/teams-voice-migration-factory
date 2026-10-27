import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Spinner, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text } from '@fluentui/react-components';
import { DEVICE_CHECK_LABEL, DEVICE_KIND_LABEL, type DeviceInventoryRow } from '@tvmf/shared';
import { api } from '../../api';
import { DataTable } from '../../components/DataTable';
import { LoadError } from '../../components/records';
import { EmptyState } from '../../components/states';
import { DangerText, MutedText } from '../../components/ui';
import { useNotify } from '../../hooks/useNotify';
import { AddDeviceForm } from './AddDeviceForm';
import { ChangeDeviceDialog, ManagedPanel, SettingsForm, SYNC, ago, isConfigured, useAutoSetup, useOverview, useStyles, useTick } from './common';

/**
 * Monitoring > Watch list: add devices and see the ones Voxshift watches, plus the set-up behind them. One screen: the add form is at the top and the list
 * below it updates as devices are added. Engineers and administrators only (monitoring:manage).
 */
export function WatchList({ base }: { base: string }) {
  const s = useStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  const q = useOverview(base);
  const autoSetup = useAutoSetup(base);
  const [editing, setEditing] = useState(false);
  const [change, setChange] = useState<DeviceInventoryRow | null>(null);
  useTick();
  const remove = useMutation({
    mutationFn: (id: string) => api(`${base}/devices/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['device-status', base] });
      notify('Device removed', { body: 'Voxshift stops watching it within about 15 seconds.' });
    },
    onError: (e) => notify('Could not remove it', { intent: 'error', body: (e as Error).message }),
  });

  if (q.isLoading) return <Spinner size="tiny" />;
  if (q.isError) return <LoadError message={(q.error as Error).message} />;
  const data = q.data!;
  const now = Date.now();

  if (!isConfigured(data) && !editing) {
    return (
      <EmptyState
        title="Monitoring is not set up"
        hint="Voxshift can show whether each site's phones, paging units and gateways are answering. It runs the checks with its monitoring module, installed alongside Voxshift: Voxshift sets it up for you, so you only list the devices."
        action={
          <div className={s.actions}>
            <Button appearance="primary" onClick={() => autoSetup.mutate()} disabled={autoSetup.isPending}>
              Set up automatically
            </Button>
            <Button onClick={() => setEditing(true)}>I run my own monitoring service</Button>
          </div>
        }
      />
    );
  }

  return (
    <div className={s.page}>
      <div className={s.head}>
        <MutedText size={200}>{!data.settings.enabled ? 'Switched off.' : data.settings.lastOkAt ? `Last read ${ago(data.settings.lastOkAt, now)} ago.` : 'Waiting for the first read.'}</MutedText>
        {!editing && (
          <Button size="small" onClick={() => setEditing(true)}>
            Settings
          </Button>
        )}
        {!editing && !data.managed.managed && (
          <Button size="small" appearance="primary" onClick={() => autoSetup.mutate()} disabled={autoSetup.isPending}>
            Let Voxshift look after monitoring
          </Button>
        )}
      </div>

      {editing && <SettingsForm base={base} data={data} onClose={() => setEditing(false)} />}
      {data.managed.managed && <ManagedPanel base={base} data={data} canManage />}

      {data.settings.enabled && data.settings.lastError && (
        <Card className={s.banner}>
          <DangerText weight="semibold">Voxshift cannot read the monitoring status.</DangerText>
          <Text size={200}>{data.settings.lastError}</Text>
        </Card>
      )}

      <AddDeviceForm base={base} data={data} />

      <div className={s.section}>
        <Text weight="semibold">Devices being watched</Text>
        {!data.managed.managed && data.inventory.length > 0 && <MutedText size={200}>Voxshift is not looking after the monitoring module, so these are only a list until it is switched on.</MutedText>}
        {data.inventory.length === 0 ? (
          <MutedText size={200}>Nothing on the watch list yet. Add each phone, paging unit or gateway above.</MutedText>
        ) : (
          <DataTable size="small" minWidth={760}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Device</TableHeaderCell>
                <TableHeaderCell>Site</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Check</TableHeaderCell>
                <TableHeaderCell>Checking</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.inventory.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{d.name}</TableCell>
                  <TableCell>{d.siteCode}</TableCell>
                  <TableCell>{DEVICE_KIND_LABEL[d.kind]}</TableCell>
                  <TableCell>
                    {DEVICE_CHECK_LABEL[d.checkType]} {d.address}
                    {d.port ? `:${d.port}` : ''}
                  </TableCell>
                  <TableCell title={d.syncError ?? undefined}>
                    <Badge appearance="tint" color={SYNC[d.syncState].color}>
                      {SYNC[d.syncState].label}
                    </Badge>
                    {d.syncError && <MutedText size={200}> {d.syncError}</MutedText>}
                  </TableCell>
                  <TableCell>
                    <div className={s.rowActions}>
                      <Button size="small" appearance="subtle" onClick={() => setChange(d)}>
                        Change
                      </Button>
                      <Button size="small" appearance="subtle" onClick={() => remove.mutate(d.id)} disabled={remove.isPending}>
                        Remove
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </div>
      {change && <ChangeDeviceDialog base={base} sites={data.siteOptions} device={change} onClose={() => setChange(null)} />}
    </div>
  );
}
