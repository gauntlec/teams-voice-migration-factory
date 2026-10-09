import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Select,
  Spinner,
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
  SR_PRIORITIES,
  SR_TYPES,
  SR_TYPE_DEFS,
  type SrChangeWindow,
  type SrPriority,
  type SrSlaTargets,
  type SrType,
} from '@tvmf/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { LoadError } from '../components/records';
import { PRIORITY_LABEL, errorText } from './ServiceRequests';

/**
 * Service Requests -> Settings (targets, approvals, change window; Super
 * Admins edit, everyone else reads) and Reports (one month at a time).
 */

export interface SrSettingsView {
  targets: SrSlaTargets;
  customTargets: SrPriority[];
  approval: { types: SrType[]; approvers: { id: string; display_name: string }[] };
  changeWindow: SrChangeWindow | null;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalL },
  section: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS },
  row: { display: 'flex', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalS, alignItems: 'end' },
  hours: { width: '96px' },
  muted: { color: tokens.colorNeutralForeground3 },
  error: { color: tokens.colorPaletteRedForeground1 },
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: tokens.spacingHorizontalM },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXXS,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
  },
  value: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
});

/** Hours as "8h" / "3 days". */
export function hoursText(h: number) {
  return h >= 48 && h % 24 === 0 ? `${h / 24} days` : `${h}h`;
}

export function useSrSettings(base: string, enabled = true) {
  return useQuery({ queryKey: ['sr-settings', base], enabled, queryFn: () => api<SrSettingsView>(`${base}/settings`) });
}

export function SettingsDialog({ base, onClose }: { base: string; onClose: () => void }) {
  const cs = useStyles();
  const qc = useQueryClient();
  const { me, can } = useAuth();
  const editable = me?.role === 'SUPER_ADMIN';
  const settings = useSrSettings(base);
  const customers = useQuery({
    queryKey: ['sr-customer-users', base],
    enabled: can('sr:manage'),
    queryFn: () => api<{ id: string; display_name: string; email: string }[]>(`${base}/customer-users`),
  });

  const [draft, setDraft] = useState<{
    targets: SrSlaTargets;
    types: SrType[];
    approverIds: string[];
    windowOn: boolean;
    window: SrChangeWindow;
  } | null>(null);
  const d = useMemo(() => {
    if (draft) return draft;
    if (!settings.data) return null;
    return {
      targets: settings.data.targets,
      types: settings.data.approval.types,
      approverIds: settings.data.approval.approvers.map((a) => a.id),
      windowOn: !!settings.data.changeWindow,
      window: settings.data.changeWindow ?? { days: [1, 2, 3, 4, 5], start: '18:00', end: '22:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    };
  }, [draft, settings.data]);
  const set = (patch: Partial<NonNullable<typeof d>>) => d && setDraft({ ...d, ...patch });

  const save = useMutation({
    mutationFn: () =>
      api(`${base}/settings`, {
        method: 'PUT',
        body: JSON.stringify({
          targets: d!.targets,
          approval: { types: d!.types, approverIds: d!.approverIds },
          changeWindow: d!.windowOn ? d!.window : null,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sr-settings', base] });
      qc.invalidateQueries({ queryKey: ['service-requests'] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(_, x) => !x.open && onClose()}>
      <DialogSurface style={{ maxWidth: '760px', width: '94vw' }}>
        <DialogBody>
          <DialogTitle>Managed Services settings</DialogTitle>
          <DialogContent className={cs.stack} style={{ maxHeight: '72vh', overflowY: 'auto' }}>
            {settings.isLoading && <Spinner size="tiny" />}
            {settings.isError && <LoadError message={(settings.error as Error).message} />}
            {d && (
              <>
                {!editable && (
                  <Text size={200} className={cs.muted}>
                    Only a Super Admin can change these.
                  </Text>
                )}
                <div className={cs.section}>
                  <Text weight="semibold">Targets</Text>
                  <Text size={200} className={cs.muted}>
                    In calendar hours from when a request is raised. Time spent waiting on the customer doesn&apos;t count. The team is emailed when a
                    request is close to missing a target, and when it has.
                  </Text>
                  <DataTable size="small" minWidth={420}>
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Priority</TableHeaderCell>
                        <TableHeaderCell>First response within (hours)</TableHeaderCell>
                        <TableHeaderCell>Completed within (hours)</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {SR_PRIORITIES.map((p) => (
                        <TableRow key={p}>
                          <TableCell>{PRIORITY_LABEL[p]}</TableCell>
                          {(['responseHours', 'resolveHours'] as const).map((k) => (
                            <TableCell key={k}>
                              {editable ? (
                                <Input
                                  className={cs.hours}
                                  type="number"
                                  min={1}
                                  value={String(d.targets[p][k])}
                                  onChange={(_, v) => set({ targets: { ...d.targets, [p]: { ...d.targets[p], [k]: Number(v.value) || 0 } } })}
                                />
                              ) : (
                                hoursText(d.targets[p][k])
                              )}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </DataTable>
                </div>

                <div className={cs.section}>
                  <Text weight="semibold">Approval</Text>
                  <Text size={200} className={cs.muted}>
                    Requests of these types wait for one of the customer&apos;s approvers before the team starts. The approvers are emailed.
                  </Text>
                  <div className={cs.row}>
                    {SR_TYPES.map((t) => (
                      <Checkbox
                        key={t}
                        label={SR_TYPE_DEFS[t].label}
                        disabled={!editable}
                        checked={d.types.includes(t)}
                        onChange={(_, v) => set({ types: v.checked ? [...d.types, t] : d.types.filter((x) => x !== t) })}
                      />
                    ))}
                  </div>
                  <Field label="Approvers" hint="Customer users on this customer.">
                    {editable ? (
                      <div className={cs.row}>
                        {(customers.data ?? []).map((u) => (
                          <Checkbox
                            key={u.id}
                            label={u.display_name}
                            checked={d.approverIds.includes(u.id)}
                            onChange={(_, v) => set({ approverIds: v.checked ? [...d.approverIds, u.id] : d.approverIds.filter((x) => x !== u.id) })}
                          />
                        ))}
                        {customers.data?.length === 0 && <Text size={200}>This customer has no customer users yet.</Text>}
                      </div>
                    ) : (
                      <Text>{settings.data!.approval.approvers.map((a) => a.display_name).join(', ') || 'None'}</Text>
                    )}
                  </Field>
                </div>

                <div className={cs.section}>
                  <Text weight="semibold">Change window</Text>
                  <Text size={200} className={cs.muted}>
                    When live changes may be deployed. A deploy outside the window asks the engineer to confirm and is noted on the request.
                  </Text>
                  <Checkbox label="Use a change window" disabled={!editable} checked={d.windowOn} onChange={(_, v) => set({ windowOn: !!v.checked })} />
                  {d.windowOn && (
                    <>
                      <div className={cs.row}>
                        {DAYS.map((name, i) => (
                          <Checkbox
                            key={name}
                            label={name}
                            disabled={!editable}
                            checked={d.window.days.includes(i)}
                            onChange={(_, v) =>
                              set({ window: { ...d.window, days: (v.checked ? [...d.window.days, i] : d.window.days.filter((x) => x !== i)).sort() } })
                            }
                          />
                        ))}
                      </div>
                      <div className={cs.row}>
                        <Field label="From">
                          <Input type="time" disabled={!editable} value={d.window.start} onChange={(_, v) => set({ window: { ...d.window, start: v.value } })} />
                        </Field>
                        <Field label="Until">
                          <Input type="time" disabled={!editable} value={d.window.end} onChange={(_, v) => set({ window: { ...d.window, end: v.value } })} />
                        </Field>
                        <Field label="Time zone" hint="e.g. Europe/London">
                          <Input disabled={!editable} value={d.window.timeZone} onChange={(_, v) => set({ window: { ...d.window, timeZone: v.value } })} />
                        </Field>
                      </div>
                    </>
                  )}
                </div>
                {save.error && <Text className={cs.error}>{errorText(save.error, 'Could not save the settings')}</Text>}
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              {editable ? 'Cancel' : 'Close'}
            </Button>
            {editable && (
              <Button appearance="primary" disabled={!d || save.isPending} onClick={() => save.mutate()}>
                Save
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

interface Report {
  raised: number;
  deployed: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  medianHoursToDeploy: number | null;
  responseMetPct: number | null;
  resolutionMetPct: number | null;
  responseMeasured: number;
  resolutionMeasured: number;
  openBacklog: { total: number; under1d: number; d1to3: number; d3to7: number; over7d: number };
}

/** The last 12 calendar months, newest first, as [label, from, to). */
function months(): { label: string; from: string; to: string }[] {
  const out = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    out.push({ label: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), from: start.toISOString(), to: end.toISOString() });
  }
  return out;
}

export function ReportsDialog({ base, onClose }: { base: string; onClose: () => void }) {
  const cs = useStyles();
  const list = useMemo(months, []);
  const [pick, setPick] = useState(0);
  const m = list[pick]!;
  const report = useQuery({
    queryKey: ['sr-report', base, m.from],
    queryFn: () => api<Report>(`${base}/report?from=${encodeURIComponent(m.from)}&to=${encodeURIComponent(m.to)}`),
  });
  const r = report.data;
  const pct = (v: number | null, n: number) => (v === null ? '—' : `${v}%`) + (n ? ` of ${n}` : '');
  const tiles = r
    ? [
        { label: 'Raised', value: String(r.raised) },
        { label: 'Completed', value: String(r.deployed) },
        { label: 'Median time to complete', value: r.medianHoursToDeploy === null ? '—' : r.medianHoursToDeploy >= 48 ? `${Math.round(r.medianHoursToDeploy / 24)} days` : `${r.medianHoursToDeploy}h` },
        { label: 'First response on time', value: pct(r.responseMetPct, r.responseMeasured) },
        { label: 'Completed on time', value: pct(r.resolutionMetPct, r.resolutionMeasured) },
      ]
    : [];
  return (
    <Dialog open onOpenChange={(_, x) => !x.open && onClose()}>
      <DialogSurface style={{ maxWidth: '820px', width: '94vw' }}>
        <DialogBody>
          <DialogTitle>Service request report</DialogTitle>
          <DialogContent className={cs.stack} style={{ maxHeight: '74vh', overflowY: 'auto' }}>
            <Field label="Month">
              <Select value={String(pick)} onChange={(_, d) => setPick(Number(d.value))}>
                {list.map((x, i) => (
                  <option key={x.from} value={i}>
                    {x.label}
                  </option>
                ))}
              </Select>
            </Field>
            {report.isLoading && <Spinner size="tiny" />}
            {report.isError && <LoadError message={(report.error as Error).message} />}
            {r && (
              <>
                <div className={cs.tiles}>
                  {tiles.map((t) => (
                    <div key={t.label} className={cs.tile}>
                      <Text size={200}>{t.label}</Text>
                      <span className={cs.value}>{t.value}</span>
                    </div>
                  ))}
                </div>
                <Text size={200} className={cs.muted}>
                  For requests raised in {m.label}. Times leave out time spent waiting on the customer. On-time figures count requests that have
                  finished that stage.
                </Text>
                <div className={cs.section}>
                  <Text weight="semibold">By type</Text>
                  {r.raised === 0 ? (
                    <Text size={200}>No requests were raised this month.</Text>
                  ) : (
                    <DataTable size="small" minWidth={360}>
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Type</TableHeaderCell>
                          <TableHeaderCell>Raised</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {SR_TYPES.filter((t) => r.byType[t]).map((t) => (
                          <TableRow key={t}>
                            <TableCell>{SR_TYPE_DEFS[t].label}</TableCell>
                            <TableCell>{r.byType[t]}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </DataTable>
                  )}
                </div>
                <div className={cs.section}>
                  <Text weight="semibold">Open right now: {r.openBacklog.total}</Text>
                  <Text size={200}>
                    Under a day: {r.openBacklog.under1d} · 1–3 days: {r.openBacklog.d1to3} · 3–7 days: {r.openBacklog.d3to7} · Over a week:{' '}
                    {r.openBacklog.over7d}
                  </Text>
                </div>
              </>
            )}
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
