import { useAuth } from '../auth';
import { Page } from '../components/Page';
import { NoTenant } from '../components/records';
import { DevicesStatus } from './monitoring/DevicesStatus';
import { WatchList } from './monitoring/WatchList';
import { AddDevices } from './monitoring/AddDevices';
import { Alerts } from './monitoring/Alerts';

/** The Monitoring screens (left menu: Monitoring > Devices, Add devices, Watch list, Alerts). Each is a thin page around a component in ./monitoring. */
const useBase = () => {
  const { activeTenantId: tid } = useAuth();
  return tid ? `/t/${tid}/device-status` : null;
};

export function MonitoringDevices() {
  const base = useBase();
  const { can } = useAuth();
  if (!base) return <NoTenant />;
  return (
    <Page title="Devices" subtitle="Live status of the Teams Phone System devices, paging units, DECT, Analogue Gateways site by site.">
      <DevicesStatus base={base} canManage={can('monitoring:manage')} />
    </Page>
  );
}

export function MonitoringAdd() {
  const base = useBase();
  if (!base) return <NoTenant />;
  return (
    <Page title="Add devices" subtitle="Add the phones, paging units, DECT bases and gateways Voxshift should watch. Voxshift sets up the checking.">
      <AddDevices base={base} />
    </Page>
  );
}

export function MonitoringWatchList() {
  const base = useBase();
  if (!base) return <NoTenant />;
  return (
    <Page title="Watch list" subtitle="The devices Voxshift is watching, and the set-up behind them.">
      <WatchList base={base} />
    </Page>
  );
}

export function MonitoringAlerts() {
  const base = useBase();
  if (!base) return <NoTenant />;
  return (
    <Page title="Alerts" subtitle="Who is emailed when a device goes down or comes back, and how often.">
      <Alerts base={base} />
    </Page>
  );
}
