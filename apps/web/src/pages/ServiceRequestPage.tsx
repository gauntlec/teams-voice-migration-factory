import { useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, Spinner, Tab, TabList, Text } from '@fluentui/react-components';
import { ArrowLeftRegular, CheckmarkRegular, ChevronRightRegular } from '@fluentui/react-icons';
import { SR_TYPE_DEFS, srStatusLabel, srHasDesign, srHasNumbersDesign, type SrDesignSummary } from '@tvmf/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { Page } from '../components/Page';
import { LoadError, NoTenant } from '../components/records';
import { STATUS_COLOR } from './ServiceRequests';
import { usePageStyles, STEPS, type PageTab, type RequestPayload } from './serviceRequest/srShared';
import { Overview } from './serviceRequest/srOverview';
import { DesignTab } from './serviceRequest/srDesign';
import { DeployTab } from './serviceRequest/srDeploy';

export function ServiceRequestPage() {
  const { id = '' } = useParams();
  const { activeTenantId, can, me } = useAuth();
  const ps = usePageStyles();
  const [tab, setTab] = useState<PageTab>('overview');

  const enabled = me?.tenants.find((t) => t.id === activeTenantId)?.managedServices ?? false;
  const base = `/t/${activeTenantId}/service-requests`;
  const canManage = can('sr:manage');

  const q = useQuery({
    queryKey: ['service-request', base, id],
    enabled: !!activeTenantId && enabled && !!id,
    queryFn: () => api<RequestPayload>(`${base}/${id}`),
  });
  const r = q.data?.request;
  const hasDesign = !!r && canManage && can('build:read') && (srHasDesign(r.type) || srHasNumbersDesign(r.type)) && !!r.site_id;
  // New numbers have nothing to deploy.
  const canDeployTab = hasDesign && !!r && srHasDesign(r.type) && can('deployment:dryrun');

  const design = useQuery({
    queryKey: ['service-request-design', base, id],
    enabled: hasDesign,
    queryFn: () => api<SrDesignSummary>(`${base}/${id}/design`),
  });

  if (!activeTenantId) return <NoTenant />;
  if (!enabled) {
    return (
      <Page narrow title="Service request">
        <Card>
          <Text>
            Managed Services isn&apos;t switched on for this customer. A Super Admin can switch it on from <b>Customers</b>.
          </Text>
        </Card>
      </Page>
    );
  }
  if (q.isLoading) return <Spinner label="Loading request…" />;
  if (q.isError || !r) return <LoadError message={q.error ? (q.error as Error).message : 'Request not found.'} />;

  return (
    <Page narrow
      title={`${r.reference} · ${r.title}`}
      subtitle={`${SR_TYPE_DEFS[r.type].label}${r.sitecode ? ` · ${r.site_name ? `${r.sitecode} (${r.site_name})` : r.sitecode}` : ''}`}
      actions={
        <RouterLink to="/service-requests">
          <Button appearance="subtle" icon={<ArrowLeftRegular />}>
            All requests
          </Button>
        </RouterLink>
      }
    >
      <div className={ps.steps} aria-label="Request progress">
        {r.status === 'cancelled' || r.status === 'declined' ? (
          <Badge appearance="tint" color={STATUS_COLOR[r.status]}>
            {srStatusLabel(r.status, canManage)}
          </Badge>
        ) : (
          STEPS.map((st, i) => {
            const at = STEPS.indexOf(r.status);
            return (
              <span key={st} className={ps.steps}>
                <Badge
                  appearance={i === at ? 'filled' : 'tint'}
                  color={i < at ? 'success' : i === at ? STATUS_COLOR[st] : 'subtle'}
                  icon={i < at ? <CheckmarkRegular /> : undefined}
                >
                  {srStatusLabel(st, canManage)}
                </Badge>
                {i < STEPS.length - 1 && <ChevronRightRegular className={ps.stepSep} />}
              </span>
            );
          })
        )}
      </div>

      {hasDesign && (
        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as PageTab)}>
          <Tab value="overview">Overview</Tab>
          <Tab value="design">Design{design.data ? ` (${design.data.items.length})` : ''}</Tab>
          {canDeployTab && <Tab value="deploy">Deploy</Tab>}
        </TabList>
      )}

      {tab === 'overview' && (
        <Overview
          base={base}
          data={q.data!}
          hasDesign={hasDesign}
          canDeployTab={canDeployTab}
          design={design.data}
          onOpenTab={setTab}
        />
      )}
      {tab === 'design' && hasDesign && <DesignTab base={base} data={q.data!} design={design.data} designError={design.error} />}
      {tab === 'deploy' && canDeployTab && (
        <DeployTab base={base} tid={activeTenantId} request={r} design={design.data} changeWindow={q.data!.changeWindow} />
      )}
    </Page>
  );
}

/* -------------------------------- overview -------------------------------- */
