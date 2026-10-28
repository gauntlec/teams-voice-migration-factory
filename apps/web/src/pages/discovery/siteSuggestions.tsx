import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, MessageBar, MessageBarBody, Spinner, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles, tokens } from '@fluentui/react-components';
import type { AddFromDiscoveryInput, AddFromDiscoveryItemResult, MixedSuggestion, SiteSuggestion, SiteSuggestions } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { useAuth } from '../../auth';
import { DataTable } from '../../components/DataTable';
import { LoadError } from '../../components/records';

const KIND_LABEL: Record<SiteSuggestion['kind'], string> = {
  account: 'User',
  resource_account: 'Resource account',
  auto_attendant: 'Auto attendant',
  call_queue: 'Call queue',
};
const kindLabel = (i: SiteSuggestion) => (i.kind === 'account' && i.as === 'cap' ? 'Common area phone' : KIND_LABEL[i.kind]);

export const SITE_SUGGESTIONS_KEY = ['tdisc', 'site-suggestions'] as const;

/**
 * Which site each discovered object's number points at (see packages/db/src/site-suggestions.ts), keyed by the object's id as the
 * Discovery lists have it. Empty while loading, or when the person may not see it - the column then just shows a dash.
 */
export function useSiteSuggestions(siteId?: string) {
  const { activeTenantId: tid } = useAuth();
  const q = useQuery({
    queryKey: [...SITE_SUGGESTIONS_KEY, tid, siteId ?? 'all'],
    queryFn: () => api<SiteSuggestions>(`/t/${tid}/tenant-discovery/site-suggestions${siteId ? `?siteId=${siteId}` : ''}`),
    retry: false,
    staleTime: 30_000,
  });
  const byId = useMemo(() => new Map((q.data?.items ?? []).map((i) => [i.id, i])), [q.data]);
  const mixedById = useMemo(() => new Map((q.data?.mixed ?? []).map((m) => [m.id, m])), [q.data]);
  return { ...q, items: q.data?.items ?? [], mixed: q.data?.mixed ?? [], byId, mixedById };
}

/** The "Site (from number)" cell of a Discovery list: the suggested site, or a warning when the number disagrees with where it is. */
export function SuggestedSiteCell({ id, byId, mixedById }: { id: string; byId: Map<string, SiteSuggestion>; mixedById: Map<string, MixedSuggestion> }) {
  const s = byId.get(id);
  if (s) {
    const numbers = s.numbers.join(', ');
    return s.state === 'suggest' ? (
      <Badge appearance="tint" color="brand" size="small" title={`${numbers} is in the number ranges of ${s.sitecode}`}>
        Suggest {s.sitecode}
      </Badge>
    ) : (
      <Badge appearance="tint" color="warning" size="small" title={`${numbers} is in the number ranges of ${s.sitecode}, but it is on ${s.onSitecode ?? 'another site'} in Site Data. It is not moved automatically.`}>
        On {s.onSitecode ?? 'another site'} · number in {s.sitecode}
      </Badge>
    );
  }
  const m = mixedById.get(id);
  if (m)
    return (
      <Badge appearance="tint" color="warning" size="small" title="Its numbers are in the ranges of more than one site, so no site is suggested.">
        Numbers in {m.sitecodes.join(', ')}
      </Badge>
    );
  return <span>—</span>;
}

const useStyles = makeStyles({
  card: { display: 'grid', rowGap: '8px', padding: '12px 16px' },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', columnGap: '12px', flexWrap: 'wrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  body: { display: 'grid', rowGap: '12px' },
});

/**
 * On a site: the discovered objects whose numbers are in this site's ranges but that are not on the site yet, with one place to
 * review and add them; and a count of ones whose number says this site but that sit on another (never moved from here).
 */
export function SiteSuggestionsCard({ siteId, sitecode, locked, onAdded }: { siteId: string; sitecode: string; locked: boolean; onAdded: () => void }) {
  const s = useStyles();
  const sug = useSiteSuggestions(siteId);
  const [open, setOpen] = useState(false);
  if (sug.isLoading || sug.isError) return null;
  const toAdd = sug.items.filter((i) => i.state === 'suggest');
  const elsewhere = sug.items.filter((i) => i.state === 'other_site');
  if (!toAdd.length && !elsewhere.length && !sug.mixed.length) return null;
  return (
    <Card className={s.card}>
      <div className={s.head}>
        <div>
          <Text weight="semibold">Found in Teams for {sitecode}</Text>
          <br />
          <Text size={200} className={s.muted}>
            {toAdd.length > 0
              ? `${toAdd.length} discovered ${toAdd.length === 1 ? 'object has a number' : 'objects have numbers'} in this site's ranges but ${toAdd.length === 1 ? 'is' : 'are'} not on the site.`
              : 'Nothing is waiting to be added.'}
            {elsewhere.length > 0 && ` ${elsewhere.length} with a number here ${elsewhere.length === 1 ? 'is' : 'are'} on another site.`}
            {sug.mixed.length > 0 && ` ${sug.mixed.length} ${sug.mixed.length === 1 ? 'has' : 'have'} numbers in more than one site's ranges.`}
          </Text>
        </div>
        {toAdd.length > 0 && !locked && (
          <Button appearance="primary" size="small" onClick={() => setOpen(true)}>
            Review and add…
          </Button>
        )}
      </div>
      {open && <ReviewDialog siteId={siteId} sitecode={sitecode} items={toAdd} elsewhere={elsewhere} onClose={() => setOpen(false)} onAdded={onAdded} />}
    </Card>
  );
}

function ReviewDialog({ siteId, sitecode, items, elsewhere, onClose, onAdded }: { siteId: string; sitecode: string; items: SiteSuggestion[]; elsewhere: SiteSuggestion[]; onClose: () => void; onAdded: () => void }) {
  const s = useStyles();
  const qc = useQueryClient();
  const { activeTenantId: tid } = useAuth();
  const [picked, setPicked] = useState<Set<string>>(new Set(items.map((i) => i.id)));
  const [alsoBuild, setAlsoBuild] = useState(false);
  const [results, setResults] = useState<AddFromDiscoveryItemResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: async () => {
      const all: AddFromDiscoveryItemResult[] = [];
      for (const kind of ['account', 'resource_account', 'auto_attendant', 'call_queue'] as const) {
        const group = items.filter((i) => i.kind === kind && picked.has(i.id));
        if (!group.length) continue;
        const body: AddFromDiscoveryInput = { kind, alsoBuild, items: group.map((i) => ({ id: i.id, siteId, ...(i.as ? { as: i.as } : {}) })) };
        all.push(...(await api<AddFromDiscoveryItemResult[]>(`/t/${tid}/build/add-from-discovery`, { method: 'POST', body: JSON.stringify(body) })));
      }
      return all;
    },
    onSuccess: (r) => {
      setResults(r);
      setError(null);
      void qc.invalidateQueries({ queryKey: SITE_SUGGESTIONS_KEY });
      onAdded();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Adding to the site failed'),
  });

  const added = results?.filter((r) => r.dataCollection === 'added' || r.designAndBuild === 'added').length ?? 0;
  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: 820, width: '95vw' }}>
        <DialogBody>
          <DialogTitle>Add to {sitecode}: found in Teams</DialogTitle>
          <DialogContent className={s.body}>
            {results ? (
              <>
                <MessageBar intent={added ? 'success' : 'warning'}>
                  <MessageBarBody>{added ? `Added ${added} to ${sitecode}.` : 'Nothing was added.'}</MessageBarBody>
                </MessageBar>
                <ul>
                  {results.map((r) => (
                    <li key={r.id}>
                      {r.label}: {r.dataCollection === 'added' ? 'added' : r.dataCollection === 'already_on_site' ? 'already on this site' : r.dataCollection === 'on_other_site' ? `on ${r.otherSite ?? 'another site'} (not moved)` : r.dataCollection}
                      {r.designAndBuild === 'added' ? ' and in Design & Build' : ''}
                      {r.note ? ` - ${r.note}` : ''}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <Text size={200} className={s.muted}>
                  Each of these has a number in {sitecode}'s ranges and is on no site. Untick any that do not belong here. An auto attendant or call queue brings its resource accounts.
                </Text>
                <DataTable size="small" minWidth={560}>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>
                        <Checkbox aria-label="Select all" checked={items.length > 0 && items.every((i) => picked.has(i.id))} onChange={(_, d) => setPicked(new Set(d.checked ? items.map((i) => i.id) : []))} />
                      </TableHeaderCell>
                      <TableHeaderCell>Name</TableHeaderCell>
                      <TableHeaderCell>Type</TableHeaderCell>
                      <TableHeaderCell>Number</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((i) => (
                      <TableRow key={i.id}>
                        <TableCell>
                          <Checkbox aria-label={`Select ${i.label}`} checked={picked.has(i.id)} onChange={(_, d) => toggle(i.id, !!d.checked)} />
                        </TableCell>
                        <TableCell title={i.key}>{i.label}</TableCell>
                        <TableCell>{kindLabel(i)}</TableCell>
                        <TableCell>{i.numbers.join(', ')}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </DataTable>
                <Checkbox label="Also add to Design & Build" checked={alsoBuild} onChange={(_, d) => setAlsoBuild(!!d.checked)} />
                {elsewhere.length > 0 && (
                  <Text size={200} className={s.muted}>
                    Not listed: {elsewhere.map((e) => `${e.label} (on ${e.onSitecode ?? 'another site'})`).join(', ')}. Something already on a site is never moved from here.
                  </Text>
                )}
                {error && <LoadError message={error} />}
              </>
            )}
          </DialogContent>
          <DialogActions>
            {results ? (
              <Button appearance="primary" onClick={onClose}>
                Close
              </Button>
            ) : (
              <>
                <Button appearance="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button appearance="primary" disabled={picked.size === 0 || run.isPending} onClick={() => run.mutate()}>
                  {run.isPending ? <Spinner size="tiny" /> : `Add ${picked.size} to ${sitecode}`}
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
