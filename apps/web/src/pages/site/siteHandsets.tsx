import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Card,
  Checkbox,
  Dropdown,
  Option,
  Spinner,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  type BadgeProps,
} from '@fluentui/react-components';
import { HANDSET_STAGES, HANDSET_STAGE_LABELS, type HandsetStage, type SiteHandsetDevice, type SiteHandsetDevices, type SiteHandsets } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { DataTable } from '../../components/DataTable';
import { useNotify } from '../../hooks/useNotify';
import { LoadError, useRecordStyles } from '../../components/records';

const STAGE_COLOUR: Record<HandsetStage, BadgeProps['color']> = {
  not_ordered: 'informative',
  ordered: 'warning',
  delivered: 'important',
  in_tooling: 'brand',
  installed: 'success',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Handsets the site's users and common area phones need, counted from Site Data, one row per model. The project manager moves
 * each model through Ordered > Added to tooling & updated > Installed & working. Shown only when handsets have been detected.
 */
export function HandsetTrackerCard({ base, siteId, canEdit }: { base: string; siteId: string; canEdit: boolean }) {
  const s = useRecordStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  const key = ['site-handsets', base, siteId];
  const q = useQuery({ queryKey: key, queryFn: () => api<SiteHandsets>(`${base}/sites/${siteId}/handsets`) });

  const set = useMutation({
    mutationFn: (v: { model: string; status: HandsetStage }) => api<SiteHandsets>(`${base}/sites/${siteId}/handsets`, { method: 'PUT', body: JSON.stringify(v) }),
    onSuccess: (data, v) => {
      qc.setQueryData(key, data);
      notify(`${v.model}: ${HANDSET_STAGE_LABELS[v.status]}`);
    },
    onError: (e) => notify('Could not save the stage', { intent: 'error', body: e instanceof ApiError ? e.message : undefined }),
  });

  if (q.isLoading) return null;
  if (q.error) return <LoadError message={q.error instanceof ApiError ? q.error.message : 'Could not load the handsets'} />;
  const data = q.data;
  if (!data || (data.models.length === 0 && data.usersWithoutModel === 0)) return null;

  const total = data.models.reduce((n, m) => n + m.total, 0);
  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <div>
          <Text weight="semibold">Handsets</Text>
          <Text size={200} className={s.muted} block>
            {plural(total, 'handset')} across {plural(data.models.length, 'model')}, from the users and common area phones in Site Data.
            {canEdit ? ' Set where each model has got to.' : ''}
          </Text>
        </div>
        {set.isPending && <Spinner size="tiny" />}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {HANDSET_STAGES.map((st) => (
          <Badge key={st} appearance="tint" color={STAGE_COLOUR[st]} size="large">
            {HANDSET_STAGE_LABELS[st]}: {data.totals[st]}
          </Badge>
        ))}
      </div>

      {data.models.length > 0 && (
        <DataTable aria-label="Handset models" size="small" minWidth={640}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Handset model</TableHeaderCell>
              <TableHeaderCell style={{ width: 90 }}>Users</TableHeaderCell>
              <TableHeaderCell style={{ width: 150 }}>Common area phones</TableHeaderCell>
              <TableHeaderCell style={{ width: 80 }}>Total</TableHeaderCell>
              <TableHeaderCell style={{ width: 100 }} title="Ticked as installed on the Deployment page's Handsets tab">Installed</TableHeaderCell>
              <TableHeaderCell style={{ width: 260 }}>Status</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.models.map((m) => (
              <TableRow key={m.key}>
                <TableCell>
                  <Text weight="semibold" block>
                    {m.model}
                  </Text>
                  {m.updatedBy && m.updatedAt && (
                    <Text size={200} className={s.muted} block>
                      Updated by {m.updatedBy}, {new Date(m.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                    </Text>
                  )}
                </TableCell>
                <TableCell>{m.users}</TableCell>
                <TableCell>{m.caps}</TableCell>
                <TableCell>{m.total}</TableCell>
                <TableCell>
                  {m.installed} of {m.total}
                </TableCell>
                <TableCell>
                  {canEdit ? (
                    <Dropdown
                      aria-label={`Status of ${m.model}`}
                      size="small"
                      value={HANDSET_STAGE_LABELS[m.status]}
                      selectedOptions={[m.status]}
                      disabled={set.isPending}
                      onOptionSelect={(_, d) => {
                        const next = d.optionValue as HandsetStage | undefined;
                        if (next && next !== m.status) set.mutate({ model: m.model, status: next });
                      }}
                    >
                      {HANDSET_STAGES.map((st) => (
                        <Option key={st} value={st} text={HANDSET_STAGE_LABELS[st]}>
                          {HANDSET_STAGE_LABELS[st]}
                        </Option>
                      ))}
                    </Dropdown>
                  ) : (
                    <Badge appearance="tint" color={STAGE_COLOUR[m.status]}>
                      {HANDSET_STAGE_LABELS[m.status]}
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      )}

      {data.usersWithoutModel > 0 && (
        <Text size={200} className={s.muted}>
          {plural(data.usersWithoutModel, 'user')} {data.usersWithoutModel === 1 ? 'is' : 'are'} marked as needing a handset but {data.usersWithoutModel === 1 ? 'has' : 'have'} no model recorded, so
          {data.usersWithoutModel === 1 ? " isn't" : " aren't"} counted above. Enter the model on the Users tab.
        </Text>
      )}
    </Card>
  );
}

type InstallFilter = 'all' | 'to_install' | 'installed';
const INSTALL_FILTER_LABELS: Record<InstallFilter, string> = { all: 'All', to_install: 'Not installed yet', installed: 'Installed' };

/**
 * Deployment > Handsets: every user who gets a physical handset (Site Data says so, or names the model) and every common area phone,
 * each with a tick for "installed and working". The Site Overview's handset tracker counts these ticks per model.
 */
export function HandsetInstallCard({ base, siteId, canEdit }: { base: string; siteId: string; canEdit: boolean }) {
  const s = useRecordStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  const [filter, setFilter] = useState<InstallFilter>('all');
  const key = ['site-handset-devices', base, siteId];
  const q = useQuery({ queryKey: key, queryFn: () => api<SiteHandsetDevices>(`${base}/sites/${siteId}/handset-devices`) });
  const tick = useMutation({
    mutationFn: (v: { d: SiteHandsetDevice; installed: boolean }) =>
      api<SiteHandsetDevices>(`${base}/sites/${siteId}/handset-devices/${v.d.kind}/${v.d.id}`, { method: 'PUT', body: JSON.stringify({ installed: v.installed }) }),
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      qc.invalidateQueries({ queryKey: ['site-handsets', base, siteId] });
    },
    onError: (e) => notify('Could not save the tick', { intent: 'error', body: e instanceof ApiError ? e.message : undefined }),
  });

  if (q.isLoading) return <Spinner size="tiny" />;
  if (q.error) return <LoadError message={q.error instanceof ApiError ? q.error.message : 'Could not load the handsets'} />;
  const data = q.data;
  if (!data || data.total === 0) {
    return (
      <Card className={s.card}>
        <Text weight="semibold">Handsets</Text>
        <Text size={200} className={s.muted}>
          No user at this site needs a physical handset, and there are no common area phones. In Site Data, tick "Requires a physical handset" or enter a
          handset model on a user.
        </Text>
      </Card>
    );
  }
  const shown = data.devices.filter((d) => (filter === 'all' ? true : filter === 'installed' ? !!d.installedAt : !d.installedAt));
  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <div>
          <Text weight="semibold">Handsets</Text>
          <Text size={200} className={s.muted} block>
            {data.installed} of {plural(data.total, 'handset')} installed and working. The list comes from Site Data: users who need a handset, and every
            common area phone.{canEdit ? ' Tick each one once it is installed and working.' : ''}
          </Text>
        </div>
        <Dropdown
          aria-label="Show"
          size="small"
          value={INSTALL_FILTER_LABELS[filter]}
          selectedOptions={[filter]}
          onOptionSelect={(_, d) => setFilter((d.optionValue as InstallFilter) ?? 'all')}
          style={{ minWidth: 170 }}
        >
          {(Object.keys(INSTALL_FILTER_LABELS) as InstallFilter[]).map((f) => (
            <Option key={f} value={f} text={INSTALL_FILTER_LABELS[f]}>
              {INSTALL_FILTER_LABELS[f]}
            </Option>
          ))}
        </Dropdown>
      </div>
      {shown.length === 0 ? (
        <Text size={200} className={s.muted}>
          {filter === 'installed' ? 'None ticked as installed yet.' : 'Every handset is installed.'}
        </Text>
      ) : (
        <DataTable aria-label="Handsets to install" size="small" minWidth={640}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell style={{ width: 110 }}>Installed</TableHeaderCell>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell style={{ width: 170 }}>Type</TableHeaderCell>
              <TableHeaderCell>Model</TableHeaderCell>
              <TableHeaderCell>Ticked by</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((d) => (
              <TableRow key={`${d.kind}:${d.id}`}>
                <TableCell>
                  <Checkbox
                    aria-label={`${d.name} installed`}
                    checked={!!d.installedAt}
                    disabled={!canEdit || tick.isPending}
                    onChange={(_, v) => tick.mutate({ d, installed: !!v.checked })}
                  />
                </TableCell>
                <TableCell>
                  <Text block>{d.name}</Text>
                  {d.upn && d.upn !== d.name && (
                    <Text size={200} className={s.muted} block>
                      {d.upn}
                    </Text>
                  )}
                </TableCell>
                <TableCell>{d.kind === 'user' ? 'User' : 'Common area phone'}</TableCell>
                <TableCell>{d.model ?? <span className={s.muted}>No model in Site Data</span>}</TableCell>
                <TableCell>
                  {d.installedAt ? `${d.installedBy ?? 'Someone'}, ${new Date(d.installedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      )}
    </Card>
  );
}

export type HandsetListFilter = '' | 'yes' | 'no';
const HANDSET_LIST_FILTER_LABELS: Record<HandsetListFilter, string> = { '': 'Everyone', yes: 'Gets a handset', no: 'No handset' };

/** The "who gets a handset" filter on the Site Data and Design & Build Users lists. */
export function HandsetListFilterDropdown({ value, onChange }: { value: HandsetListFilter; onChange: (v: HandsetListFilter) => void }) {
  return (
    <Dropdown
      aria-label="Handset"
      size="small"
      value={`Handset: ${HANDSET_LIST_FILTER_LABELS[value]}`}
      selectedOptions={[value]}
      onOptionSelect={(_, d) => onChange((d.optionValue as HandsetListFilter) ?? '')}
      style={{ minWidth: 190 }}
    >
      {(Object.keys(HANDSET_LIST_FILTER_LABELS) as HandsetListFilter[]).map((f) => (
        <Option key={f || 'all'} value={f} text={HANDSET_LIST_FILTER_LABELS[f]}>
          {HANDSET_LIST_FILTER_LABELS[f]}
        </Option>
      ))}
    </Dropdown>
  );
}

/** A user's handset in a list: the model (or "Yes" with no model yet), and "Installed" once it is ticked on the Deployment page. */
export function HandsetCell({ needed, model, installedAt }: { needed: boolean; model: string | null | undefined; installedAt: string | null | undefined }) {
  const name = model?.trim();
  if (!needed && !name) return <>—</>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {name || 'Yes, no model yet'}
      {installedAt && (
        <Badge appearance="tint" color="success" size="small" title={`Installed ${new Date(installedAt).toLocaleDateString()}`}>
          Installed
        </Badge>
      )}
    </span>
  );
}
