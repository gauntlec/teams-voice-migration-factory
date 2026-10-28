import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useNavigate } from 'react-router';
import { RowLink } from '../components/RowLink';
import { ReviewStatusBadge } from '../components/ReviewStatusBadge';
import type { DiscoveryStatus } from '@tvmf/shared';
import {
  Card,
  MessageBar,
  MessageBarBody,
  SearchBox,
  Spinner,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TabList,
  Tab,
  Text,

  makeStyles,
  shorthands,
} from '@fluentui/react-components';
import { ListRegular, MapRegular } from '@fluentui/react-icons';
import { api } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { Page } from '../components/Page';
import { LoadError, NoTenant, useRecordStyles, type Row } from '../components/records';
import { SitesMap, type MapSite } from '../components/SitesMap';

const useLocalStyles = makeStyles({
  flexGap8: { display: "flex", ...shorthands.gap('8px') },
  flexWrapItemsCenterGap10: { display: "flex", ...shorthands.gap('10px'), alignItems: "center", flexWrap: "wrap" },
  maxW320: { maxWidth: '320px' },
});


export { NoTenant, LoadError } from '../components/records';

interface SiteRollup extends Row {
  sitecode: string;
  name: string | null;
  address: string | null;
  country: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  review_status: DiscoveryStatus;
  /** changes made after submission that nobody has acknowledged yet (reviewers only) */
  pendingChanges: number;
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
  callingPolicies: (Row & { name: string })[];
  siteScope: string[] | null;
  sites: SiteRollup[];
}

export function DataCollection() {
  const ls = useLocalStyles();
  const s = useRecordStyles();
  const navigate = useNavigate();
  const { activeTenantId, can, me } = useAuth();
  const activeTenant = me?.tenants.find((t) => t.id === activeTenantId);
  const siteScoped = !!activeTenant?.siteScoped;
  const key = ['discovery', activeTenantId];
  // Sites default to the list; the last choice is remembered per browser.
  const [view, setViewState] = useState<'map' | 'list'>(() => {
    const saved = localStorage.getItem('tvmf.sitesView');
    return saved === 'map' || saved === 'list' ? saved : 'list';
  });
  const setView = (v: 'map' | 'list') => {
    setViewState(v);
    localStorage.setItem('tvmf.sitesView', v);
  };
  const [search, setSearch] = useState('');

  const q = useQuery({
    queryKey: key,
    enabled: !!activeTenantId,
    queryFn: () => api<LandingResponse>(`/t/${activeTenantId}/discovery`),
  });

  if (!activeTenantId) return <NoTenant />;
  if (q.isLoading) return <Spinner label="Loading discovery…" />;
  if (q.isError) return <LoadError message={(q.error as Error).message} />;

  const d = q.data!;
  const canManageSites = can('discovery:sites:manage');
  const open = (id: string) => navigate(`/data-collection/sites/${id}`);

  // A site contact tied to exactly one site goes straight into that site.
  if (siteScoped && d.sites.length === 1) {
    return <Navigate to={`/data-collection/sites/${d.sites[0].id}`} replace />;
  }

  const term = search.trim().toLowerCase();
  const sites = term
    ? d.sites.filter((x) => x.sitecode.toLowerCase().includes(term) || (x.name ?? '').toLowerCase().includes(term))
    : d.sites;
  const placed = sites.filter((x) => x.latitude != null && x.longitude != null).length;

  return (
    <Page
      title="Site Data"
      subtitle="Pick a site to capture its overview, numbers, users, CAPs and resource accounts."
    >
      {!siteScoped && (
        <div className={ls.flexWrapItemsCenterGap10}>
          <Link to="/data-collection/policies">Outbound calling policies →</Link>
        </div>
      )}

      {siteScoped && (
        <MessageBar intent="info">
          <MessageBarBody>
            You are a site contact for this customer. Only your assigned sites are shown. You can submit
            each of your sites for review from its page; the site overview and the calling policies are
            handled by the migration team.
          </MessageBarBody>
        </MessageBar>
      )}

      <Card className={s.card}>
        <div className={s.cardHead}>
          <div>
            <Text weight="semibold" size={400}>
              Sites{' '}
              <span className={s.muted}>
                ({sites.length}
                {term ? ` of ${d.sites.length}` : ''})
              </span>
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

        {d.sites.length > 0 && (
          <SearchBox
            size="small"
            placeholder="Search by sitecode or name…"
            value={search}
            onChange={(_, ev) => setSearch(ev.value)}
            className={ls.maxW320}
          />
        )}

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
        ) : sites.length === 0 ? (
          <Text size={200} className={s.muted}>
            No sites match “{search}”.
          </Text>
        ) : view === 'map' ? (
          <>
            <SitesMap sites={sites as unknown as MapSite[]} onOpen={open} />
            {placed < sites.length && (
              <Text size={200} className={s.muted}>
                {sites.length - placed} site(s) not on the map yet — set their coordinates in{' '}
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
                  <TableHeaderCell>Review</TableHeaderCell>
                  <TableHeaderCell>Users</TableHeaderCell>
                  <TableHeaderCell>Numbers</TableHeaderCell>
                  <TableHeaderCell>CAPs</TableHeaderCell>
                  <TableHeaderCell>Res. accts</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sites.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                    <RowLink to={`/data-collection/sites/${r.id}`}>{r.sitecode}</RowLink>
                  </TableCell>
                    <TableCell>{r.name || '—'}</TableCell>
                    <TableCell>{r.country || '—'}</TableCell>
                    <TableCell>
                      <ReviewStatusBadge status={r.review_status} pendingChanges={r.pendingChanges} />
                    </TableCell>
                    <TableCell>{r.counts?.users ?? 0}</TableCell>
                    <TableCell>
                      {r.counts ? `${r.counts.numbersAssigned}/${r.counts.numbers}` : '0/0'}
                    </TableCell>
                    <TableCell>{r.counts?.caps ?? 0}</TableCell>
                    <TableCell>{r.counts?.resourceAccounts ?? 0}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
          </DataTable>
        )}
      </Card>
    </Page>
  );
}
