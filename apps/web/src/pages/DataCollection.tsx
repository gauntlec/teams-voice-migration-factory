import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  TabList,
  Tab,
  Text,
  Textarea,
  tokens,
} from '@fluentui/react-components';
import { ArrowRightRegular, ListRegular, MapRegular } from '@fluentui/react-icons';
import { LICENSING_MODELS, type DiscoveryGeneral } from '@tvmf/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Page } from '../components/Page';
import {
  CrudSection,
  LoadError,
  NoTenant,
  useRecordStyles,
  type FieldDef,
  type Row,
} from '../components/records';
import { SitesMap, type MapSite } from '../components/SitesMap';

export { NoTenant, LoadError } from '../components/records';

/* ------------------------------ Overview form ------------------------------ */

const GENERAL_FIELDS: FieldDef[] = [
  { key: 'migrationId', label: 'Migration ID' },
  { key: 'region', label: 'Region' },
  { key: 'author', label: 'Author' },
  { key: 'licensingModel', label: 'PSTN / licensing model', type: 'select', options: LICENSING_MODELS },
  { key: 'targetGoLive', label: 'Target go-live', placeholder: 'e.g. Q3 2026' },
  { key: 'primaryContactEmail', label: 'Primary contact email' },
  { key: 'notes', label: 'Notes', type: 'textarea', full: true },
];

function GeneralForm({
  value,
  readOnly,
  tenantId,
  onChanged,
}: {
  value: DiscoveryGeneral;
  readOnly: boolean;
  tenantId: string;
  onChanged: () => void;
}) {
  const s = useRecordStyles();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(
      Object.fromEntries(
        GENERAL_FIELDS.map((f) => [f.key, (value as Record<string, string>)?.[f.key] ?? '']),
      ),
    );
  }, [value]);

  const dirty = useMemo(
    () =>
      GENERAL_FIELDS.some(
        (f) => (draft[f.key] ?? '') !== ((value as Record<string, string>)?.[f.key] ?? ''),
      ),
    [draft, value],
  );

  const save = useMutation({
    mutationFn: () =>
      api(`/t/${tenantId}/discovery/general`, { method: 'PATCH', body: JSON.stringify(draft) }),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });

  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <Text weight="semibold">Overview</Text>
        {!readOnly && (
          <Button
            size="small"
            appearance="primary"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Spinner size="tiny" /> : 'Save'}
          </Button>
        )}
      </div>
      <div className={s.formGrid}>
        {GENERAL_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} style={f.full ? { gridColumn: '1 / -1' } : undefined}>
            {readOnly ? (
              <Text>{draft[f.key] || '—'}</Text>
            ) : f.type === 'textarea' ? (
              <Textarea
                value={draft[f.key] ?? ''}
                resize="vertical"
                onChange={(_, d) => setDraft((v) => ({ ...v, [f.key]: d.value }))}
              />
            ) : f.type === 'select' ? (
              <Dropdown
                placeholder="Select…"
                selectedOptions={draft[f.key] ? [draft[f.key]!] : []}
                value={draft[f.key] ?? ''}
                onOptionSelect={(_, d) => setDraft((v) => ({ ...v, [f.key]: d.optionValue ?? '' }))}
              >
                {LICENSING_MODELS.map((o) => (
                  <Option key={o} value={o}>
                    {o}
                  </Option>
                ))}
              </Dropdown>
            ) : (
              <Input
                placeholder={f.placeholder}
                value={draft[f.key] ?? ''}
                onChange={(_, d) => setDraft((v) => ({ ...v, [f.key]: d.value }))}
              />
            )}
          </Field>
        ))}
      </div>
      {error && <Text style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Text>}
    </Card>
  );
}

/* -------------------------------- landing -------------------------------- */

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
  discovery: { id: string; status: 'draft' | 'submitted' | 'accepted'; general: DiscoveryGeneral } | null;
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
  const [view, setView] = useState<'map' | 'list'>('map');

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
  const base = `/t/${activeTenantId}/discovery`;
  const open = (id: string) => navigate(`/data-collection/sites/${id}`);

  // A site contact tied to exactly one site goes straight into that site.
  if (siteScoped && d.sites.length === 1) {
    return <Navigate to={`/data-collection/sites/${d.sites[0].id}`} replace />;
  }

  const placed = d.sites.filter((x) => x.latitude != null && x.longitude != null).length;

  return (
    <Page
      title="Data Collection"
      subtitle="The customer's voice estate, one site at a time. Pick a site to capture its numbers, users, CAPs and resource accounts."
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
      </div>
      {action.isError && <LoadError message={(action.error as Error).message} />}

      {siteScoped && (
        <MessageBar intent="info">
          <MessageBarBody>
            You are a site contact for this customer. Only your assigned sites are shown. The
            overview, calling policies and submitting for review are handled by the migration
            engineer.
          </MessageBarBody>
        </MessageBar>
      )}

      {!siteScoped && (
        <GeneralForm
          value={d.discovery?.general ?? {}}
          readOnly={locked}
          tenantId={activeTenantId}
          onChanged={refetch}
        />
      )}

      {!siteScoped && (
        <CrudSection
          title="Outbound calling policies"
          hint="Customer-defined dialling restrictions. Users and CAPs reference one of these."
          basePath={`${base}/calling-policies`}
          readOnly={locked}
          onChanged={refetch}
          rows={d.callingPolicies}
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'description', label: 'Description' },
            { key: 'allow_local', label: 'Local', render: (r) => (r.allow_local ? 'Yes' : 'No') },
            { key: 'allow_national', label: 'National', render: (r) => (r.allow_national ? 'Yes' : 'No') },
            { key: 'allow_international', label: 'Intl', render: (r) => (r.allow_international ? 'Yes' : 'No') },
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
      )}

      <Card className={s.card}>
        <div className={s.cardHead}>
          <Text weight="semibold">
            Sites <span className={s.muted}>({d.sites.length})</span>
          </Text>
          <TabList
            size="small"
            selectedValue={view}
            onTabSelect={(_, data) => setView(data.value as 'map' | 'list')}
          >
            <Tab value="map" icon={<MapRegular />}>
              Map
            </Tab>
            <Tab value="list" icon={<ListRegular />}>
              List
            </Tab>
          </TabList>
        </div>

        {view === 'map' ? (
          <>
            {d.sites.length === 0 ? (
              <Text size={200} className={s.muted}>
                No sites yet. {canManageSites ? 'Switch to List view to add one.' : ''}
              </Text>
            ) : (
              <SitesMap sites={d.sites as unknown as MapSite[]} onOpen={open} />
            )}
            {d.sites.length > 0 && placed < d.sites.length && (
              <Text size={200} className={s.muted}>
                {d.sites.length - placed} site(s) not on the map yet — set latitude / longitude in
                List view.
              </Text>
            )}
          </>
        ) : (
          <CrudSection
            title="Site"
            hint={
              canManageSites
                ? "The Sitecode is the site's unique key — number ranges link to it. Add latitude / longitude to pin it on the map."
                : 'Managed by the migration engineer.'
            }
            basePath={`${base}/sites`}
            readOnly={locked || !canManageSites}
            onChanged={refetch}
            rows={d.sites}
            extraRowAction={(r) => (
              <Button
                size="small"
                appearance="subtle"
                icon={<ArrowRightRegular />}
                aria-label="Open site"
                onClick={() => open(r.id)}
              />
            )}
            columns={[
              { key: 'sitecode', label: 'Sitecode' },
              { key: 'name', label: 'Name' },
              { key: 'country', label: 'Country' },
              {
                key: 'users',
                label: 'Users',
                render: (r) => String((r as SiteRollup).counts?.users ?? 0),
              },
              {
                key: 'numbers',
                label: 'Numbers',
                render: (r) => {
                  const c = (r as SiteRollup).counts;
                  return c ? `${c.numbersAssigned}/${c.numbers}` : '0/0';
                },
              },
              {
                key: 'caps',
                label: 'CAPs',
                render: (r) => String((r as SiteRollup).counts?.caps ?? 0),
              },
              {
                key: 'ras',
                label: 'Res. accts',
                render: (r) => String((r as SiteRollup).counts?.resourceAccounts ?? 0),
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
      </Card>
    </Page>
  );
}
