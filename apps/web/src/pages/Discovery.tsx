import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, Tab, TabList, Text, mergeClasses } from '@fluentui/react-components';
import { TENANT_OBJECT_TYPE_LABELS, type TenantDiscoverySummary, type TenantObjectType } from '@tvmf/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { Page } from '../components/Page';
import { LoadError, NoTenant } from '../components/records';
import { useStyles, str, TABS, TILE_TAB, type TabKey } from './discovery/discoveryShared';
import { ChangesTab } from './discovery/history';
import { PurgeCard, ConnectCard, RunCard } from './discovery/connect';
import { LicenceReport } from './discovery/licenceReport';
import { PoliciesTable, ResourceAccountsTab, ObjectsTable, EndpointsTable, GroupsTable, UsersTable } from './discovery/tables';

export function Discovery() {
  const s = useStyles();
  const qc = useQueryClient();
  const { activeTenantId: tid, can } = useAuth();
  const [tab, setTab] = useState<TabKey>('overview');
  const base = `/t/${tid}/tenant-discovery`;

  const summary = useQuery({
    queryKey: ['tdisc', 'summary', base],
    enabled: !!tid,
    queryFn: () => api<TenantDiscoverySummary>(`${base}/summary`),
    refetchInterval: (q) => {
      const st = q.state.data?.lastRun?.status;
      // While a run is going the RunCard polls GET runs/:id (one cheap query) for
      // the live progress bar; summary aggregates the whole snapshot, so poll it
      // gently to avoid piling load on a Postgres that's mid-discovery.
      if (st === 'queued' || st === 'running') return 12000;
      if (q.state.data?.activeConnection?.status === 'pending') return 3000;
      return 20000;
    },
  });
  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['tdisc'] });
    // what was just added to a site shows up in Site Data and Design & Build
    qc.invalidateQueries({ queryKey: ['build-summary'] });
  };
  // Adding a discovered object to a site writes to Site Data and to Design & Build, so it needs both.
  const canAdd = can('discovery:write') && can('build:write');

  if (!tid) return <NoTenant />;

  const sm = summary.data;
  const counts = sm?.counts ?? {};

  return (
    <Page
      title="Discovery"
      subtitle="A point-in-time inventory of the customer's live Microsoft Teams tenant - users, licences, numbers and every voice policy - for Site Data, Design & Build and Deployment to reference."
    >
      <div className={s.grid}>
        <ConnectCard base={base} summary={sm} canRun={can('tenantdiscovery:run')} onChanged={invalidateAll} />
        <RunCard base={base} summary={sm} />
      </div>

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as TabKey)}>
        {TABS.map((t) => (
          <Tab key={t.key} value={t.key}>
            {t.label}
          </Tab>
        ))}
      </TabList>

      {summary.isError && <LoadError message={(summary.error as Error).message} />}

      {tab === 'overview' && (
        <>
          <Card className={s.card}>
            <Text weight="semibold">Tenant</Text>
            {sm?.tenant ? (
              <Text size={200}>
                <b>{sm.tenant.displayName ?? sm.tenant.id}</b>
                {sm.tenant.displayName ? ` · ${sm.tenant.id}` : ''}
                {sm.tenant.domains.length ? ` · ${sm.tenant.domains.slice(0, 5).join(', ')}` : ''}
              </Text>
            ) : (
              <Text size={200} className={s.muted}>
                Run a discovery to capture the tenant.
              </Text>
            )}
          </Card>
          <div className={s.stats}>
            {(Object.keys(TENANT_OBJECT_TYPE_LABELS) as TenantObjectType[])
              .filter((t) => t !== 'tenant')
              .map((t) => (
                <StatTile key={t} count={counts[t] ?? 0} label={TENANT_OBJECT_TYPE_LABELS[t]} to={TILE_TAB[t]} onOpen={setTab} />
              ))}
            <StatTile count={sm?.linkedDiscoveryUsers ?? 0} label="Linked to Site Data" to="users" onOpen={setTab} />
            <StatTile count={sm?.groupsCount ?? 0} label="M365 groups" to="groups" onOpen={setTab} />
          </div>
          <PurgeCard
            base={base}
            summary={sm}
            canRun={can('tenantdiscovery:run')}
            onPurged={invalidateAll}
          />
        </>
      )}

      {tab === 'changes' && <ChangesTab base={base} />}

      {tab === 'users' && <UsersTable base={base} canImport={can('discovery:write')} canAdd={canAdd} onImported={invalidateAll} />}

      {tab === 'resource_accounts' && (
        <ResourceAccountsTab base={base} canImport={can('discovery:write')} canAdd={canAdd} onImported={invalidateAll} />
      )}

      {tab === 'numbers' && (
        <ObjectsTable
          base={base}
          type="phone_number"
          columns={[
            { label: 'Number', render: (o) => o.object_key },
            { label: 'Type', render: (o) => str(o, 'NumberType') },
            {
              label: 'Assigned to',
              render: (o) => {
                const who = o.data.AssignedTo as { upn?: string | null; displayName?: string | null; kind?: string } | undefined;
                if (who) return `${who.displayName ?? who.upn ?? '—'}${who.upn && who.displayName ? ` (${who.upn})` : ''}`;
                return str(o, 'AssignedPstnTargetId') === '—' ? '—' : `${str(o, 'AssignedPstnTargetId').slice(0, 8)}… (not in this run)`;
              },
            },
            { label: 'Status', render: (o) => str(o, 'ActivationState') },
            { label: 'Country', render: (o) => str(o, 'IsoCountryCode') },
          ]}
        />
      )}

      {tab === 'policies' && <PoliciesTable base={base} />}

      {tab === 'voice_routing' && (
        <>
          <ObjectsTable base={base} type="pstn_gateway" columns={[{ label: 'FQDN', render: (o) => o.object_key }, { label: 'Enabled', render: (o) => str(o, 'Enabled') }, { label: 'Port', render: (o) => str(o, 'SipSignalingPort') }]} />
          <ObjectsTable base={base} type="pstn_usage" columns={[{ label: 'Usage', render: (o) => o.object_key }]} />
          <ObjectsTable base={base} type="voice_route" columns={[{ label: 'Route', render: (o) => o.object_key }, { label: 'Pattern', render: (o) => str(o, 'NumberPattern') }, { label: 'Gateways', render: (o) => str(o, 'OnlinePstnGatewayList') }, { label: 'Usages', render: (o) => str(o, 'OnlinePstnUsages') }]} />
        </>
      )}

      {tab === 'emergency' && (
        <>
          <ObjectsTable base={base} type="emergency_location" columns={[{ label: 'Location', render: (o) => o.display_name ?? o.object_key }, { label: 'Address', render: (o) => [o.data.HouseNumber, o.data.StreetName].filter((v) => v != null && v !== '').join(' ') || '—' }, { label: 'City', render: (o) => str(o, 'City') }, { label: 'Country', render: (o) => str(o, 'CountryOrRegion') }]} />
          <ObjectsTable base={base} type="civic_address" columns={[{ label: 'Address', render: (o) => o.display_name ?? o.object_key }, { label: 'City', render: (o) => str(o, 'City') }, { label: 'Validated', render: (o) => str(o, 'ValidationStatus') }]} />
        </>
      )}

      {tab === 'voice_apps' && (
        <>
          <ObjectsTable base={base} type="auto_attendant" flowType="auto_attendant" addToSite={canAdd ? { kind: 'auto_attendant', onAdded: invalidateAll } : undefined} columns={[{ label: 'Name', render: (o) => o.display_name ?? o.object_key }, { label: 'Language', render: (o) => str(o, 'LanguageId') }, { label: 'Time zone', render: (o) => str(o, 'TimeZoneId') }]} />
          <ObjectsTable base={base} type="call_queue" flowType="call_queue" addToSite={canAdd ? { kind: 'call_queue', onAdded: invalidateAll } : undefined} columns={[{ label: 'Name', render: (o) => o.display_name ?? o.object_key }, { label: 'Routing', render: (o) => str(o, 'RoutingMethod') }, { label: 'Agents', render: (o) => String((o.data.Agents as unknown[] | undefined)?.length ?? '—') }]} />
          <ObjectsTable base={base} type="schedule" columns={[{ label: 'Name', render: (o) => o.display_name ?? o.object_key }, { label: 'Type', render: (o) => str(o, 'Type') }]} />
        </>
      )}

      {tab === 'devices' && <EndpointsTable base={base} canAdd={canAdd} onAdded={invalidateAll} />}

      {tab === 'groups' && <GroupsTable base={base} />}

      {tab === 'licences' && <LicenceReport base={base} />}

    </Page>
  );
}

/** A count on the Overview. When it has a tab, the whole tile is a button that opens it. */
function StatTile({ count, label, to, onOpen }: { count: number; label: string; to?: TabKey; onOpen: (tab: TabKey) => void }) {
  const s = useStyles();
  return (
    <Card
      className={to ? mergeClasses(s.stat, s.statLink) : s.stat}
      {...(to
        ? {
            role: 'button',
            tabIndex: 0,
            'aria-label': `${label}: ${count.toLocaleString()}. Open the ${TABS.find((t) => t.key === to)?.label ?? ''} tab`,
            onClick: () => onOpen(to),
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen(to);
              }
            },
          }
        : {})}
    >
      <span className={s.statN}>{count.toLocaleString()}</span>
      <Text size={200} className={s.muted}>
        {label}
      </Text>
    </Card>
  );
}
