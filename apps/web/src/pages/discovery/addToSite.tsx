import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Dropdown, Field, Option, Spinner, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles, tokens } from '@fluentui/react-components';
import type { AddFromDiscoveryInput, AddFromDiscoveryItemResult } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { useAuth } from '../../auth';
import { DataTable } from '../../components/DataTable';
import { LoadError } from '../../components/records';

/** One discovered object picked on a Discovery tab. `kind` says which list it came from; an account is a user or a common area phone. */
export interface AddItem {
  /** tenant_users.id for an account, tenant_objects.id for everything else: the exact object, never a name */
  id: string;
  label: string;
  kind: AddFromDiscoveryInput['kind'];
  /** what an account looks like from its licence plan; the engineer can change it */
  as?: 'user' | 'cap';
  detail?: string;
}

/** Ticked rows, kept across pages and searches (the whole item is stored, so its name is still there when its page is not). */
export function useRowSelection() {
  const [picked, setPicked] = useState<Map<string, AddItem>>(new Map());
  return {
    items: [...picked.values()],
    count: picked.size,
    has: (id: string) => picked.has(id),
    toggle: (item: AddItem) =>
      setPicked((prev) => {
        const next = new Map(prev);
        if (next.has(item.id)) next.delete(item.id);
        else next.set(item.id, item);
        return next;
      }),
    setMany: (items: AddItem[], on: boolean) =>
      setPicked((prev) => {
        const next = new Map(prev);
        for (const i of items) {
          if (on) next.set(i.id, i);
          else next.delete(i.id);
        }
        return next;
      }),
    clear: () => setPicked(new Map()),
  };
}

const useStyles = makeStyles({
  body: { display: 'grid', rowGap: '12px' },
  muted: { color: tokens.colorNeutralForeground3 },
  list: { margin: 0, paddingLeft: '18px' },
});

const STATUS: Record<AddFromDiscoveryItemResult['dataCollection'], string> = {
  added: 'added',
  already_on_site: 'already on this site',
  on_other_site: 'on another site',
  not_found: 'not found',
  ambiguous: 'more than one match - not added',
};

function describe(r: AddFromDiscoveryItemResult): { dc: string; build: string } {
  const dc = r.dataCollection === 'on_other_site' ? `on ${r.otherSite ?? 'another site'} (not moved)` : STATUS[r.dataCollection];
  const build = r.designAndBuild === 'off' ? 'not requested' : r.designAndBuild === 'not_added' ? 'not added' : r.designAndBuild === 'already_on_site' ? 'already there' : 'added';
  return { dc, build };
}

/**
 * Add the picked discovered objects to a site: the Data Collection record first, then (unless switched off) the Design & Build row,
 * filled from the discovered data. Objects are named by id/UPN, so two with the same display name stay two. An account can be routed
 * to Users or Common area phones; the choice starts from what its licence plan says.
 */
export function AddToSiteDialog({ items, onClose, onDone }: { items: AddItem[]; onClose: () => void; onDone: () => void }) {
  const s = useStyles();
  const { activeTenantId: tid } = useAuth();
  const [siteId, setSiteId] = useState('');
  const [alsoBuild, setAlsoBuild] = useState(true);
  const [as, setAs] = useState<Record<string, 'user' | 'cap'>>({});
  const [results, setResults] = useState<AddFromDiscoveryItemResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sites = useQuery({
    queryKey: ['tdisc', 'sites', tid],
    queryFn: () => api<{ sites: { id: string; sitecode: string; name: string | null }[] }>(`/t/${tid}/discovery`),
  });
  const siteList = sites.data?.sites ?? [];
  const siteLabel = (id: string) => {
    const x = siteList.find((v) => v.id === id);
    return x ? `${x.sitecode}${x.name ? ` · ${x.name}` : ''}` : '';
  };
  const asOf = (i: AddItem) => as[i.id] ?? i.as ?? 'user';

  const run = useMutation({
    mutationFn: async () => {
      const kinds = [...new Set(items.map((i) => i.kind))];
      const all: AddFromDiscoveryItemResult[] = [];
      for (const kind of kinds) {
        const group = items.filter((i) => i.kind === kind);
        const body: AddFromDiscoveryInput = {
          kind,
          alsoBuild,
          items: group.map((i) => ({ id: i.id, siteId, ...(kind === 'account' ? { as: asOf(i) } : {}) })),
        };
        all.push(...(await api<AddFromDiscoveryItemResult[]>(`/t/${tid}/build/add-from-discovery`, { method: 'POST', body: JSON.stringify(body) })));
      }
      return all;
    },
    onSuccess: (r) => {
      setResults(r);
      setError(null);
      onDone();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Adding to the site failed'),
  });
  const labelOf = (r: AddFromDiscoveryItemResult) => items.find((i) => i.id === r.id)?.label ?? r.label;
  const added = results?.filter((r) => r.dataCollection === 'added' || r.designAndBuild === 'added').length ?? 0;

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Add to site</DialogTitle>
          <DialogContent>
            <div className={s.body}>
              {!results ? (
                <>
                  <Text size={200}>
                    Adds {items.length === 1 ? 'this object' : `these ${items.length} objects`} to the site you pick: first the Data Collection record, then
                    {' '}the Design & Build row, filled from the discovered data. Each is matched on its own UPN or ID, so objects that share a name stay separate.
                    An object already on the site is left as it is, and one on another site is not moved.
                  </Text>
                  <Field label="Site" required>
                    {sites.isLoading ? (
                      <Spinner size="tiny" />
                    ) : (
                      <Dropdown
                        placeholder="Pick a site…"
                        selectedOptions={siteId ? [siteId] : []}
                        value={siteId ? siteLabel(siteId) : ''}
                        onOptionSelect={(_, d) => setSiteId(d.optionValue ?? '')}
                      >
                        {siteList.map((x) => (
                          <Option key={x.id} value={x.id} text={`${x.sitecode}${x.name ? ` · ${x.name}` : ''}`}>
                            {x.sitecode}
                            {x.name ? ` · ${x.name}` : ''}
                          </Option>
                        ))}
                      </Dropdown>
                    )}
                  </Field>
                  <Checkbox checked={alsoBuild} onChange={(_, d) => setAlsoBuild(!!d.checked)} label="Also add to Design & Build" />
                  <DataTable size="small" minWidth={420}>
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Object</TableHeaderCell>
                        <TableHeaderCell>Adds as</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((i) => (
                        <TableRow key={`${i.kind}-${i.id}`}>
                          <TableCell>
                            {i.label}
                            {i.detail && <Text size={200} className={s.muted} block>{i.detail}</Text>}
                          </TableCell>
                          <TableCell>
                            {i.kind === 'account' ? (
                              <Dropdown
                                size="small"
                                selectedOptions={[asOf(i)]}
                                value={asOf(i) === 'cap' ? 'Common area phone' : 'User'}
                                onOptionSelect={(_, d) => setAs((prev) => ({ ...prev, [i.id]: d.optionValue === 'cap' ? 'cap' : 'user' }))}
                              >
                                <Option value="user" text="User">User</Option>
                                <Option value="cap" text="Common area phone">Common area phone</Option>
                              </Dropdown>
                            ) : (
                              <Badge appearance="outline" size="small">
                                {i.kind === 'resource_account' ? 'Resource account' : i.kind === 'call_queue' ? 'Call queue' : 'Auto attendant'}
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </DataTable>
                  {error && <LoadError message={error} />}
                </>
              ) : (
                <>
                  <Text weight="semibold">
                    {added} added to {siteLabel(siteId)}
                  </Text>
                  <DataTable size="small" minWidth={520}>
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Object</TableHeaderCell>
                        <TableHeaderCell>Data Collection</TableHeaderCell>
                        <TableHeaderCell>Design & Build</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {results.map((r) => {
                        const d = describe(r);
                        return (
                          <TableRow key={`${r.id}-${r.key}`}>
                            <TableCell>
                              {labelOf(r)}
                              {r.as && <Text size={200} className={s.muted} block>{r.as === 'cap' ? 'Common area phone' : 'User'}</Text>}
                              {r.note && <Text size={200} className={s.muted} block>{r.note}</Text>}
                            </TableCell>
                            <TableCell>{d.dc}</TableCell>
                            <TableCell>{d.build}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </DataTable>
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            {!results ? (
              <>
                <Button appearance="secondary" onClick={onClose}>Cancel</Button>
                <Button appearance="primary" disabled={!siteId || run.isPending} onClick={() => run.mutate()}>
                  {run.isPending ? 'Adding…' : `Add ${items.length}`}
                </Button>
              </>
            ) : (
              <Button appearance="primary" onClick={onClose}>Done</Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
