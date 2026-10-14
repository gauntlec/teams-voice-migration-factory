import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Link, ProgressBar, Spinner, Text, tokens } from '@fluentui/react-components';
import { ArrowSyncRegular, CheckmarkRegular, ChevronDownRegular, ChevronRightRegular, DeleteRegular, PlugConnectedRegular } from '@fluentui/react-icons';
import { TENANT_DISCOVERY_STEPS, TENANT_DISCOVERY_STEP_LABELS, TENANT_DISCOVERY_STEP_TYPES, TENANT_OBJECT_TYPE_LABELS, type TenantConnectionInfo, type TenantDiscoveryRun, type TenantDiscoveryStep, type TenantDiscoverySummary, type TenantObjectType } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { LoadError } from '../../components/records';
import { useStyles, fmt, changeCountsOf, totalChanges, CopyButton } from './discoveryShared';

interface Connection {
  id: string;
  status: 'pending' | 'active' | 'expired' | 'closed';
  user_code: string | null;
  verification_uri: string | null;
  upn: string | null;
  expires_at: string | null;
  started_at: string;
  /** Optional second sign-in, to Microsoft Graph (read-only Group.Read.All) - for M365 group lookup (Shared Voicemail's groupId field). */
  graph_status: 'none' | 'pending' | 'active' | 'failed';
  graph_user_code: string | null;
  graph_verification_uri: string | null;
  graph_upn: string | null;
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

export function ConnectCard({
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
  const canManage = !!summary?.canManageConnections;
  const sessions = summary?.activeConnections ?? [];
  const myActiveId = summary?.activeConnection?.id ?? null;

  const [connId, setConnId] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeSel, setScopeSel] = useState<Set<TenantObjectType>>(new Set());
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [includeUnlicensed, setIncludeUnlicensed] = useState(false);

  // An engineer only ever works with their own session (the API scopes it too).
  useEffect(() => {
    if (canManage) return;
    if (!connId && myActiveId) setConnId(myActiveId);
  }, [canManage, myActiveId, connId]);

  // A Super Admin chooses which engineer's session a sync runs on — default to
  // their own, otherwise the first still-active one.
  useEffect(() => {
    if (!canManage) return;
    if (pickedId && sessions.some((x) => x.id === pickedId)) return;
    setPickedId(myActiveId ?? sessions.find((x) => x.status === 'active')?.id ?? null);
  }, [canManage, pickedId, sessions, myActiveId]);

  const focusedId = canManage ? pickedId : connId ?? myActiveId;
  const focusedMeta: TenantConnectionInfo | null =
    sessions.find((x) => x.id === focusedId) ?? null;
  const focusedForeign = !!focusedMeta && !focusedMeta.isMine;

  const conn = useQuery({
    queryKey: ['tdisc', 'conn', base, focusedId],
    enabled: !!focusedId,
    queryFn: () => api<Connection>(`${base}/connections/${focusedId}`),
    // Fast while a sign-in is pending; slowly while connected, so an expired
    // session stops showing "Connected" (and offering runs that would fail).
    refetchInterval: (q) =>
      q.state.data?.status === 'pending' || q.state.data?.graph_status === 'pending'
        ? 3000
        : q.state.data?.status === 'active'
          ? 30000
          : false,
  });

  const start = useMutation({
    mutationFn: () => api<Connection>(`${base}/connections`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (c) => {
      setErr(null);
      setConnId(c.id);
      setPickedId(c.id);
      onChanged();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not start the connection'),
  });

  const graphConnect = useMutation({
    mutationFn: () =>
      api<Connection>(`${base}/connections/${focusedId}/graph`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => {
      setErr(null);
      onChanged();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not start the group-lookup sign-in'),
  });

  const c = conn.data;
  const run = useMutation({
    mutationFn: (scopeTypes?: TenantObjectType[]) => {
      // The "include disabled / unlicensed" ticks belong to the partial-sync
      // panel; a full run uses the customer's own setting, never a leftover tick.
      const partial = !!scopeTypes?.length;
      const widenUsers = partial && scopeTypes!.includes('user');
      return api<TenantDiscoveryRun>(`${base}/runs`, {
        method: 'POST',
        body: JSON.stringify({
          connectionId: focusedId,
          ...(partial ? { scopeTypes } : {}),
          ...(widenUsers && includeDisabled ? { includeDisabled: true } : {}),
          ...(widenUsers && includeUnlicensed ? { includeUnlicensed: true } : {}),
        }),
      });
    },
    onSuccess: () => {
      setErr(null);
      setScopeOpen(false);
      onChanged();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not start discovery'),
  });

  const running = summary?.lastRun && ['queued', 'running'].includes(summary.lastRun.status);
  const runDisabled = !canRun || run.isPending || !!running || c?.status !== 'active';

  return (
    <Card className={s.card}>
      <Text weight="semibold">Customer tenant connection</Text>
      <Text size={200} className={s.muted}>
        Sign in with a <b>Teams Administrator</b> account for this customer. The sign-in is live and
        point-in-time: nothing is stored, and the session ends when it expires. A session can only be
        used by the engineer who started it, or by a Super Admin.
      </Text>

      {canManage && sessions.length > 0 && (
        <div style={{ display: 'grid', gap: 4 }}>
          <Text size={200} className={s.muted}>
            Active sessions — pick the one a sync runs on.
          </Text>
          <div className={s.sessionPanel}>
            {sessions.map((sess) => {
              const sel = sess.id === focusedId;
              return (
                <div
                  key={sess.id}
                  className={s.sessionRow}
                  style={{
                    background: sel ? tokens.colorNeutralBackground3 : undefined,
                    borderLeftColor: sel ? tokens.colorBrandStroke1 : 'transparent',
                  }}
                  role="button"
                  tabIndex={0}
                  onClick={() => setPickedId(sess.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setPickedId(sess.id);
                    }
                  }}
                >
                  <Badge
                    appearance="tint"
                    size="small"
                    color={sess.status === 'active' ? 'success' : 'informative'}
                  >
                    {sess.status}
                  </Badge>
                  <b>{sess.owner?.name ?? sess.owner?.email ?? 'Unknown engineer'}</b>
                  {sess.isMine && (
                    <Badge appearance="outline" size="small">
                      You
                    </Badge>
                  )}
                  <span className={s.muted}>
                    {sess.upn ? `as ${sess.upn} · ` : ''}since {fmt(sess.started_at)}
                    {sess.expires_at ? ` · expires ${fmt(sess.expires_at)}` : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
          {focusedForeign ? (
            <div className={s.row}>
              <Spinner size="tiny" />
              <Text size={200}>
                {focusedMeta?.owner?.name ?? focusedMeta?.owner?.email ?? 'Another engineer'} is signing
                in to the customer tenant…
              </Text>
            </div>
          ) : c.user_code ? (
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
              {focusedForeign && focusedMeta?.owner
                ? ` · ${focusedMeta.owner.name ?? focusedMeta.owner.email}'s session`
                : ''}
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
              {canManage && focusedForeign ? 'Connect my own session' : 'Sign in again'}
            </Button>
          </div>
          {focusedForeign && (
            <Text size={200} className={s.muted}>
              You are a Super Admin — running a sync here uses{' '}
              <b>{focusedMeta?.owner?.name ?? focusedMeta?.owner?.email ?? 'another engineer'}</b>’s
              session. This is recorded in the audit log.
            </Text>
          )}

          {/* Optional 2nd sign-in, to Microsoft Graph (read-only Group.Read.All) -
              lets Design & Build search M365 groups instead of typing a raw
              Object ID into the Shared Voicemail groupId field. */}
          {!focusedForeign && (
            <div className={s.sessionPanel} style={{ background: 'transparent' }}>
              {c.graph_status === 'active' ? (
                <div className={s.row}>
                  <Badge appearance="tint" color="success">
                    Group lookup
                  </Badge>
                  <Text size={200}>
                    connected{c.graph_upn ? ` as ${c.graph_upn}` : ''} — M365 groups can now be searched
                    by name when setting a Shared Voicemail target
                  </Text>
                </div>
              ) : c.graph_status === 'pending' ? (
                c.graph_user_code ? (
                  <div style={{ display: 'grid', gap: 6 }}>
                    <Text size={200}>
                      Second sign-in for group lookup — open{' '}
                      <Link
                        href={c.graph_verification_uri ?? 'https://microsoft.com/devicelogin'}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {c.graph_verification_uri ?? 'https://microsoft.com/devicelogin'}
                      </Link>{' '}
                      and enter:
                    </Text>
                    <div className={s.row}>
                      <span className={s.code}>{c.graph_user_code}</span>
                      <CopyButton text={c.graph_user_code} label="Copy code" />
                      <Spinner size="tiny" label="Waiting…" />
                    </div>
                  </div>
                ) : (
                  <Spinner size="tiny" label="Requesting a device code…" />
                )
              ) : (
                <div className={s.row}>
                  <Text size={200} className={s.muted}>
                    {c.graph_status === 'failed'
                      ? 'Group-lookup sign-in failed — a Global Admin may need to approve Microsoft Graph PowerShell. '
                      : 'M365 groups (Shared Voicemail targets) are typed by Object ID until this is connected. '}
                  </Text>
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<PlugConnectedRegular />}
                    disabled={!canRun || graphConnect.isPending}
                    onClick={() => graphConnect.mutate()}
                  >
                    {c.graph_status === 'failed' ? 'Retry group lookup' : 'Add group lookup'}
                  </Button>
                </div>
              )}
            </div>
          )}

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

export function RunCard({ base, summary }: { base: string; summary: TenantDiscoverySummary | undefined }) {
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
  // When a run finishes, refresh the summary and every list on the page - they
  // otherwise kept showing the old snapshot until something else refetched.
  const liveStatus = live.data?.status;
  const prevStatus = useRef(liveStatus);
  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = liveStatus;
    if (was && ['queued', 'running'].includes(was) && liveStatus && !['queued', 'running'].includes(liveStatus)) {
      void qc.invalidateQueries({ queryKey: ['tdisc'] });
    }
  }, [liveStatus, qc]);
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
export function PurgeCard({
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
  const hasData = total > 0 || !!summary?.lastRun || (summary?.groupsCount ?? 0) > 0;
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
        Removes every discovered object, the Users and Policies projections, the M365 group cache
        and the run history for this customer. Data Collection entries are kept, but lose their link to a discovered user.
        Re-run discovery to rebuild. This cannot be undone.
      </Text>
      <div className={s.row}>
        <Button
          appearance="secondary"
          icon={<DeleteRegular />}
          style={{ color: tokens.colorPaletteRedForeground1 }}
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
              {summary?.groupsCount ? `, ${summary.groupsCount.toLocaleString()} cached M365 groups` : ''}
              {summary?.lastRun ? ' and the run history' : ''}. Any Data Collection users stay, but
              lose their link to a discovered identity. This cannot be undone.
              {running && (
                <Text style={{ color: tokens.colorPaletteRedForeground1, display: 'block', marginTop: 8 }}>
                  A discovery is running — wait for it to finish first.
                </Text>
              )}
              {err && (
                <Text style={{ color: tokens.colorPaletteRedForeground1, display: 'block', marginTop: 8 }}>{err}</Text>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                style={{ backgroundColor: tokens.colorPaletteRedBackground3 }}
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
