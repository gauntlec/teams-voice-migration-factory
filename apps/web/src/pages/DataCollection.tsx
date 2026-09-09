import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  MessageBar,
  MessageBarBody,
  Spinner,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TabList,
  Tab,
  Text,
} from '@fluentui/react-components';
import { ArrowRightRegular, ListRegular, MapRegular } from '@fluentui/react-icons';
import { api } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { Page } from '../components/Page';
import { LoadError, NoTenant, useRecordStyles, type Row } from '../components/records';
import { SitesMap, type MapSite } from '../components/SitesMap';

export { NoTenant, LoadError } from '../components/records';

interface SiteRollup extends Row {
  sitecode: string;
  name: string | null;
  address: string | null;
  country: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  counts: {
    users: number;
    caps: number;
    resourceAccounts: number;
    network: number;
    flows: number;
    ranges: number;
    numbers: number;
    numbersAssigned: number;
  };
}
interface LandingResponse {
  discovery: { id: string; status: 'draft' | 'submitted' | 'accepted' } | null;
  callingPolicies: (Row & { name: string })[];
  siteScope: string[] | null;
  sites: SiteRollup[];
}

const STATUS_COLOR: Record<string, 'informative' | 'warning' | 'success'> = {
  draft: 'informative',
  submitted: 'warning',
  accepted: 'success',
};

export function DataCollection() {
  const s = useRecordStyles();
  const navigate = useNavigate();
  const { activeTenantId, can, me } = useAuth();
  const activeTenant = me?.tenants.find((t) => t.id === activeTenantId);
  const siteScoped = !!activeTenant?.siteScoped;
  const qc = useQueryClient();
  const key = ['discovery', activeTenantId];
  const refetch = () => qc.invalidateQueries({ queryKey: key });
  // Sites default to the list; the last choice is remembered per browser.
  const [view, setViewState] = useState<'map' | 'list'>(() => {
    const saved = localStorage.getItem('tvmf.sitesView');
    return saved === 'map' || saved === 'list' ? saved : 'list';
  });
  const setView = (v: 'map' | 'list') => {
    setViewState(v);
    localStorage.setItem('tvmf.sitesView', v);
  };

  const q = useQuery({
    queryKey: key,
    enabled: !!activeTenantId,
    queryFn: () => api<LandingResponse>(`/t/${activeTenantId}/discovery`),
  });

  const action = useMutation({
    mutationFn: (verb: 'submit' | 'accept' | 'reopen') =>
      api(`/t/${activeTenantId}/discovery/${verb}`, { method: 'POST' }),
    onSuccess: refetch,
  });

  if (!activeTenantId) return <NoTenant />;
  if (q.isLoading) return <Spinner label="Loading discovery…" />;
  if (q.isError) return <LoadError message={(q.error as Error).message} />;

  const d = q.data!;
  const status = d.discovery?.status ?? 'draft';
  const canWrite = can('discovery:write');
  const canReview = can('discovery:review');
  const canManageSites = can('discovery:sites:manage');
  const locked = !canWrite || status === 'accepted' || (status === 'submitted' && !canReview);
  const open = (id: string) => navigate(`/data-collection/sites/${id}`);

  // A site contact tied to exactly one site goes straight into that site.
  if (siteScoped && d.sites.length === 1) {
    return <Navigate to={`/data-collection/sites/${d.sites[0].id}`} replace />;
  }

  const placed = d.sites.filter((x) => x.latitude != null && x.longitude != null).length;

  return (
    <Page
      title="Data Collection"
      subtitle="Pick a site to capture its overview, numbers, users, CAPs and resource accounts."
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          {canWrite && status === 'draft' && !siteScoped && (
            <Button appearance="primary" disabled={action.isPending} onClick={() => action.mutate('submit')}>
              Submit for review
            </Button>
          )}
          {canReview && status === 'submitted' && (
            <Button appearance="primary" disabled={action.isPending} onClick={() => action.mutate('accept')}>
              Accept
            </Button>
          )}
          {canReview && status !== 'draft' && (
            <Button disabled={action.isPending} onClick={() => action.mutate('reopen')}>
              Reopen
            </Button>
          )}
        </div>
      }
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Text>Status:</Text>
        <Badge appearance="tint" color={STATUS_COLOR[status]}>
          {status}
        </Badge>
        {locked && (
          <Text size={200} className={s.muted}>
            {status === 'accepted'
              ? 'Accepted and locked — reopen to edit.'
              : status === 'submitted'
                ? 'Submitted for engineer review.'
                : 'Read-only for your role.'}
          </Text>
        )}
        {!siteScoped && (
          <>
            <Text className={s.muted}>·</Text>
            <Link to="/data-collection/policies">Outbound calling policies →</Link>
          </>
        )}
      </div>
      {action.isError && <LoadError message={(action.error as Error).message} />}

      {siteScoped && (
        <MessageBar intent="info">
          <MessageBarBody>
            You are a site contact for this customer. Only your assigned sites are shown. Each
            site's overview, the calling policies and submitting for review are handled by the
            migration team.
          </MessageBarBody>
        </MessageBar>
      )}

      <Card className={s.card}>
        <div className={s.cardHead}>
          <div>
            <Text weight="semibold" size={400}>
              Sites <span className={s.muted}>({d.sites.length})</span>
            </Text>
            {canManageSites && (
              <Text size={200} className={s.muted} block>
                Add or edit sites in <Link to="/admin/sites">Sites admin</Link>.
              </Text>
            )}
          </div>
          <TabList
            size="small"
            selectedValue={view}
            onTabSelect={(_, data) => setView(data.value as 'map' | 'list')}
            aria-label="Sites view"
          >
            <Tab value="map" icon={<MapRegular />}>
              Map
            </Tab>
            <Tab value="list" icon={<ListRegular />}>
              List
            </Tab>
          </TabList>
        </div>

        {d.sites.length === 0 ? (
          <Text size={200} className={s.muted}>
            No sites yet.{' '}
            {canManageSites ? (
              <>
                Add the first one in <Link to="/admin/sites">Sites admin</Link>.
              </>
            ) : (
              'The migration team will add them.'
            )}
          </Text>
        ) : view === 'map' ? (
          <>
            <SitesMap sites={d.sites as unknown as MapSite[]} onOpen={open} />
            {placed < d.sites.length && (
              <Text size={200} className={s.muted}>
                {d.sites.length - placed} site(s) not on the map yet — set their coordinates in{' '}
                <Link to="/admin/sites">Sites admin</Link>.
              </Text>
            )}
          </>
        ) : (
          <DataTable size="small" minWidth={900}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Sitecode</TableHeaderCell>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Country</TableHeaderCell>
                  <TableHeaderCell>Users</TableHeaderCell>
                  <TableHeaderCell>Numbers</TableHeaderCell>
                  <TableHeaderCell>CAPs</TableHeaderCell>
                  <TableHeaderCell>Res. accts</TableHeaderCell>
                  <TableHeaderCell />
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.sites.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.sitecode}</TableCell>
                    <TableCell>{r.name || '—'}</TableCell>
                    <TableCell>{r.country || '—'}</TableCell>
                    <TableCell>{r.counts?.users ?? 0}</TableCell>
                    <TableCell>
                      {r.counts ? `${r.counts.numbersAssigned}/${r.counts.numbers}` : '0/0'}
                    </TableCell>
                    <TableCell>{r.counts?.caps ?? 0}</TableCell>
                    <TableCell>{r.counts?.resourceAccounts ?? 0}</TableCell>
                    <TableCell>
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<ArrowRightRegular />}
                        onClick={() => open(r.id)}
                      >
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
          </DataTable>
        )}
      </Card>
    </Page>
  );
}
