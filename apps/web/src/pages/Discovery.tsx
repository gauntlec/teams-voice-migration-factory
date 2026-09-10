import { useEffect, useState, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Link,
  MessageBar,
  MessageBarBody,
  Option,
  ProgressBar,
  SearchBox,
  Spinner,
  Tab,
  TabList,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowSyncRegular,
  CheckmarkRegular,
  ChevronDownRegular,
  ChevronLeftRegular,
  ChevronRightRegular,
  CopyRegular,
  DeleteRegular,
  EyeRegular,
  HistoryRegular,
  PlugConnectedRegular,
} from '@fluentui/react-icons';
import {
  TENANT_DISCOVERY_STEPS,
  TENANT_DISCOVERY_STEP_LABELS,
  TENANT_DISCOVERY_STEP_TYPES,
  TENANT_OBJECT_CHANGE_KIND_LABELS,
  TENANT_OBJECT_TYPES,
  TENANT_OBJECT_TYPE_LABELS,
  TENANT_OBJECT_TYPE_STEP,
  TENANT_POLICY_TYPE_LABELS,
  TENANT_POLICY_TYPES,
  type Paginated,
  type TenantDiscoveryChangeCounts,
  type TenantDiscoveryRun,
  type TenantDiscoveryStep,
  type TenantDiscoverySummary,
  type TenantObject,
  type TenantObjectChangeKind,
  type TenantObjectType,
  type TenantObjectVersion,
  type TenantPolicySummary,
  type TenantPolicyType,
  type TenantUserSummary,
} from '@tvmf/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { JsonTree } from '../components/JsonTree';
import { Page } from '../components/Page';
import { LoadError, NoTenant } from '../components/records';

/* --------------------------------- styles --------------------------------- */

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', ...shorthands.gap('16px') },
  card: { ...shorthands.padding('16px'), display: 'grid', ...shorthands.gap('10px'), alignContent: 'start' },
  row: { display: 'flex', alignItems: 'center', ...shorthands.gap('8px'), flexWrap: 'wrap' },
  code: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: tokens.fontSizeBase500,
    letterSpacing: '.08em',
    ...shorthands.padding('6px', '12px'),
    backgroundColor: tokens.colorNeutralBackground3,
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
  },
  muted: { color: tokens.colorNeutralForeground3 },
  steps: { display: 'grid', ...shorthands.gap('4px'), marginTop: '4px' },
  step: { display: 'flex', alignItems: 'center', ...shorthands.gap('8px'), fontSize: tokens.fontSizeBase200 },
  stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', ...shorthands.gap('10px') },
  stat: { ...shorthands.padding('12px'), display: 'grid', ...shorthands.gap('2px') },
  statN: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, lineHeight: '1.1' },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', ...shorthands.gap('8px'), flexWrap: 'wrap' },
  chips: { display: 'flex', ...shorthands.gap('4px'), flexWrap: 'wrap' },
  json: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: '60vh',
    overflowY: 'auto',
    ...shorthands.margin('0'),
    ...shorthands.padding('12px'),
    backgroundColor: tokens.colorNeutralBackground3,
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
  },
  pager: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', ...shorthands.gap('8px') },
  scopePanel: {
    display: 'grid',
    ...shorthands.gap('2px'),
    ...shorthands.padding('8px', '10px'),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  scopeStep: { display: 'flex', alignItems: 'center', ...shorthands.gap('2px') },
  scopeTypes: { display: 'flex', flexWrap: 'wrap', ...shorthands.gap('2px', '14px'), paddingLeft: '28px' },
  diff: { display: 'grid', gridTemplateColumns: '1fr 1fr', ...shorthands.gap('10px') },
  diffCol: { display: 'grid', ...shorthands.gap('4px'), minWidth: 0 },
});

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

const ZERO_CHANGES: TenantDiscoveryChangeCounts = { added: 0, updated: 0, removed: 0, readded: 0 };
const changeCountsOf = (run: TenantDiscoveryRun | null | undefined): TenantDiscoveryChangeCounts => {
  const c = run?.progress?.changed ?? (run?.summary?.changed as TenantDiscoveryChangeCounts | undefined);
  return c ? { ...ZERO_CHANGES, ...c } : ZERO_CHANGES;
};
const totalChanges = (c: TenantDiscoveryChangeCounts) => c.added + c.updated + c.removed + c.readded;

const CHANGE_KIND_COLOR: Record<TenantObjectChangeKind, 'success' | 'warning' | 'danger' | 'brand'> = {
  added: 'success',
  updated: 'warning',
  removed: 'danger',
  readded: 'brand',
};

function ChangeBadge({ kind }: { kind: TenantObjectChangeKind }) {
  return (
    <Badge appearance="tint" color={CHANGE_KIND_COLOR[kind]} size="small">
      {TENANT_OBJECT_CHANGE_KIND_LABELS[kind]}
    </Badge>
  );
}

/** Before / after JSON for one recorded change. */
function DiffDialog({ version, onClose }: { version: TenantObjectVersion; onClose: () => void }) {
  const s = useStyles();
  const before = version.before ? JSON.stringify(version.before, null, 2) : null;
  const after = version.after ? JSON.stringify(version.after, null, 2) : null;
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: 980, width: '94vw' }}>
        <DialogBody>
          <DialogTitle>
            {version.display_name ?? version.object_key} · <ChangeBadge kind={version.change_kind} />
          </DialogTitle>
          <DialogContent>
            <Text size={200} className={s.muted} block style={{ marginBottom: 8 }}>
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
                <pre className={s.json}>{before ?? '(new — did not exist)'}</pre>
              </div>
              <div className={s.diffCol}>
                <Text size={200} weight="semibold">
                  After
                </Text>
                <pre className={s.json}>{after ?? '(removed from the tenant)'}</pre>
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
function HistoryButton({ base, objectId, title }: { base: string; objectId: string; title: string }) {
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
        <DialogSurface style={{ maxWidth: 720, width: '92vw' }}>
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
                <div style={{ display: 'grid', gap: 6 }}>
                  {(list.data ?? []).map((v) => (
                    <div key={v.id} className={s.row} style={{ justifyContent: 'space-between' }}>
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

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="small"
      appearance="subtle"
      icon={done ? <CheckmarkRegular /> : <CopyRegular />}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

/* --------------------------- connect + run cards --------------------------- */

interface Connection {
  id: string;
  status: 'pending' | 'active' | 'expired' | 'closed';
  user_code: string | null;
  verification_uri: string | null;
  upn: string | null;
  expires_at: string | null;
  started_at: string;
}

/** Steps that carry more than one object type - only these get an expander. */
const MULTI_TYPE_STEPS = TENANT_DISCOVERY_STEPS.filter(
  (st) => TENANT_DISCOVERY_STEP_TYPES[st].length > 1,
);

/**
 * Checkbox tree for a partial sync: tick a whole step, or expand it and tick
 * individual object types. The selection is a flat set of object types.
 */
function ScopePicker({
  selected,
  onChange,
  includeDisabled,
  includeUnlicensed,
  onIncludeDisabled,
  onIncludeUnlicensed,
  onRun,
  disabled,
}: {
  selected: Set<TenantObjectType>;
  onChange: (next: Set<TenantObjectType>) => void;
  includeDisabled: boolean;
  includeUnlicensed: boolean;
  onIncludeDisabled: (v: boolean) => void;
  onIncludeUnlicensed: (v: boolean) => void;
  onRun: () => void;
  disabled: boolean;
}) {
  const s = useStyles();
  const [expanded, setExpanded] = useState<Set<TenantDiscoveryStep>>(new Set());

  const setTypes = (types: readonly TenantObjectType[], on: boolean) => {
    const next = new Set(selected);
    for (const t of types) {
      if (on) next.add(t);
      else next.delete(t);
    }
    onChange(next);
  };
  const stepState = (st: TenantDiscoveryStep): 'all' | 'some' | 'none' => {
    const types = TENANT_DISCOVERY_STEP_TYPES[st];
    const n = types.filter((t) => selected.has(t)).length;
    return n === 0 ? 'none' : n === types.length ? 'all' : 'some';
  };

  return (
    <div className={s.scopePanel}>
      {TENANT_DISCOVERY_STEPS.map((st) => {
        const state = stepState(st);
        const canExpand = MULTI_TYPE_STEPS.includes(st);
        const isOpen = expanded.has(st);
        return (
          <div key={st}>
            <div className={s.scopeStep}>
              {canExpand ? (
                <Button
                  size="small"
                  appearance="transparent"
                  icon={isOpen ? <ChevronDownRegular /> : <ChevronRightRegular />}
                  onClick={() =>
                    setExpanded((prev) => {
                      const n = new Set(prev);
                      if (n.has(st)) n.delete(st);
                      else n.add(st);
                      return n;
                    })
                  }
                  aria-label={isOpen ? 'Collapse' : 'Expand'}
                />
              ) : (
                <span style={{ width: 24, display: 'inline-block' }} />
              )}
              <Checkbox
                label={TENANT_DISCOVERY_STEP_LABELS[st]}
                checked={state === 'all' ? true : state === 'some' ? 'mixed' : false}
                onChange={(_, d) => setTypes(TENANT_DISCOVERY_STEP_TYPES[st], !!d.checked)}
              />
            </div>
            {canExpand && isOpen && (
              <div className={s.scopeTypes}>
                {TENANT_DISCOVERY_STEP_TYPES[st].map((t) => (
                  <Checkbox
                    key={t}
                    label={TENANT_OBJECT_TYPE_LABELS[t]}
                    checked={selected.has(t)}
                    onChange={(_, d) => setTypes([t], !!d.checked)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {selected.has('user') && (
        <div className={s.scopeTypes} style={{ paddingLeft: 28, marginTop: 4 }}>
          <Checkbox
            label="Include disabled accounts"
            checked={includeDisabled}
            onChange={(_, d) => onIncludeDisabled(!!d.checked)}
          />
          <Checkbox
            label="Include accounts not licensed for Teams (and guests)"
            checked={includeUnlicensed}
            onChange={(_, d) => onIncludeUnlicensed(!!d.checked)}
          />
        </div>
      )}
      <Text size={200} className={s.muted}>
        Users are limited to enabled accounts licensed for Teams, plus resource accounts — the
        Teams-voice migration candidates. Tick the boxes above to widen it. If the tenant returns no
        licence data the filter is skipped automatically and every enabled user is stored.
      </Text>
      <div className={s.row} style={{ marginTop: 6 }}>
        <Button appearance="primary" icon={<ArrowSyncRegular />} disabled={disabled} onClick={onRun}>
          Sync selected{selected.size ? ` (${selected.size})` : ''}
        </Button>
        <Button size="small" appearance="subtle" onClick={() => onChange(new Set())} disabled={selected.size === 0}>
          Clear
        </Button>
      </div>
    </div>
  );
}

function ConnectCard({
  base,
  summary,
  canRun,
  onChanged,
}: {
  base: string;
  summary: TenantDiscoverySummary | undefined;
  canRun: boolean;
  onChanged: () => void;
}) {
  const s = useStyles();
  const [connId, setConnId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeSel, setScopeSel] = useState<Set<TenantObjectType>>(new Set());
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [includeUnlicensed, setIncludeUnlicensed] = useState(false);

  // Adopt the active connection from the summary when we didn't start one here.
  useEffect(() => {
    if (!connId && summary?.activeConnection?.id) setConnId(summary.activeConnection.id);
  }, [summary?.activeConnection?.id, connId]);

  const conn = useQuery({
    queryKey: ['tdisc', 'conn', base, connId],
    enabled: !!connId,
    queryFn: () => api<Connection>(`${base}/connections/${connId}`),
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 3000 : false),
  });

  const start = useMutation({
    mutationFn: () => api<Connection>(`${base}/connections`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (c) => {
      setErr(null);
      setConnId(c.id);
      onChanged();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not start the connection'),
  });

  const c = conn.data;
  const run = useMutation({
    mutationFn: (scopeTypes?: TenantObjectType[]) =>
      api<TenantDiscoveryRun>(`${base}/runs`, {
        method: 'POST',
        body: JSON.stringify({
          connectionId: c!.id,
          ...(scopeTypes && scopeTypes.length ? { scopeTypes } : {}),
          ...(includeDisabled ? { includeDisabled: true } : {}),
          ...(includeUnlicensed ? { includeUnlicensed: true } : {}),
        }),
      }),
    onSuccess: () => {
      setErr(null);
      setScopeOpen(false);
      onChanged();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not start discovery'),
  });

  const running = summary?.lastRun && ['queued', 'running'].includes(summary.lastRun.status);
  const runDisabled = !canRun || run.isPending || !!running;

  return (
    <Card className={s.card}>
      <Text weight="semibold">Customer tenant connection</Text>
      <Text size={200} className={s.muted}>
        Sign in with a <b>Teams Administrator</b> account for this customer. The sign-in is live and
        point-in-time: nothing is stored, and the session ends when it expires.
      </Text>

      {!c || c.status === 'expired' || c.status === 'closed' ? (
        <div className={s.row}>
          <Button
            appearance="primary"
            icon={<PlugConnectedRegular />}
            disabled={!canRun || start.isPending}
            onClick={() => start.mutate()}
          >
            Connect to customer tenant
          </Button>
          {c && (
            <Text size={200} className={s.muted}>
              Previous session {c.status}
              {c.upn ? ` (${c.upn})` : ''}.
            </Text>
          )}
        </div>
      ) : c.status === 'pending' ? (
        <div style={{ display: 'grid', gap: 8 }}>
          {c.user_code ? (
            <>
              <Text size={200}>
                Open{' '}
                <Link href={c.verification_uri ?? 'https://microsoft.com/devicelogin'} target="_blank" rel="noreferrer">
                  {c.verification_uri ?? 'https://microsoft.com/devicelogin'}
                </Link>{' '}
                and enter this code:
              </Text>
              <div className={s.row}>
                <span className={s.code}>{c.user_code}</span>
                <CopyButton text={c.user_code} label="Copy code" />
                <Spinner size="tiny" label="Waiting for sign-in…" />
              </div>
              {c.expires_at && (
                <Text size={200} className={s.muted}>
                  Code expires {fmt(c.expires_at)}
                </Text>
              )}
            </>
          ) : (
            <Spinner size="tiny" label="Requesting a device code…" />
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          <div className={s.row}>
            <Badge appearance="tint" color="success">
              Connected
            </Badge>
            <Text size={200}>
              as <b>{c.upn ?? 'unknown'}</b>
              {c.expires_at ? ` · session until ${fmt(c.expires_at)}` : ''}
            </Text>
          </div>
          <div className={s.row}>
            <Button
              appearance="primary"
              icon={<ArrowSyncRegular />}
              disabled={runDisabled}
              onClick={() => run.mutate(undefined)}
            >
              {running ? 'Discovery running…' : 'Run full discovery'}
            </Button>
            <Button
              size="small"
              appearance="subtle"
              icon={<ChevronDownRegular />}
              iconPosition="after"
              disabled={runDisabled}
              onClick={() => setScopeOpen((v) => !v)}
            >
              Sync part of the tenant
            </Button>
            <Button size="small" appearance="subtle" onClick={() => start.mutate()} disabled={!canRun}>
              Sign in again
            </Button>
          </div>
          {scopeOpen && (
            <ScopePicker
              selected={scopeSel}
              onChange={setScopeSel}
              includeDisabled={includeDisabled}
              includeUnlicensed={includeUnlicensed}
              onIncludeDisabled={setIncludeDisabled}
              onIncludeUnlicensed={setIncludeUnlicensed}
              onRun={() => run.mutate([...scopeSel])}
              disabled={runDisabled || scopeSel.size === 0}
            />
          )}
        </div>
      )}
      {err && <LoadError message={err} />}
    </Card>
  );
}

function RunCard({ base, summary }: { base: string; summary: TenantDiscoverySummary | undefined }) {
  const s = useStyles();
  const qc = useQueryClient();
  const filterUsers = summary?.settings?.filterUsers ?? true;
  const notifyOnComplete = summary?.settings?.notifyOnComplete ?? true;
  const patchSettings = useMutation({
    mutationFn: (body: { filterUsers?: boolean; notifyOnComplete?: boolean }) =>
      api(`${base}/settings`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tdisc', 'summary', base] }),
  });
  const last = summary?.lastRun ?? null;
  const live = useQuery({
    queryKey: ['tdisc', 'run', base, last?.id],
    enabled: !!last && ['queued', 'running'].includes(last.status),
    queryFn: () => api<TenantDiscoveryRun>(`${base}/runs/${last!.id}`),
    refetchInterval: (q) =>
      q.state.data && ['queued', 'running'].includes(q.state.data.status) ? 3000 : false,
  });
  const run = live.data ?? last;
  const done = new Set(run?.progress?.completed ?? []);
  // for a partial run only the in-scope steps count towards progress
  const scopeSteps = run?.scope_types
    ? TENANT_DISCOVERY_STEPS.filter((st) =>
        TENANT_DISCOVERY_STEP_TYPES[st].some((t) => run.scope_types!.includes(t)),
      )
    : TENANT_DISCOVERY_STEPS;
  const pct = run ? (run.status === 'completed' ? 1 : done.size / Math.max(1, scopeSteps.length)) : 0;
  const total = Object.values(run?.progress?.counts ?? {}).reduce((a, b) => a + (b ?? 0), 0);
  const changed = changeCountsOf(run);
  const skippedNotLicensed =
    run?.progress?.skipped?.notLicensed ??
    (run?.summary?.skipped as { notLicensed?: number } | undefined)?.notLicensed ??
    0;
  const filterDisabledReason =
    run?.progress?.filterDisabledReason ??
    (run?.summary?.filterDisabledReason as string | null | undefined) ??
    null;
  const running = !!run && ['queued', 'running'].includes(run.status);
  const elapsed =
    running && run?.started_at
      ? Math.max(0, Math.round((Date.now() - new Date(run.started_at).getTime()) / 1000))
      : null;
  const elapsedText =
    elapsed == null ? '' : elapsed < 90 ? `${elapsed}s` : `${Math.round(elapsed / 60)}m`;

  return (
    <Card className={s.card}>
      <Text weight="semibold">Latest discovery run</Text>
      {!run ? (
        <Text size={200} className={s.muted}>
          No discovery has been run for this customer yet.
        </Text>
      ) : (
        <>
          <div className={s.row}>
            <Badge
              appearance="tint"
              color={
                run.status === 'completed'
                  ? 'success'
                  : run.status === 'failed'
                    ? 'danger'
                    : 'informative'
              }
            >
              {run.status}
            </Badge>
            <Text size={200} className={s.muted}>
              started {fmt(run.started_at ?? run.created_at)}
              {run.finished_at ? ` · finished ${fmt(run.finished_at)}` : elapsedText ? ` · ${elapsedText} elapsed` : ''}
              {total ? ` · ${total.toLocaleString()} objects` : ''}
            </Text>
          </div>
          {running && run.progress?.note && (
            <div className={s.row}>
              <Spinner size="extra-tiny" />
              <Text size={200}>{run.progress.note}</Text>
            </div>
          )}
          {run.scope_types && (
            <div className={s.chips}>
              <Badge appearance="outline" color="informative" size="small">
                Partial sync
              </Badge>
              {scopeSteps.map((st) => (
                <Badge key={st} appearance="tint" size="small">
                  {TENANT_DISCOVERY_STEP_LABELS[st]}
                </Badge>
              ))}
            </div>
          )}
          {totalChanges(changed) > 0 && (
            <div className={s.chips}>
              {changed.added > 0 && (
                <Badge appearance="tint" color="success" size="small">
                  +{changed.added} added
                </Badge>
              )}
              {changed.updated > 0 && (
                <Badge appearance="tint" color="warning" size="small">
                  {changed.updated} changed
                </Badge>
              )}
              {changed.removed > 0 && (
                <Badge appearance="tint" color="danger" size="small">
                  {changed.removed} removed
                </Badge>
              )}
              {changed.readded > 0 && (
                <Badge appearance="tint" color="brand" size="small">
                  {changed.readded} re-added
                </Badge>
              )}
            </div>
          )}
          {filterDisabledReason && (
            <Text size={200} style={{ color: tokens.colorPaletteYellowForeground1 }}>
              {filterDisabledReason}
            </Text>
          )}
          {skippedNotLicensed > 0 && (
            <div className={s.chips}>
              <Badge appearance="tint" color="informative" size="small">
                {skippedNotLicensed.toLocaleString()} users skipped — not licensed for Teams
              </Badge>
            </div>
          )}
          <ProgressBar value={pct} thickness="large" />
          <div className={s.steps}>
            {scopeSteps.map((st) => {
              const isCur = run.progress?.step === st && run.status === 'running';
              const isDone = done.has(st);
              const errs = (run.progress?.errors ?? []).filter((e) => e.step === st);
              const stepCount = TENANT_DISCOVERY_STEP_TYPES[st].reduce(
                (a, t) => a + (run.progress?.counts?.[t] ?? 0),
                0,
              );
              return (
                <div key={st} className={s.step}>
                  {isDone ? (
                    <CheckmarkRegular style={{ color: tokens.colorPaletteGreenForeground2 }} />
                  ) : isCur ? (
                    <Spinner size="extra-tiny" />
                  ) : (
                    <span style={{ width: 16, display: 'inline-block' }} />
                  )}
                  <span style={{ color: isDone || isCur ? undefined : tokens.colorNeutralForeground3 }}>
                    {TENANT_DISCOVERY_STEP_LABELS[st]}
                  </span>
                  {(isDone || isCur) && stepCount > 0 && (
                    <Text size={200} className={s.muted}>
                      · {stepCount.toLocaleString()}
                    </Text>
                  )}
                  {errs.length > 0 && (
                    <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }} title={errs.map((e) => e.message).join('\n')}>
                      · {errs.length} error{errs.length === 1 ? '' : 's'}
                    </Text>
                  )}
                </div>
              );
            })}
          </div>
          {run.error && <LoadError message={run.error} />}
        </>
      )}
      <div className={s.row} style={{ marginTop: 8 }}>
        <Checkbox
          label="Filter users to Teams-licensed accounts (recommended for large tenants)"
          checked={filterUsers}
          disabled={patchSettings.isPending}
          onChange={(_, d) => patchSettings.mutate({ filterUsers: !!d.checked })}
        />
      </div>
      <Text size={200} className={s.muted}>
        {filterUsers
          ? 'Runs store only enabled users licensed for Teams. Turn this off for a small customer to store every enabled user.'
          : 'Runs store every enabled user for this customer. A run can still be narrowed with “Sync part of the tenant”.'}
      </Text>
      <div className={s.row} style={{ marginTop: 8 }}>
        <Checkbox
          label="Email the person who started a run when it finishes"
          checked={notifyOnComplete}
          disabled={patchSettings.isPending}
          onChange={(_, d) => patchSettings.mutate({ notifyOnComplete: !!d.checked })}
        />
      </div>
      <Text size={200} className={s.muted}>
        {notifyOnComplete
          ? 'When a discovery run completes or fails, its starter gets an email with the change counts and a link back here.'
          : 'No completion emails are sent for this customer.'}
      </Text>
    </Card>
  );
}

/** Danger zone: wipe the whole discovered inventory for this customer. */
function PurgeCard({
  base,
  summary,
  canRun,
  onPurged,
}: {
  base: string;
  summary: TenantDiscoverySummary | undefined;
  canRun: boolean;
  onPurged: () => void;
}) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const total = Object.values(summary?.counts ?? {}).reduce((a, b) => a + (b ?? 0), 0);
  const hasData = total > 0 || !!summary?.lastRun;
  const running = !!summary?.lastRun && ['queued', 'running'].includes(summary.lastRun.status);

  const purge = useMutation({
    mutationFn: () =>
      api<{
        objects: number;
        users: number;
        policies: number;
        runs: number;
        dataCollectionLinksCleared: number;
      }>(base, { method: 'DELETE' }),
    onSuccess: () => {
      setOpen(false);
      setErr(null);
      onPurged();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not delete the discovered data'),
  });

  if (!canRun) return null;

  return (
    <Card className={s.card}>
      <Text weight="semibold">Delete discovered data</Text>
      <Text size={200} className={s.muted}>
        Removes every discovered object, the Users and Policies projections and the run history for
        this customer. Data Collection entries are kept, but lose their link to a discovered user.
        Re-run discovery to rebuild. This cannot be undone.
      </Text>
      <div className={s.row}>
        <Button
          appearance="secondary"
          icon={<DeleteRegular />}
          style={{ color: '#b10e1c' }}
          disabled={!hasData}
          onClick={() => {
            setErr(null);
            setOpen(true);
          }}
        >
          Delete discovered data
        </Button>
        {!hasData && (
          <Text size={200} className={s.muted}>
            Nothing discovered yet.
          </Text>
        )}
      </div>

      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete all discovered data?</DialogTitle>
            <DialogContent>
              This permanently deletes the discovery inventory for{' '}
              <b>{summary?.tenant?.displayName ?? 'this customer'}</b>: {total.toLocaleString()} object
              {total === 1 ? '' : 's'}, the Users and Policies projections
              {summary?.lastRun ? ' and the run history' : ''}. Any Data Collection users stay, but
              lose their link to a discovered identity. This cannot be undone.
              {running && (
                <Text style={{ color: '#b10e1c', display: 'block', marginTop: 8 }}>
                  A discovery is running — wait for it to finish first.
                </Text>
              )}
              {err && (
                <Text style={{ color: '#b10e1c', display: 'block', marginTop: 8 }}>{err}</Text>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                style={{ backgroundColor: '#b10e1c' }}
                disabled={purge.isPending || running}
                onClick={() => purge.mutate()}
              >
                {purge.isPending ? 'Deleting…' : 'Delete everything'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </Card>
  );
}

/* ------------------------------- inventory ------------------------------- */

function Pager({
  page,
  pages,
  total,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const s = useStyles();
  if (pages <= 1) return null;
  return (
    <div className={s.pager}>
      <Text size={200} className={s.muted}>
        Page {page} of {pages} · {total.toLocaleString()} total
      </Text>
      <Button size="small" appearance="subtle" icon={<ChevronLeftRegular />} disabled={page <= 1} onClick={() => onPage(page - 1)} />
      <Button size="small" appearance="subtle" icon={<ChevronRightRegular />} disabled={page >= pages} onClick={() => onPage(page + 1)} />
    </div>
  );
}

function JsonDialog({ title, data, onClose }: { title: string; data: unknown; onClose: () => void }) {
  const s = useStyles();
  const [view, setView] = useState<'formatted' | 'raw'>('formatted');
  const text = JSON.stringify(data, null, 2);
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: 820, width: '94vw' }}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            <TabList
              size="small"
              selectedValue={view}
              onTabSelect={(_, d) => setView(d.value as 'formatted' | 'raw')}
              style={{ marginBottom: 8 }}
            >
              <Tab value="formatted">Formatted</Tab>
              <Tab value="raw">Raw JSON</Tab>
            </TabList>
            {view === 'formatted' ? <JsonTree data={data} /> : <pre className={s.json}>{text}</pre>}
          </DialogContent>
          <DialogActions>
            <CopyButton text={text} label="Copy JSON" />
            <Button appearance="secondary" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function useDebounced(value: string, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value.trim()), ms);
    return () => clearTimeout(h);
  }, [value, ms]);
  return v;
}

/** Generic snapshot list for one object type. */
function ObjectsTable({
  base,
  type,
  title,
  columns,
}: {
  base: string;
  type: TenantObjectType;
  title?: string;
  columns?: { label: string; render: (o: TenantObject) => ReactNode }[];
}) {
  const s = useStyles();
  const [qInput, setQInput] = useState('');
  const q = useDebounced(qInput);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<TenantObject | null>(null);
  const limit = 50;
  useEffect(() => setPage(1), [q]);

  const list = useQuery({
    queryKey: ['tdisc', 'objects', base, type, q, page],
    queryFn: () =>
      api<Paginated<TenantObject>>(
        `${base}/objects?type=${type}&page=${page}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      ),
    placeholderData: keepPreviousData,
  });
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));
  const cols = columns ?? [
    { label: 'Name', render: (o: TenantObject) => o.display_name ?? o.object_key },
    { label: 'Identity', render: (o: TenantObject) => o.object_key },
  ];

  return (
    <Card className={s.card}>
      <div className={s.toolbar}>
        <Text weight="semibold">
          {title ?? TENANT_OBJECT_TYPE_LABELS[type]} <span className={s.muted}>({total.toLocaleString()})</span>
        </Text>
        <SearchBox size="small" placeholder="Search…" value={qInput} onChange={(_, d) => setQInput(d.value)} style={{ minWidth: 220 }} />
      </div>
      {list.isLoading ? (
        <Spinner size="tiny" />
      ) : list.isError ? (
        <LoadError message={(list.error as Error).message} />
      ) : items.length === 0 ? (
        <Text size={200} className={s.muted}>
          {q ? 'No matches.' : 'Nothing discovered yet.'}
        </Text>
      ) : (
        <>
          <DataTable size="small" minWidth={Math.max(560, (cols.length + 2) * 150)}>
            <TableHeader>
              <TableRow>
                {cols.map((c) => (
                  <TableHeaderCell key={c.label}>{c.label}</TableHeaderCell>
                ))}
                <TableHeaderCell>Last seen</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((o) => (
                <TableRow key={o.id}>
                  {cols.map((c) => (
                    <TableCell key={c.label}>{c.render(o)}</TableCell>
                  ))}
                  <TableCell>{fmt(o.discovered_at)}</TableCell>
                  <TableCell>
                    <div className={s.row}>
                      <Button size="small" appearance="subtle" icon={<EyeRegular />} onClick={() => setView(o)}>
                        View
                      </Button>
                      <HistoryButton base={base} objectId={o.id} title={o.display_name ?? o.object_key} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
          <Pager page={page} pages={pages} total={total} onPage={setPage} />
        </>
      )}
      {view && <JsonDialog title={view.display_name ?? view.object_key} data={view.data} onClose={() => setView(null)} />}
    </Card>
  );
}

function PoliciesTable({ base }: { base: string }) {
  const s = useStyles();
  const [type, setType] = useState<TenantPolicyType | ''>('');
  const [qInput, setQInput] = useState('');
  const q = useDebounced(qInput);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<TenantPolicySummary | null>(null);
  const limit = 50;
  useEffect(() => setPage(1), [q, type]);

  const list = useQuery({
    queryKey: ['tdisc', 'policies', base, type, q, page],
    queryFn: () =>
      api<Paginated<TenantPolicySummary>>(
        `${base}/policies?page=${page}&limit=${limit}${type ? `&policyType=${type}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      ),
    placeholderData: keepPreviousData,
  });
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <Card className={s.card}>
      <div className={s.toolbar}>
        <Text weight="semibold">
          Policies <span className={s.muted}>({total.toLocaleString()})</span>
        </Text>
        <div className={s.row}>
          <Dropdown
            size="small"
            placeholder="All policy types"
            selectedOptions={type ? [type] : []}
            value={type ? TENANT_POLICY_TYPE_LABELS[type] : ''}
            onOptionSelect={(_, d) => setType((d.optionValue ?? '') as TenantPolicyType | '')}
            style={{ minWidth: 220 }}
          >
            <Option value="" text="All policy types">
              All policy types
            </Option>
            {TENANT_POLICY_TYPES.map((p) => (
              <Option key={p} value={p} text={TENANT_POLICY_TYPE_LABELS[p]}>
                {TENANT_POLICY_TYPE_LABELS[p]}
              </Option>
            ))}
          </Dropdown>
          <SearchBox size="small" placeholder="Search…" value={qInput} onChange={(_, d) => setQInput(d.value)} style={{ minWidth: 200 }} />
        </div>
      </div>
      {list.isLoading ? (
        <Spinner size="tiny" />
      ) : list.isError ? (
        <LoadError message={(list.error as Error).message} />
      ) : items.length === 0 ? (
        <Text size={200} className={s.muted}>
          {q || type ? 'No matches.' : 'Nothing discovered yet.'}
        </Text>
      ) : (
        <>
          <DataTable size="small" minWidth={720}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Scope</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{TENANT_POLICY_TYPE_LABELS[p.policy_type] ?? p.policy_type}</TableCell>
                  <TableCell>{p.name}</TableCell>
                  <TableCell>
                    {p.is_global ? (
                      <Badge appearance="tint" color="brand" size="small">
                        Global
                      </Badge>
                    ) : (
                      <Badge appearance="outline" size="small">
                        Per-user
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className={s.row}>
                      <Button size="small" appearance="subtle" icon={<EyeRegular />} onClick={() => setView(p)}>
                        View
                      </Button>
                      <HistoryButton
                        base={base}
                        objectId={p.object_id}
                        title={`${TENANT_POLICY_TYPE_LABELS[p.policy_type] ?? p.policy_type}: ${p.name}`}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
          <Pager page={page} pages={pages} total={total} onPage={setPage} />
        </>
      )}
      {view && (
        <JsonDialog
          title={`${TENANT_POLICY_TYPE_LABELS[view.policy_type] ?? view.policy_type}: ${view.name}`}
          data={view.data}
          onClose={() => setView(null)}
        />
      )}
    </Card>
  );
}

const ACCOUNT_TYPES = ['User', 'ResourceAccount', 'Guest', 'IneligibleUser', 'SfBOnPremUser'] as const;

function UsersTable({ base, canImport, onImported }: { base: string; canImport: boolean; onImported: () => void }) {
  const s = useStyles();
  const [qInput, setQInput] = useState('');
  const q = useDebounced(qInput);
  const [page, setPage] = useState(1);
  const [evOnly, setEvOnly] = useState(false);
  const [acctType, setAcctType] = useState('');
  const [view, setView] = useState<TenantUserSummary | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const limit = 50;
  useEffect(() => setPage(1), [q, evOnly, acctType]);

  const list = useQuery({
    queryKey: ['tdisc', 'users', base, q, page, evOnly, acctType],
    queryFn: () =>
      api<Paginated<TenantUserSummary>>(
        `${base}/users?page=${page}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ''}${evOnly ? '&ev=true' : ''}${acctType ? `&accountType=${acctType}` : ''}`,
      ),
    placeholderData: keepPreviousData,
  });
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <Card className={s.card}>
      <div className={s.toolbar}>
        <Text weight="semibold">
          Users <span className={s.muted}>({total.toLocaleString()})</span>
        </Text>
        <div className={s.row}>
          <Dropdown
            size="small"
            placeholder="All account types"
            selectedOptions={acctType ? [acctType] : []}
            value={acctType}
            onOptionSelect={(_, d) => setAcctType(d.optionValue ?? '')}
            style={{ minWidth: 170 }}
          >
            <Option value="" text="All account types">
              All account types
            </Option>
            {ACCOUNT_TYPES.map((t) => (
              <Option key={t} value={t} text={t}>
                {t}
              </Option>
            ))}
          </Dropdown>
          <Checkbox size="medium" label="Voice-enabled only" checked={evOnly} onChange={(_, d) => setEvOnly(!!d.checked)} />
          <SearchBox size="small" placeholder="Search UPN, name, number, department…" value={qInput} onChange={(_, d) => setQInput(d.value)} style={{ minWidth: 260 }} />
          {canImport && (
            <Button size="small" appearance="primary" onClick={() => setImportOpen(true)}>
              Import into Data Collection…
            </Button>
          )}
        </div>
      </div>
      {list.isLoading ? (
        <Spinner size="tiny" />
      ) : list.isError ? (
        <LoadError message={(list.error as Error).message} />
      ) : items.length === 0 ? (
        <Text size={200} className={s.muted}>
          {q ? 'No matches.' : 'Nothing discovered yet.'}
        </Text>
      ) : (
        <>
          <DataTable size="small" minWidth={1100}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>UPN</TableHeaderCell>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Voice</TableHeaderCell>
                <TableHeaderCell>Number</TableHeaderCell>
                <TableHeaderCell>Features</TableHeaderCell>
                <TableHeaderCell>Calling policy</TableHeaderCell>
                <TableHeaderCell>Department</TableHeaderCell>
                <TableHeaderCell>Data Collection</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((u) => (
                <TableRow key={u.id}>
                  <TableCell title={u.upn}>{u.upn}</TableCell>
                  <TableCell title={u.display_name ?? ''}>{u.display_name ?? '—'}</TableCell>
                  <TableCell>{u.account_type ?? '—'}</TableCell>
                  <TableCell>
                    {u.enterprise_voice_enabled ? (
                      <Badge appearance="tint" color="success" size="small">
                        EV
                      </Badge>
                    ) : (
                      <span className={s.muted}>—</span>
                    )}
                  </TableCell>
                  <TableCell>{u.line_uri ? u.line_uri.replace(/^tel:/, '') : '—'}</TableCell>
                  <TableCell>
                    <div className={s.chips}>
                      {(u.feature_types ?? []).slice(0, 4).map((f) => (
                        <Badge key={f} appearance="outline" size="small">
                          {f}
                        </Badge>
                      ))}
                      {(u.feature_types ?? []).length > 4 && (
                        <span className={s.muted}>+{u.feature_types.length - 4}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{u.policies?.TeamsCallingPolicy ?? '—'}</TableCell>
                  <TableCell>{u.department ?? '—'}</TableCell>
                  <TableCell>
                    {u.discovery_user_id ? (
                      <Badge appearance="tint" color="success" size="small">
                        Linked
                      </Badge>
                    ) : (
                      <span className={s.muted}>—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className={s.row}>
                      <Button size="small" appearance="subtle" icon={<EyeRegular />} onClick={() => setView(u)}>
                        View
                      </Button>
                      <HistoryButton base={base} objectId={u.object_id} title={u.display_name ?? u.upn} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
          <Pager page={page} pages={pages} total={total} onPage={setPage} />
        </>
      )}
      {view && <JsonDialog title={view.display_name ?? view.upn} data={view} onClose={() => setView(null)} />}
      {importOpen && (
        <ImportDialog
          base={base}
          onClose={() => setImportOpen(false)}
          onDone={() => {
            setImportOpen(false);
            onImported();
          }}
        />
      )}
    </Card>
  );
}

function ImportDialog({ base, onClose, onDone }: { base: string; onClose: () => void; onDone: () => void }) {
  const { activeTenantId } = useAuth();
  const [siteId, setSiteId] = useState('');
  const [evOnly, setEvOnly] = useState(true);
  const [result, setResult] = useState<{ created: number; linked: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const sites = useQuery({
    queryKey: ['tdisc', 'sites', activeTenantId],
    queryFn: () =>
      api<{ sites: { id: string; sitecode: string; name: string | null }[] }>(`/t/${activeTenantId}/discovery`),
  });
  const preview = useQuery({
    queryKey: ['tdisc', 'import-preview', base, evOnly],
    queryFn: () => api<{ wouldCreate: number }>(`${base}/import-users/preview?onlyEnterpriseVoice=${evOnly}`),
  });
  const run = useMutation({
    mutationFn: () =>
      api<{ created: number; linked: number }>(`${base}/import-users`, {
        method: 'POST',
        body: JSON.stringify({ siteId, onlyEnterpriseVoice: evOnly }),
      }),
    onSuccess: (r) => setResult(r),
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Import failed'),
  });

  const siteList = sites.data?.sites ?? [];
  const selected = siteList.find((x) => x.id === siteId);

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Import discovered users into Data Collection</DialogTitle>
          <DialogContent>
            {result ? (
              <MessageBar intent="success">
                <MessageBarBody>
                  Created <b>{result.created}</b> Data Collection user{result.created === 1 ? '' : 's'}
                  {result.linked ? ` and linked ${result.linked} existing` : ''}. Users already captured were skipped.
                </MessageBarBody>
              </MessageBar>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                <Text size={200}>
                  Creates a Data Collection user for every discovered tenant user that is not captured yet
                  (matched on UPN). Existing users are never overwritten; unlinked matches are linked.
                </Text>
                <Field label="Site" required hint="Imported users are placed under this site; move them later if needed.">
                  <Dropdown
                    placeholder={sites.isLoading ? 'Loading sites…' : 'Select a site'}
                    selectedOptions={siteId ? [siteId] : []}
                    value={selected ? `${selected.sitecode} · ${selected.name ?? ''}` : ''}
                    onOptionSelect={(_, d) => setSiteId(d.optionValue ?? '')}
                  >
                    {siteList.map((x) => (
                      <Option key={x.id} value={x.id} text={`${x.sitecode} · ${x.name ?? ''}`}>
                        {x.sitecode} · {x.name ?? ''}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Checkbox
                  checked={evOnly}
                  onChange={(_, d) => setEvOnly(!!d.checked)}
                  label="Only users with Enterprise Voice enabled"
                />
                {preview.isError ? (
                  <LoadError message={`Could not count candidates: ${(preview.error as Error).message}`} />
                ) : (
                  <Text size={200}>
                    {preview.isLoading ? 'Counting…' : `${(preview.data?.wouldCreate ?? 0).toLocaleString()} user(s) would be created.`}
                  </Text>
                )}
                {err && <LoadError message={err} />}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            {result ? (
              <Button appearance="primary" onClick={onDone}>
                Done
              </Button>
            ) : (
              <>
                <Button appearance="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  appearance="primary"
                  disabled={!siteId || run.isPending || (preview.data?.wouldCreate ?? 0) === 0}
                  onClick={() => run.mutate()}
                >
                  Import
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* --------------------------------- page --------------------------------- */

type TabKey =
  | 'overview'
  | 'changes'
  | 'users'
  | 'resource_accounts'
  | 'numbers'
  | 'policies'
  | 'voice_routing'
  | 'emergency'
  | 'voice_apps';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'changes', label: 'Changes' },
  { key: 'users', label: 'Users' },
  { key: 'resource_accounts', label: 'Resource accounts' },
  { key: 'numbers', label: 'Phone numbers' },
  { key: 'policies', label: 'Policies' },
  { key: 'voice_routing', label: 'Voice routing' },
  { key: 'emergency', label: 'Emergency' },
  { key: 'voice_apps', label: 'Voice apps' },
];

/** The "what changed in this sync" log, with a run picker and type filter. */
function ChangesTab({ base }: { base: string }) {
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
  const activeRun = runId || runList[0]?.id || '';
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
    `${fmt(r.started_at ?? r.created_at)} · ${r.scope_types ? 'partial' : 'full'} · ${r.status}`;

  return (
    <Card className={s.card}>
      <div className={s.toolbar}>
        <Text weight="semibold">
          What changed <span className={s.muted}>({total.toLocaleString()})</span>
        </Text>
        <div className={s.row}>
          <Dropdown
            size="small"
            style={{ minWidth: 240 }}
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
            style={{ minWidth: 150 }}
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
            style={{ minWidth: 200 }}
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

const str = (o: TenantObject, k: string) => {
  const v = o.data[k];
  return v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : String(v);
};

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
  const invalidateAll = () => qc.invalidateQueries({ queryKey: ['tdisc'] });

  if (!tid) return <NoTenant />;

  const sm = summary.data;
  const counts = sm?.counts ?? {};

  return (
    <Page
      title="Discovery"
      subtitle="A point-in-time inventory of the customer's live Microsoft Teams tenant - users, licences, numbers and every voice policy - for Data Collection, Design & Build and Deployment to reference."
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
                <Card key={t} className={s.stat}>
                  <span className={s.statN}>{(counts[t] ?? 0).toLocaleString()}</span>
                  <Text size={200} className={s.muted}>
                    {TENANT_OBJECT_TYPE_LABELS[t]}
                  </Text>
                </Card>
              ))}
            <Card className={s.stat}>
              <span className={s.statN}>{(sm?.linkedDiscoveryUsers ?? 0).toLocaleString()}</span>
              <Text size={200} className={s.muted}>
                Linked to Data Collection
              </Text>
            </Card>
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

      {tab === 'users' && <UsersTable base={base} canImport={can('discovery:write')} onImported={invalidateAll} />}

      {tab === 'resource_accounts' && (
        <ObjectsTable
          base={base}
          type="resource_account"
          columns={[
            { label: 'Name', render: (o) => o.display_name ?? o.object_key },
            { label: 'UPN', render: (o) => str(o, 'UserPrincipalName') },
            { label: 'Application', render: (o) => str(o, 'ApplicationId') },
            { label: 'Number', render: (o) => str(o, 'PhoneNumber') },
          ]}
        />
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
          <ObjectsTable base={base} type="emergency_location" columns={[{ label: 'Location', render: (o) => o.display_name ?? o.object_key }, { label: 'Address', render: (o) => str(o, 'HouseNumber') + ' ' + str(o, 'StreetName') }, { label: 'City', render: (o) => str(o, 'City') }, { label: 'Country', render: (o) => str(o, 'CountryOrRegion') }]} />
          <ObjectsTable base={base} type="civic_address" columns={[{ label: 'Address', render: (o) => o.display_name ?? o.object_key }, { label: 'City', render: (o) => str(o, 'City') }, { label: 'Validated', render: (o) => str(o, 'ValidationStatus') }]} />
        </>
      )}

      {tab === 'voice_apps' && (
        <>
          <ObjectsTable base={base} type="auto_attendant" columns={[{ label: 'Name', render: (o) => o.display_name ?? o.object_key }, { label: 'Language', render: (o) => str(o, 'LanguageId') }, { label: 'Time zone', render: (o) => str(o, 'TimeZoneId') }]} />
          <ObjectsTable base={base} type="call_queue" columns={[{ label: 'Name', render: (o) => o.display_name ?? o.object_key }, { label: 'Routing', render: (o) => str(o, 'RoutingMethod') }, { label: 'Agents', render: (o) => String((o.data.Agents as unknown[] | undefined)?.length ?? '—') }]} />
          <ObjectsTable base={base} type="schedule" columns={[{ label: 'Name', render: (o) => o.display_name ?? o.object_key }, { label: 'Type', render: (o) => str(o, 'Type') }]} />
        </>
      )}
    </Page>
  );
}
