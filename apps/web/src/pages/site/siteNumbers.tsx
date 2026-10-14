import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, DialogTrigger, Dropdown, Field, Option, SearchBox, Spinner, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text , makeStyles, shorthands } from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import { type Paginated } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { DataTable } from '../../components/DataTable';
import { Page } from '../../components/Page';
import { LoadError, useRecordStyles, type Choice, type Row } from '../../components/records';
import { isFlowStale } from './siteShared';

const useLocalStyles = makeStyles({
  minW180: { minWidth: '180px' },
  minW130: { minWidth: '130px' },
  styled: { fontFamily: "ui-monospace, monospace" },
  flexGap8: { display: "flex", ...shorthands.gap('8px') },
  flex1: { flex: 1 },
  gridGap4: { display: "grid", ...shorthands.gap('4px') },
});


interface PhoneNumber {
  id: string;
  e164: string;
  status: 'available' | 'reserved' | 'assigned';
  holder_type: string | null;
  holder_name: string | null;
  range_start: string | null;
  range_end: string | null;
}

export function NumberInventory({
  base,
  siteId,
  locked,
  onChanged,
}: {
  base: string;
  siteId: string;
  locked: boolean;
  onChanged: () => void;
}) {
  const ls = useLocalStyles();
  const s = useRecordStyles();
  const [statusFilter, setStatusFilter] = useState<'all' | 'available' | 'reserved' | 'assigned'>('all');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const limit = 50;

  useEffect(() => {
    const h = setTimeout(() => {
      setQ(qInput.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(h);
  }, [qInput]);

  const qs = new URLSearchParams({ siteId, page: String(page), limit: String(limit) });
  if (statusFilter !== 'all') qs.set('status', statusFilter);
  if (q) qs.set('q', q);

  const list = useQuery({
    queryKey: ['site-numbers', base, siteId, statusFilter, q, page],
    queryFn: () => api<Paginated<PhoneNumber>>(`${base}/numbers?${qs.toString()}`),
  });

  const reserve = useMutation({
    mutationFn: ({ id, reserved }: { id: string; reserved: boolean }) =>
      api(`${base}/numbers/${id}/reserve`, { method: 'PATCH', body: JSON.stringify({ reserved }) }),
    onSuccess: () => {
      list.refetch();
      onChanged();
    },
  });

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));
  const items = list.data?.items ?? [];

  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <div>
          <Text weight="semibold">
            Numbers <span className={s.muted}>({total})</span>
          </Text>
          <Text size={200} className={s.muted} block>
            Generated from this site's ranges. Assign numbers to users, CAPs or resource accounts.
          </Text>
        </div>
        <div className={s.toolbar}>
          <SearchBox
            size="small"
            placeholder="Search number…"
            value={qInput}
            onChange={(_, d) => setQInput(d.value)}
            className={ls.minW180}
          />
          <Dropdown
            size="small"
            value={statusFilter}
            selectedOptions={[statusFilter]}
            onOptionSelect={(_, d) => {
              setStatusFilter((d.optionValue as typeof statusFilter) ?? 'all');
              setPage(1);
            }}
            className={ls.minW130}
          >
            {['all', 'available', 'reserved', 'assigned'].map((o) => (
              <Option key={o} value={o}>
                {o}
              </Option>
            ))}
          </Dropdown>
        </div>
      </div>

      {list.isError && <LoadError message={(list.error as Error).message} />}
      {list.isLoading ? (
        <Spinner size="tiny" />
      ) : items.length === 0 ? (
        <Text size={200} className={s.muted}>
          {total === 0 && !q ? 'Add a number range to generate the inventory.' : 'No matches.'}
        </Text>
      ) : (
        <>
          <DataTable size="small" minWidth={640}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Number</TableHeaderCell>
                  <TableHeaderCell>Range</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Holder</TableHeaderCell>
                  {!locked && <TableHeaderCell />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((n) => (
                  <TableRow key={n.id}>
                    <TableCell className={ls.styled}>{n.e164}</TableCell>
                    <TableCell>
                      {n.range_start
                        ? n.range_end && n.range_end !== n.range_start
                          ? `${n.range_start} – ${n.range_end}`
                          : n.range_start
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge
                        appearance="tint"
                        color={
                          n.status === 'assigned'
                            ? 'success'
                            : n.status === 'reserved'
                              ? 'warning'
                              : 'informative'
                        }
                      >
                        {n.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {n.holder_name ? `${n.holder_name} (${n.holder_type})` : '—'}
                    </TableCell>
                    {!locked && (
                      <TableCell>
                        {n.status !== 'assigned' && (
                          <Button
                            size="small"
                            appearance="subtle"
                            disabled={reserve.isPending}
                            onClick={() =>
                              reserve.mutate({ id: n.id, reserved: n.status !== 'reserved' })
                            }
                          >
                            {n.status === 'reserved' ? 'Release' : 'Reserve'}
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
          </DataTable>
          {pages > 1 && (
            <div className={s.pager}>
              <Text size={200} className={s.muted}>
                Page {page} of {pages} · {total} total
              </Text>
              <Button
                size="small"
                appearance="subtle"
                disabled={page <= 1 || list.isFetching}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Prev
              </Button>
              <Button
                size="small"
                appearance="subtle"
                disabled={page >= pages || list.isFetching}
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/* --------------------- resource-account number manager --------------------- */

export function RaNumbersButton({
  ra,
  available,
  base,
  onChanged,
}: {
  ra: Row & { name: string; phone_numbers: { id: string; e164: string }[] };
  available: Choice[];
  base: string;
  onChanged: () => void;
}) {
  const ls = useLocalStyles();
  const s = useRecordStyles();
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string | null>(null);

  const attach = useMutation({
    mutationFn: () =>
      api(`${base}/resource-accounts/${ra.id}/numbers`, {
        method: 'POST',
        body: JSON.stringify({ phone_number_id: pick }),
      }),
    onSuccess: () => {
      setPick('');
      setError(null);
      onChanged();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed'),
  });
  const detach = useMutation({
    mutationFn: (numberId: string) =>
      api(`${base}/resource-accounts/${ra.id}/numbers/${numberId}`, { method: 'DELETE' }),
    onSuccess: onChanged,
  });

  return (
    <>
      <Button size="small" appearance="subtle" onClick={() => setOpen(true)}>
        Numbers ({ra.phone_numbers?.length ?? 0})
      </Button>
      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Numbers for {ra.name}</DialogTitle>
            <DialogContent>
              <div className={s.dialogForm}>
                <div className={s.chips}>
                  {(ra.phone_numbers?.length ?? 0) === 0 && (
                    <Text size={200} className={s.muted}>
                      None attached.
                    </Text>
                  )}
                  {(ra.phone_numbers ?? []).map((n) => (
                    <Badge key={n.id} appearance="outline" size="large">
                      {n.e164}
                      <Button
                        size="small"
                        appearance="transparent"
                        icon={<DeleteRegular />}
                        aria-label="Detach"
                        onClick={() => detach.mutate(n.id)}
                      />
                    </Badge>
                  ))}
                </div>
                <Field label="Attach an available number">
                  <div className={ls.flexGap8}>
                    <Dropdown
                      placeholder="Select…"
                      selectedOptions={pick ? [pick] : []}
                      value={available.find((c) => c.value === pick)?.label ?? ''}
                      onOptionSelect={(_, d) => setPick(d.optionValue ?? '')}
                      className={ls.flex1}
                    >
                      {available.map((c) => (
                        <Option key={c.value} value={c.value}>
                          {c.label}
                        </Option>
                      ))}
                    </Dropdown>
                    <Button
                      appearance="primary"
                      disabled={!pick || attach.isPending}
                      onClick={() => attach.mutate()}
                    >
                      Attach
                    </Button>
                  </div>
                </Field>
                {error && <LoadError message={error} />}
              </div>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Close</Button>
              </DialogTrigger>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

/* ------------------------ Call flows wizard import ------------------------ */

/**
 * "Import to Design & Build" - the row action on a wizard-captured Call
 * flows row. Converts the capture into a real build_auto_attendants/
 * build_call_queues row via BuildService.importFlowWizard, then shows
 * whatever it couldn't resolve (an unmatched agent name, an unlinked
 * department) so the engineer knows exactly what to fix. Once imported, the
 * row instead links straight into Design & Build for that review.
 */
export function FlowImportButton({
  flow,
  tid,
  siteId,
  onChanged,
}: {
  flow: Row & { wizard_answers?: unknown; imported_at?: string | null; updated_at?: string | null };
  tid: string;
  siteId: string;
  onChanged: () => void;
}) {
  const ls = useLocalStyles();
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const doImport = useMutation({
    mutationFn: () => api<{ warnings: string[] }>(`/t/${tid}/build/flows/${flow.id}/import`, { method: 'POST' }),
    onSuccess: (r) => {
      setError(null);
      setWarnings(r.warnings ?? []);
      onChanged();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Import failed'),
  });

  if (!flow.wizard_answers) return null;
  const stale = isFlowStale(flow);
  // The trigger swaps to "Imported →" the moment the row list refetches
  // (onChanged, called from the same onSuccess that also opens the
  // warnings dialog below) - keep the dialog itself unconditional so that
  // refetch doesn't unmount it out from under a warnings dialog that just
  // opened. Confirmed live: without this, the dialog never appeared at all.
  return (
    <>
      {flow.imported_at && !stale ? (
        <Link to={`/build/sites/${siteId}`}>
          <Button size="small" appearance="subtle">
            Imported →
          </Button>
        </Link>
      ) : (
        <Button
          size="small"
          appearance={stale ? 'primary' : 'subtle'}
          disabled={doImport.isPending}
          onClick={() => doImport.mutate()}
          title={stale ? "This row was edited since it was last synced to Design & Build" : undefined}
        >
          {doImport.isPending ? 'Syncing…' : stale ? 'Update Design & Build' : 'Import to Design & Build'}
        </Button>
      )}
      <Dialog
        open={warnings !== null || !!error}
        onOpenChange={(_, d) => {
          if (!d.open) {
            setWarnings(null);
            setError(null);
          }
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{error ? 'Sync failed' : 'Synced to Design & Build'}</DialogTitle>
            <DialogContent>
              {error && <Text block>{error}</Text>}
              {warnings && warnings.length === 0 && <Text block>Everything resolved cleanly - no follow-up needed.</Text>}
              {warnings && warnings.length > 0 && (
                <div className={ls.gridGap4}>
                  <Text block>This needs a quick check in Design & Build:</Text>
                  {warnings.map((w, i) => (
                    <Text key={i} size={200} block>
                      · {w}
                    </Text>
                  ))}
                </div>
              )}
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Close</Button>
              </DialogTrigger>
              {!error && (
                <Link to={`/build/sites/${siteId}`}>
                  <Button appearance="primary">Open in Design & Build</Button>
                </Link>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
