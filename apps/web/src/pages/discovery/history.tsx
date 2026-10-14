import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button, Card, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Dropdown, Option, SearchBox, Spinner, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text , makeStyles, shorthands, mergeClasses } from '@fluentui/react-components';
import { EyeRegular, HistoryRegular } from '@fluentui/react-icons';
import { TENANT_OBJECT_TYPES, TENANT_OBJECT_TYPE_LABELS, type Paginated, type TenantDiscoveryRun, type TenantObjectType, type TenantObjectVersion } from '@tvmf/shared';
import { api } from '../../api';
import { DataTable } from '../../components/DataTable';
import { LoadError } from '../../components/records';
import { useDebounced } from '../../hooks/useDebounced';
import { useStyles, fmt, ChangeBadge, Pager } from './discoveryShared';

const useLocalStyles = makeStyles({
  w94vwMaxW980: { maxWidth: '980px', width: "94vw" },
  mb8: { marginBottom: '8px' },
  w92vwMaxW720: { maxWidth: '720px', width: "92vw" },
  gridGap6: { display: "grid", ...shorthands.gap('6px') },
  justifySpacebetween: { justifyContent: "space-between" },
  minW240: { minWidth: '240px' },
  minW150: { minWidth: '150px' },
  minW200: { minWidth: '200px' },
});


type DiffLine = { text: string; kind: 'same' | 'added' | 'removed' };

/** Line-level (LCS) diff between two pretty-printed JSON blocks, so the actual nested JSON can be shown with just the changed lines highlighted. */
function diffLines(beforeText: string, afterText: string): DiffLine[] {
  const a = beforeText.split('\n');
  const b = afterText.split('\n');
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ text: a[i], kind: 'same' });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ text: a[i], kind: 'removed' });
      i++;
    } else {
      out.push({ text: b[j], kind: 'added' });
      j++;
    }
  }
  while (i < n) {
    out.push({ text: a[i], kind: 'removed' });
    i++;
  }
  while (j < m) {
    out.push({ text: b[j], kind: 'added' });
    j++;
  }
  return out;
}

/** Splits a before/after line diff into what each dialog column should render (Before: same + removed, After: same + added). */
function splitDiffLines(beforeText: string | null, afterText: string | null): { before: DiffLine[]; after: DiffLine[] } {
  if (beforeText === null || afterText === null) return { before: [], after: [] };
  const lines = diffLines(beforeText, afterText);
  return {
    before: lines.filter((l) => l.kind !== 'added'),
    after: lines.filter((l) => l.kind !== 'removed'),
  };
}

/** Before / after JSON for one recorded change - green for new/changed lines, red for removed ones. */
function DiffDialog({ version, onClose }: { version: TenantObjectVersion; onClose: () => void }) {
  const ls = useLocalStyles();
  const s = useStyles();
  const beforeText = version.before ? JSON.stringify(version.before, null, 2) : null;
  const afterText = version.after ? JSON.stringify(version.after, null, 2) : null;
  const { before: beforeLines, after: afterLines } = useMemo(
    () => splitDiffLines(beforeText, afterText),
    [beforeText, afterText],
  );
  const lineClass = (kind: DiffLine['kind']) =>
    kind === 'added' ? s.diffLineAdded : kind === 'removed' ? s.diffLineRemoved : s.diffLineSame;
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={ls.w94vwMaxW980}>
        <DialogBody>
          <DialogTitle>
            {version.display_name ?? version.object_key} · <ChangeBadge kind={version.change_kind} />
          </DialogTitle>
          <DialogContent>
            <Text size={200} className={mergeClasses(s.muted, ls.mb8)} block>
              {TENANT_OBJECT_TYPE_LABELS[version.object_type]} · {fmt(version.changed_at)}
              {version.changed_fields.length > 0 && (
                <> · changed: {version.changed_fields.join(', ')}</>
              )}
            </Text>
            <div className={s.diff}>
              <div className={s.diffCol}>
                <Text size={200} weight="semibold">
                  Before
                </Text>
                <div className={s.json}>
                  {beforeText === null ? (
                    <span className={s.muted}>(new — did not exist)</span>
                  ) : afterText === null ? (
                    beforeText.split('\n').map((line, i) => (
                      <div key={i} className={s.diffLineRemoved}>
                        {line || ' '}
                      </div>
                    ))
                  ) : (
                    beforeLines.map((l, i) => (
                      <div key={i} className={lineClass(l.kind)}>
                        {l.text || ' '}
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div className={s.diffCol}>
                <Text size={200} weight="semibold">
                  After
                </Text>
                <div className={s.json}>
                  {afterText === null ? (
                    <span className={s.muted}>(removed from the tenant)</span>
                  ) : beforeText === null ? (
                    afterText.split('\n').map((line, i) => (
                      <div key={i} className={s.diffLineAdded}>
                        {line || ' '}
                      </div>
                    ))
                  ) : (
                    afterLines.map((l, i) => (
                      <div key={i} className={lineClass(l.kind)}>
                        {l.text || ' '}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
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

/** "History" button + dialog: the change timeline for one discovered object. */
export function HistoryButton({ base, objectId, title }: { base: string; objectId: string; title: string }) {
  const ls = useLocalStyles();
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<TenantObjectVersion | null>(null);
  const list = useQuery({
    queryKey: ['tdisc', 'versions', base, objectId],
    enabled: open,
    queryFn: () => api<TenantObjectVersion[]>(`${base}/objects/${objectId}/versions`),
  });

  return (
    <>
      <Button
        size="small"
        appearance="subtle"
        icon={<HistoryRegular />}
        title="Change history"
        onClick={() => setOpen(true)}
      >
        History
      </Button>
      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface className={ls.w92vwMaxW720}>
          <DialogBody>
            <DialogTitle>History · {title}</DialogTitle>
            <DialogContent>
              {list.isLoading ? (
                <Spinner size="tiny" />
              ) : list.isError ? (
                <LoadError message={(list.error as Error).message} />
              ) : (list.data ?? []).length === 0 ? (
                <Text size={200} className={s.muted}>
                  No recorded changes — this item has looked the same in every sync.
                </Text>
              ) : (
                <div className={ls.gridGap6}>
                  {(list.data ?? []).map((v) => (
                    <div key={v.id} className={mergeClasses(s.row, ls.justifySpacebetween)}>
                      <div className={s.row}>
                        <ChangeBadge kind={v.change_kind} />
                        <Text size={200}>{fmt(v.changed_at)}</Text>
                        {v.changed_fields.length > 0 && (
                          <Text size={200} className={s.muted}>
                            {v.changed_fields.slice(0, 6).join(', ')}
                            {v.changed_fields.length > 6 ? '…' : ''}
                          </Text>
                        )}
                      </div>
                      <Button size="small" appearance="subtle" icon={<EyeRegular />} onClick={() => setDiff(v)}>
                        View
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)}>
                Close
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      {diff && <DiffDialog version={diff} onClose={() => setDiff(null)} />}
    </>
  );
}

/** The "what changed in this sync" log, with a run picker and type filter. */
export function ChangesTab({ base }: { base: string }) {
  const ls = useLocalStyles();
  const s = useStyles();
  const [runId, setRunId] = useState<string>('');
  const [type, setType] = useState<TenantObjectType | ''>('');
  const [qInput, setQInput] = useState('');
  const q = useDebounced(qInput);
  const [page, setPage] = useState(1);
  const [diff, setDiff] = useState<TenantObjectVersion | null>(null);
  const limit = 50;

  const runs = useQuery({
    queryKey: ['tdisc', 'runs', base],
    queryFn: () => api<TenantDiscoveryRun[]>(`${base}/runs`),
  });
  const runList = runs.data ?? [];
  // Default to the newest real sync, not a Design & Build validate check.
  const activeRun = runId || (runList.find((r) => r.kind !== 'targeted') ?? runList[0])?.id || '';
  useEffect(() => setPage(1), [activeRun, type, q]);

  const list = useQuery({
    queryKey: ['tdisc', 'changes', base, activeRun, type, q, page],
    enabled: !!activeRun,
    queryFn: () =>
      api<Paginated<TenantObjectVersion>>(
        `${base}/runs/${activeRun}/changes?page=${page}&limit=${limit}` +
          `${type ? `&type=${type}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      ),
    placeholderData: keepPreviousData,
  });
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));
  const runLabel = (r: TenantDiscoveryRun) =>
    `${fmt(r.started_at ?? r.created_at)} · ${
      r.kind === 'targeted' ? 'Validate check' : r.scope_types ? 'partial' : 'full'
    } · ${r.status}`;

  return (
    <Card className={s.card}>
      <div className={s.toolbar}>
        <Text weight="semibold">
          What changed <span className={s.muted}>({total.toLocaleString()})</span>
        </Text>
        <div className={s.row}>
          <Dropdown
            size="small"
            className={ls.minW240}
            placeholder={runs.isLoading ? 'Loading runs…' : 'Pick a run'}
            selectedOptions={activeRun ? [activeRun] : []}
            value={runList.find((r) => r.id === activeRun) ? runLabel(runList.find((r) => r.id === activeRun)!) : ''}
            onOptionSelect={(_, d) => setRunId(d.optionValue ?? '')}
          >
            {runList.map((r) => (
              <Option key={r.id} value={r.id} text={runLabel(r)}>
                {runLabel(r)}
              </Option>
            ))}
          </Dropdown>
          <Dropdown
            size="small"
            className={ls.minW150}
            placeholder="All types"
            selectedOptions={type ? [type] : []}
            value={type ? TENANT_OBJECT_TYPE_LABELS[type] : ''}
            onOptionSelect={(_, d) => setType((d.optionValue as TenantObjectType) ?? '')}
          >
            <Option value="" text="All types">
              All types
            </Option>
            {TENANT_OBJECT_TYPES.map((t) => (
              <Option key={t} value={t} text={TENANT_OBJECT_TYPE_LABELS[t]}>
                {TENANT_OBJECT_TYPE_LABELS[t]}
              </Option>
            ))}
          </Dropdown>
          <SearchBox
            size="small"
            placeholder="Search name or key…"
            value={qInput}
            onChange={(_, d) => setQInput(d.value)}
            className={ls.minW200}
          />
        </div>
      </div>

      {runList.length === 0 ? (
        <Text size={200} className={s.muted}>
          No discovery has been run yet.
        </Text>
      ) : list.isLoading ? (
        <Spinner size="tiny" />
      ) : list.isError ? (
        <LoadError message={(list.error as Error).message} />
      ) : items.length === 0 ? (
        <Text size={200} className={s.muted}>
          {q || type
            ? 'No matching changes in this run.'
            : 'Nothing changed in this run — every item matched the previous sync.'}
        </Text>
      ) : (
        <>
          <DataTable size="small" minWidth={760}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Change</TableHeaderCell>
                <TableHeaderCell>Fields</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((v) => (
                <TableRow key={v.id}>
                  <TableCell>{TENANT_OBJECT_TYPE_LABELS[v.object_type]}</TableCell>
                  <TableCell>{v.display_name ?? v.object_key}</TableCell>
                  <TableCell>
                    <ChangeBadge kind={v.change_kind} />
                  </TableCell>
                  <TableCell>
                    {v.changed_fields.length ? (
                      <span className={s.muted}>
                        {v.changed_fields.slice(0, 5).join(', ')}
                        {v.changed_fields.length > 5 ? ` +${v.changed_fields.length - 5}` : ''}
                      </span>
                    ) : (
                      <span className={s.muted}>—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button size="small" appearance="subtle" icon={<EyeRegular />} onClick={() => setDiff(v)}>
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
          <Pager page={page} pages={pages} total={total} onPage={setPage} />
        </>
      )}
      {diff && <DiffDialog version={diff} onClose={() => setDiff(null)} />}
    </Card>
  );
}
