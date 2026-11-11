import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Checkbox,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Select,
  Spinner,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import type { HandoverAction } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { Dialog } from '../../components/AppDialog';
import { DangerText } from '../../components/ui';

const useStyles = makeStyles({
  surface: { width: 'min(860px, 94vw)', maxWidth: 'min(860px, 94vw)' },
  stack: { display: 'grid', gap: '12px' },
  add: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'flex-end' },
  addSite: { flex: '0 0 150px' },
  addAction: { flex: '1 1 240px', minWidth: 0 },
  addOwner: { flex: '1 1 160px', minWidth: 0 },
  input: { width: '100%', minWidth: 0 },
  list: { display: 'grid', gap: '2px', maxHeight: '48vh', overflowY: 'auto' },
  row: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(60px, 90px) 1fr minmax(90px, 160px) auto',
    gap: '8px',
    alignItems: 'center',
    padding: '4px 2px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  done: { color: tokens.colorNeutralForeground3, textDecorationLine: 'line-through' },
  muted: { color: tokens.colorNeutralForeground3 },
});

interface SiteOption {
  id: string;
  sitecode: string;
  name?: string | null;
}

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Outstanding actions (docs/HANDOVER-VIEW.md step 1), every site's, in a dialog from the Service Handover page.
 */
export function HandoverActionsDialog({ tenantId, sites, canEdit, onClose }: { tenantId: string; sites: SiteOption[]; canEdit: boolean; onClose: () => void }) {
  const s = useStyles();
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>Outstanding actions</DialogTitle>
          <DialogContent>
            <HandoverActionsPanel tenantId={tenantId} sites={sites} canEdit={canEdit} />
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * Add an action for a site or every site, tick it off when it's done, or open it again. Only the open ones print in the pack,
 * numbered as the template does. With `site` (a site's own page): that site's actions and the all-sites ones.
 */
export function HandoverActionsPanel({ tenantId, sites, site: fixed, canEdit }: { tenantId: string; sites: SiteOption[]; site?: SiteOption; canEdit: boolean }) {
  const s = useStyles();
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const key = ['handover-actions', tenantId, fixed?.id ?? ''];
  const q = useQuery({ queryKey: key, queryFn: () => api<HandoverAction[]>(`/t/${tenantId}/handover/actions${fixed ? `?siteId=${fixed.id}` : ''}`) });
  const shown = useMemo(() => (q.data ?? []).filter((a) => fixed || !filter || a.site_id === filter || (filter === 'all' && a.site_id === null)), [q.data, filter, fixed]);
  const open = shown.filter((a) => !a.done_at).length;

  const [site, setSite] = useState(fixed?.id ?? '');
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['handover-actions', tenantId] });
    void qc.invalidateQueries({ queryKey: ['handover-sites', tenantId] });
  };
  const add = useMutation({
    mutationFn: () => api(`/t/${tenantId}/handover/actions`, { method: 'POST', body: JSON.stringify({ siteId: site || null, description, owner }) }),
    onSuccess: () => {
      setDescription('');
      setOwner('');
      refresh();
    },
  });
  const patch = useMutation({
    mutationFn: ({ id, done }: { id: string; done: boolean }) => api(`/t/${tenantId}/handover/actions/${id}`, { method: 'PATCH', body: JSON.stringify({ done }) }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/t/${tenantId}/handover/actions/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const error = add.error ?? patch.error ?? remove.error;
  const siteChoices = fixed ? [fixed] : sites;

  return (
    <div className={s.stack}>
      <Text size={200}>
        What&apos;s still to do at handover. The open ones print in the pack&apos;s Outstanding Actions table; tick one off when it&apos;s done and it drops out of the next
        version.{fixed ? ' Actions for all sites print in every site’s pack.' : ''}
      </Text>
      {canEdit && (
        <div className={s.add}>
          <Field label="For" className={s.addSite}>
            <Select value={site} onChange={(_, d) => setSite(d.value)}>
              {!fixed && <option value="">All sites</option>}
              {siteChoices.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.sitecode}
                </option>
              ))}
              {fixed && <option value="">All sites</option>}
            </Select>
          </Field>
          <Field label="Action" className={s.addAction}>
            <Input className={s.input} value={description} maxLength={1000} placeholder="Test 933 on the lobby phone" onChange={(_, d) => setDescription(d.value)} />
          </Field>
          <Field label="Owner" className={s.addOwner}>
            <Input className={s.input} value={owner} maxLength={300} placeholder="Who does it" onChange={(_, d) => setOwner(d.value)} />
          </Field>
          <Button appearance="primary" disabled={!description.trim() || add.isPending} onClick={() => add.mutate()}>
            {add.isPending ? 'Adding…' : 'Add action'}
          </Button>
        </div>
      )}
      {!fixed && (
        <Field label="Show">
          <Select value={filter} onChange={(_, d) => setFilter(d.value)}>
            <option value="">Every site</option>
            <option value="all">All-sites actions only</option>
            {sites.map((x) => (
              <option key={x.id} value={x.id}>
                {x.sitecode}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {q.isLoading ? (
        <Spinner size="tiny" />
      ) : q.error ? (
        <DangerText>{q.error instanceof ApiError ? q.error.message : 'Could not load the actions.'}</DangerText>
      ) : shown.length === 0 ? (
        <Text className={s.muted}>No outstanding actions.</Text>
      ) : (
        <>
          <Text size={200} weight="semibold">
            {open} open, {shown.length - open} done
          </Text>
          <div className={s.list} role="list">
            {shown.map((a) => (
              <div key={a.id} className={s.row} role="listitem">
                <Checkbox
                  checked={!!a.done_at}
                  disabled={!canEdit || patch.isPending}
                  onChange={(_, d) => patch.mutate({ id: a.id, done: !!d.checked })}
                  aria-label={a.done_at ? `Open again: ${a.description}` : `Mark done: ${a.description}`}
                />
                <Text size={200}>{a.sitecode ?? 'All sites'}</Text>
                <div>
                  <Text block className={a.done_at ? s.done : undefined}>
                    {a.description}
                  </Text>
                  <Text size={100} className={s.muted}>
                    Added {when(a.created_at)}
                    {a.created_by_name ? ` by ${a.created_by_name}` : ''}
                    {a.done_at ? ` · Done ${when(a.done_at)}${a.done_by_name ? ` by ${a.done_by_name}` : ''}` : ''}
                  </Text>
                </div>
                <Text size={200}>{a.owner || '—'}</Text>
                {canEdit ? (
                  <Tooltip content="Delete this action" relationship="label">
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={<DeleteRegular />}
                      disabled={remove.isPending}
                      onClick={() => window.confirm(`Delete "${a.description}"?`) && remove.mutate(a.id)}
                    />
                  </Tooltip>
                ) : (
                  <span />
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {error && <DangerText>{error instanceof ApiError ? error.message : 'That didn’t work.'}</DangerText>}
    </div>
  );
}
