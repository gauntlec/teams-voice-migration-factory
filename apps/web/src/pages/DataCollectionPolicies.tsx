import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router-dom';
import { Button, Spinner } from '@fluentui/react-components';
import { ArrowLeftRegular } from '@fluentui/react-icons';
import { api } from '../api';
import { useAuth } from '../auth';
import { Page } from '../components/Page';
import { CrudSection, LoadError, NoTenant, type Row } from '../components/records';

interface PoliciesResponse {
  discovery: { status: 'draft' | 'submitted' | 'accepted' } | null;
  callingPolicies: (Row & { name: string })[];
}

/**
 * Customer-wide outbound calling policies. Moved off the Data Collection
 * landing page into this sub-page; users and CAPs reference one of these.
 */
export function DataCollectionPolicies() {
  const { activeTenantId, can, me } = useAuth();
  const siteScoped = !!me?.tenants.find((t) => t.id === activeTenantId)?.siteScoped;
  const qc = useQueryClient();
  const key = ['discovery', activeTenantId];

  const q = useQuery({
    queryKey: key,
    enabled: !!activeTenantId,
    queryFn: () => api<PoliciesResponse>(`/t/${activeTenantId}/discovery`),
  });

  if (!activeTenantId) return <NoTenant />;
  if (siteScoped) return <Navigate to="/data-collection" replace />;
  if (q.isLoading) return <Spinner label="Loading…" />;
  if (q.isError) return <LoadError message={(q.error as Error).message} />;

  const status = q.data!.discovery?.status ?? 'draft';
  const canReview = can('discovery:review');
  const locked =
    !can('discovery:write') || status === 'accepted' || (status === 'submitted' && !canReview);

  return (
    <Page
      title="Outbound calling policies"
      subtitle="Customer-defined dialling restrictions. Users and CAPs reference one of these."
      actions={
        <Link to="/data-collection">
          <Button appearance="subtle" icon={<ArrowLeftRegular />}>
            All sites
          </Button>
        </Link>
      }
    >
      <CrudSection
        title="Calling policies"
        basePath={`/t/${activeTenantId}/discovery/calling-policies`}
        readOnly={locked}
        onChanged={() => qc.invalidateQueries({ queryKey: key })}
        rows={q.data!.callingPolicies}
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'description', label: 'Description' },
          { key: 'allow_local', label: 'Local', render: (r) => (r.allow_local ? 'Yes' : 'No') },
          { key: 'allow_national', label: 'National', render: (r) => (r.allow_national ? 'Yes' : 'No') },
          {
            key: 'allow_international',
            label: 'Intl',
            render: (r) => (r.allow_international ? 'Yes' : 'No'),
          },
        ]}
        fields={[
          { key: 'name', label: 'Name', required: true },
          { key: 'description', label: 'Description', full: true },
          { key: 'allow_local', label: 'Allow local dialling', type: 'boolean', default: 'true' },
          { key: 'allow_national', label: 'Allow national dialling', type: 'boolean' },
          { key: 'allow_international', label: 'Allow international dialling', type: 'boolean' },
          { key: 'allow_service', label: 'Allow service numbers', type: 'boolean', default: 'true' },
          { key: 'allow_premium', label: 'Allow premium-rate dialling', type: 'boolean' },
        ]}
      />
    </Page>
  );
}
