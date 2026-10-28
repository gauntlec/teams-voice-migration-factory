import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Spinner } from '@fluentui/react-components';
import { SITE_REGIONS } from '@tvmf/shared';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Page } from '../../components/Page';
import { CrudSection, LoadError, NoTenant, type Row } from '../../components/records';

interface SiteRollup extends Row {
  sitecode: string;
  name: string | null;
  counts?: { users: number; caps: number; resourceAccounts: number };
  additionalAddresses?: { id: string; label: string | null; address: string; latitude: number | null; longitude: number | null }[];
}
interface DiscoveryLanding {
  sites: SiteRollup[];
}

export function AdminSites() {
  const qc = useQueryClient();
  const { activeTenantId } = useAuth();

  const discovery = useQuery({
    queryKey: ['discovery', activeTenantId],
    enabled: !!activeTenantId,
    queryFn: () => api<DiscoveryLanding>(`/t/${activeTenantId}/discovery`),
  });

  const base = `/t/${activeTenantId}/discovery`;

  if (!activeTenantId) return <NoTenant />;

  return (
    <Page
      title="Sites"
      subtitle="Add and maintain each customer's physical locations. Number ranges, users, CAPs and E911 subnets all attach to a site."
    >
      {discovery.isLoading ? (
        <Spinner size="tiny" />
      ) : discovery.isError ? (
        <LoadError message={(discovery.error as Error).message} />
      ) : (
        <CrudSection
          title="Site"
          hint="The Sitecode is the site's unique key. Enter the address, then use the button to look up latitude / longitude for the map. A campus with several buildings is one site: add each other civic address under Additional addresses and every one is pinned on the map under the same site code."
          basePath={`${base}/sites`}
          readOnly={false}
          onChanged={() => qc.invalidateQueries({ queryKey: ['discovery', activeTenantId] })}
          rows={discovery.data?.sites ?? []}
          geocode={{
            addressField: 'address',
            latField: 'latitude',
            lonField: 'longitude',
            run: (address) =>
              api<{ latitude: number; longitude: number; label?: string; approximate?: boolean } | null>(
                `${base}/geocode?q=${encodeURIComponent(address)}`,
              ),
          }}
          columns={[
            { key: 'sitecode', label: 'Sitecode' },
            { key: 'name', label: 'Name' },
            { key: 'address', label: 'Address' },
            { key: 'country', label: 'Country' },
            {
              key: 'placed',
              label: 'On map',
              render: (r) => {
                const extra = (r as SiteRollup).additionalAddresses ?? [];
                const pins = (r.latitude != null && r.longitude != null ? 1 : 0) + extra.filter((a) => a.latitude != null && a.longitude != null).length;
                return pins ? `${pins} ${pins === 1 ? 'pin' : 'pins'}` : '—';
              },
            },
            {
              key: 'additionalAddresses',
              label: 'Addresses',
              sortValue: (r) => 1 + ((r as SiteRollup).additionalAddresses?.length ?? 0),
              render: (r) => String(1 + ((r as SiteRollup).additionalAddresses?.length ?? 0)),
            },
            {
              key: 'users',
              label: 'Users',
              render: (r) => String((r as SiteRollup).counts?.users ?? 0),
            },
          ]}
          fields={[
            { key: 'sitecode', label: 'Sitecode', required: true, placeholder: 'OVP012' },
            { key: 'name', label: 'Site name' },
            { key: 'address', label: 'Address', type: 'textarea', full: true },
            { key: 'country', label: 'Country' },
            { key: 'region', label: 'Region', type: 'select', options: SITE_REGIONS },
            { key: 'latitude', label: 'Latitude', type: 'number', placeholder: '38.9201' },
            { key: 'longitude', label: 'Longitude', type: 'number', placeholder: '-94.6559' },
            { key: 'additionalAddresses', label: 'Additional addresses', type: 'addresses', full: true },
          ]}
        />
      )}
    </Page>
  );
}
