import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Card,
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
import { HANDSET_STAGES, HANDSET_STAGE_LABELS, type HandsetStage, type SiteHandsets } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { DataTable } from '../../components/DataTable';
import { useNotify } from '../../hooks/useNotify';
import { LoadError, useRecordStyles } from '../../components/records';

const STAGE_COLOUR: Record<HandsetStage, BadgeProps['color']> = {
  not_ordered: 'informative',
  ordered: 'warning',
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
