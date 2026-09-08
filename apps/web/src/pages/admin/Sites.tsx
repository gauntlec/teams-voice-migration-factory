import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, Dropdown, Field, Option, Spinner, Text } from '@fluentui/react-components';
import { api } from '../../api';
import { Page } from '../../components/Page';
import { CrudSection, LoadError, type Row } from '../../components/records';

interface TenantRow {
  id: string;
  name: string;
}
interface SiteRollup extends Row {
  sitecode: string;
  name: string | null;
  counts?: { users: number; caps: number; resourceAccounts: number };
}
interface DiscoveryLanding {
  sites: SiteRollup[];
}

export function AdminSites() {
  const qc = useQueryClient();
  const [sel, setSel] = useState('');

  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<TenantRow[]>('/tenants') });

  useEffect(() => {
    if (!sel && tenants.data?.[0]) setSel(tenants.data[0].id);
  }, [tenants.data, sel]);

  const discovery = useQuery({
    queryKey: ['discovery', sel],
    enabled: !!sel,
    queryFn: () => api<DiscoveryLanding>(`/t/${sel}/discovery`),
  });

  const base = `/t/${sel}/discovery`;

  return (
    <Page
      title="Sites"
      subtitle="Add and maintain each customer's physical locations. Number ranges, users, CAPs and E911 subnets all attach to a site."
    >
      <Card style={{ padding: 16 }}>
        <Field label="Customer">
          <Dropdown
            value={tenants.data?.find((t) => t.id === sel)?.name ?? ''}
            selectedOptions={sel ? [sel] : []}
            onOptionSelect={(_, d) => d.optionValue && setSel(d.optionValue)}
            style={{ minWidth: 260 }}
          >
            {(tenants.data ?? []).map((t) => (
              <Option key={t.id} value={t.id} text={t.name}>
                {t.name}
              </Option>
            ))}
          </Dropdown>
        </Field>
      </Card>

      {tenants.isLoading || (sel && discovery.isLoading) ? (
        <Spinner size="tiny" />
      ) : discovery.isError ? (
        <LoadError message={(discovery.error as Error).message} />
      ) : !sel ? (
        <Text>No customers.</Text>
      ) : (
        <CrudSection
          title="Site"
          hint="The Sitecode is the site's unique key. Enter the address, then use the button to look up latitude / longitude for the map."
          basePath={`${base}/sites`}
          readOnly={false}
          onChanged={() => qc.invalidateQueries({ queryKey: ['discovery', sel] })}
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
              render: (r) => (r.latitude != null && r.longitude != null ? 'Yes' : '—'),
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
            { key: 'region', label: 'Region' },
            { key: 'latitude', label: 'Latitude', type: 'number', placeholder: '38.9201' },
            { key: 'longitude', label: 'Longitude', type: 'number', placeholder: '-94.6559' },
          ]}
        />
      )}
    </Page>
  );
}
