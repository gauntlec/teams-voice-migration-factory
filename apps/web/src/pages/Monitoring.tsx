import { MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { useAuth } from '../auth';
import { Page } from '../components/Page';
import { NoTenant } from '../components/records';
import { DevicesStatus } from './monitoring/DevicesStatus';
import { WatchList } from './monitoring/WatchList';
import { Alerts } from './monitoring/Alerts';

/** The Monitoring screens (left menu: Monitoring > Devices, Watch list, Alerts). Each is a thin page around a component in ./monitoring. */
const useBase = () => {
  const { activeTenantId: tid } = useAuth();
  return tid ? `/t/${tid}/device-status` : null;
};

/** Monitoring can be switched off for one customer (Administration > Customers): the menu hides, and a link or bookmark says so instead of failing. */
const useMonitoringOff = () => {
  const { me, activeTenantId: tid } = useAuth();
  return me?.tenants.find((t) => t.id === tid)?.monitoring === false;
};
const SwitchedOff = () => (
  <MessageBar intent="warning">
    <MessageBarBody>
      <MessageBarTitle>Not available</MessageBarTitle>
      Monitoring is switched off for this customer.
    </MessageBarBody>
  </MessageBar>
);

export function MonitoringDevices() {
  const base = useBase();
  const { can } = useAuth();
  const off = useMonitoringOff();
  if (!base) return <NoTenant />;
  if (off) return <SwitchedOff />;
  return (
    <Page title="Devices" subtitle="Live status of the Teams Phone System devices, paging units, DECT, Analogue Gateways site by site.">
      <DevicesStatus base={base} canManage={can('monitoring:manage')} />
    </Page>
  );
}

export function MonitoringWatchList() {
  const base = useBase();
  const off = useMonitoringOff();
  if (!base) return <NoTenant />;
  if (off) return <SwitchedOff />;
  return (
    <Page title="Watch list" subtitle="Add the phones, paging units, DECT bases and gateways Voxshift should watch, and see what is on the list.">
      <WatchList base={base} />
    </Page>
  );
}

export function MonitoringAlerts() {
  const base = useBase();
  const off = useMonitoringOff();
  if (!base) return <NoTenant />;
  if (off) return <SwitchedOff />;
  return (
    <Page title="Alerts" subtitle="Who is emailed when a device goes down or comes back, and how often.">
      <Alerts base={base} />
    </Page>
  );
}
