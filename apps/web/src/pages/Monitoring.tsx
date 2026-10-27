import { useAuth } from '../auth';
import { Page } from '../components/Page';
import { NoTenant } from '../components/records';
import { DeviceStatus } from './monitoring/deviceStatus';

/** Monitoring > Devices: whether each site's phones, paging units, DECT and gateways are answering. */
export function Monitoring() {
  const { activeTenantId: tid, can } = useAuth();
  if (!tid) return <NoTenant />;
  return (
    <Page title="Devices" subtitle="Live status of the Teams Phone System devices, paging units, DECT, Analogue Gateways site by site.">
      <DeviceStatus base={`/t/${tid}/device-status`} canManage={can('discovery:sites:manage')} />
    </Page>
  );
}
