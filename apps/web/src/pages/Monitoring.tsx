import { useAuth } from '../auth';
import { Page } from '../components/Page';
import { NoTenant } from '../components/records';
import { DeviceStatus } from './monitoring/deviceStatus';

/** Monitoring: whether each site's phones, paging units and gateways are answering. */
export function Monitoring() {
  const { activeTenantId: tid, can } = useAuth();
  if (!tid) return <NoTenant />;
  return (
    <Page title="Monitoring" subtitle="Live status of the customer's phones, paging units and gateways, site by site. Add each device and Voxshift sets up the checking.">
      <DeviceStatus base={`/t/${tid}/device-status`} canManage={can('discovery:sites:manage')} />
    </Page>
  );
}
