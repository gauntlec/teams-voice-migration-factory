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
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  INC_DEFAULT_COVER,
  INC_DEFAULT_MATRIX,
  INC_IMPACTS,
  INC_IMPACT_LABELS,
  INC_PRIORITIES,
  INC_PRIORITY_LABELS,
  INC_URGENCIES,
  INC_URGENCY_LABELS,
  incEffectiveTargets,
  type IncCalendar,
  type IncCover,
  type IncMatrix,
  type IncPriority,
  type IncSlaTargets,
} from '@tvmf/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { DataTable } from './DataTable';
import { LoadError } from './records';
import { errorText } from '../pages/ServiceRequests';

const useStyles = makeStyles({
  // Children keep their height and the dialog scrolls, instead of the tables being squashed to fit.
  stack: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM, '& > *': { flexShrink: 0 } },
  muted: { color: tokens.colorNeutralForeground3 },
  error: { color: tokens.colorPaletteRedForeground1 },
  row: { display: 'flex', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalS, alignItems: 'end' },
  num: { width: '96px' },
});

export interface IncidentSettingsData {
  stakeholders?: { id: string; display_name: string }[];
  targets: IncSlaTargets;
  matrix: IncMatrix;
  calendar: IncCalendar | null;
  cover: Record<IncPriority, IncCover>;
}

export function useIncidentSettings(base: string, enabled = true) {
  return useQuery({ queryKey: ['incident-settings', base], enabled, queryFn: () => api<IncidentSettingsData>(`${base}/settings`) });
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * A customer's incident targets, working week and priority matrix. Everyone on
 * the customer can read them ("Our targets"); a Super Admin changes them. Only
 * what differs from the defaults is saved, so a customer who never touches a
 * value keeps following the defaults.
 */
export function IncidentSettingsDialog({ base, onClose }: { base: string; onClose: () => void }) {
  const s = useStyles();
  const qc = useQueryClient();
  const { me, can } = useAuth();
  const editable = me?.role === 'SUPER_ADMIN';
  const settings = useIncidentSettings(base);

  const [draft, setDraft] = useState<{ targets: IncSlaTargets; matrix: IncMatrix; calendarOn: boolean; calendar: IncCalendar; cover: Record<IncPriority, IncCover>; holidays: string; stakeholders: string[] } | null>(null);
  const customers = useQuery({
    queryKey: ['incident-customer-users', base],
    enabled: can('inc:manage'),
    queryFn: () => api<{ id: string; display_name: string; email: string }[]>(`${base}/customer-users`),
  });
  const d = useMemo(() => {
    if (draft) return draft;
    if (!settings.data) return null;
    const cal = settings.data.calendar;
    return {
      targets: settings.data.targets,
      matrix: settings.data.matrix,
      calendarOn: !!cal,
      calendar: cal ?? { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, holidays: [] },
      cover: settings.data.cover,
      holidays: (cal?.holidays ?? []).join('\n'),
      stakeholders: (settings.data.stakeholders ?? []).map((x) => x.id),
    };
  }, [draft, settings.data]);
  const set = (patch: Partial<NonNullable<typeof d>>) => d && setDraft({ ...d, ...patch });

  const holidays = useMemo(() => (d ? d.holidays.split(/[\s,;]+/).map((h) => h.trim()).filter(Boolean) : []), [d]);
  const badHoliday = holidays.find((h) => !/^\d{4}-\d{2}-\d{2}$/.test(h));

  const save = useMutation({
    mutationFn: () => {
      const calendar = d!.calendarOn ? { ...d!.calendar, holidays } : null;
      // Only what differs from the defaults (for how each priority is covered) is stored.
      const cover: Partial<Record<IncPriority, IncCover>> = {};
      for (const p of INC_PRIORITIES) if (d!.cover[p] !== INC_DEFAULT_COVER[p]) cover[p] = d!.cover[p];
      const defaults = incEffectiveTargets({ calendar, cover });
      const targets: Partial<IncSlaTargets> = {};
      for (const p of INC_PRIORITIES) if (JSON.stringify(d!.targets[p]) !== JSON.stringify(defaults[p])) targets[p] = d!.targets[p];
      const matrix: Record<string, Record<string, IncPriority>> = {};
      for (const i of INC_IMPACTS) for (const u of INC_URGENCIES) if (d!.matrix[i][u] !== INC_DEFAULT_MATRIX[i][u]) (matrix[i] ??= {})[u] = d!.matrix[i][u];
      return api(`${base}/settings`, { method: 'PUT', body: JSON.stringify({ targets, matrix, calendar, cover, stakeholders: d!.stakeholders }) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['incident-settings'] });
      qc.invalidateQueries({ queryKey: ['incidents'] });
      qc.invalidateQueries({ queryKey: ['incident'] });
      onClose();
    },
  });

  const setTarget = (p: IncPriority, patch: Partial<IncSlaTargets[IncPriority]>) => d && set({ targets: { ...d.targets, [p]: { ...d.targets[p], ...patch } } });
  const num = (v: string) => (v === '' ? NaN : Number(v));
  const targetsOk = d ? INC_PRIORITIES.every((p) => d.targets[p].responseMinutes > 0 && d.targets[p].resolveHours > 0 && (d.targets[p].restoreHours === null || d.targets[p].restoreHours! > 0)) : false;
  const tzList = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    } catch {
      return [];
    }
  }, []);

  return (
    <Dialog open onOpenChange={(_, x) => !x.open && onClose()}>
      <DialogSurface style={{ maxWidth: '860px', width: '94vw' }}>
        <DialogBody>
          <DialogTitle>{editable ? 'Incident settings' : 'Our incident targets'}</DialogTitle>
          <DialogContent className={s.stack} style={{ maxHeight: '72vh', overflowY: 'auto' }}>
            {settings.isLoading && <Spinner size="tiny" />}
            {settings.isError && <LoadError message={(settings.error as Error).message} />}
            {d && (
              <>
                {!editable && <Text size={200} className={s.muted}>These are the targets the team works to for your incidents. A Super Admin can change them.</Text>}

                <Text weight="semibold">Targets</Text>
                <Text size={200} className={s.muted}>
                  Respond is how soon an engineer picks it up; restore is how soon calls work again; resolve is how soon the cause is fixed. Time on hold waiting for you (or, except for P1, a carrier or Microsoft) isn&apos;t counted.
                </Text>
                <DataTable size="small" minWidth={640}>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Priority</TableHeaderCell>
                      <TableHeaderCell>Clock</TableHeaderCell>
                      <TableHeaderCell>Respond (minutes)</TableHeaderCell>
                      <TableHeaderCell>Restore (hours)</TableHeaderCell>
                      <TableHeaderCell>Resolve (hours)</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {INC_PRIORITIES.map((p) => (
                      <TableRow key={p}>
                        <TableCell>{INC_PRIORITY_LABELS[p]}</TableCell>
                        <TableCell>
                          <Select
                            size="small"
                            disabled={!editable || !d.calendarOn}
                            value={d.calendarOn ? d.cover[p] : '24x7'}
                            onChange={(_, x) => set({ cover: { ...d.cover, [p]: x.value as IncCover } })}
                            aria-label={`${INC_PRIORITY_LABELS[p]} clock`}
                          >
                            <option value="24x7">Around the clock</option>
                            <option value="business">Working hours</option>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Input className={s.num} size="small" type="number" min={1} disabled={!editable} value={Number.isNaN(d.targets[p].responseMinutes) ? '' : String(d.targets[p].responseMinutes)} onChange={(_, x) => setTarget(p, { responseMinutes: num(x.value) })} />
                        </TableCell>
                        <TableCell>
                          <Input className={s.num} size="small" type="number" min={0.5} step={0.5} placeholder="none" disabled={!editable} value={d.targets[p].restoreHours === null ? '' : String(d.targets[p].restoreHours)} onChange={(_, x) => setTarget(p, { restoreHours: x.value === '' ? null : num(x.value) })} />
                        </TableCell>
                        <TableCell>
                          <Input className={s.num} size="small" type="number" min={0.5} step={0.5} disabled={!editable} value={Number.isNaN(d.targets[p].resolveHours) ? '' : String(d.targets[p].resolveHours)} onChange={(_, x) => setTarget(p, { resolveHours: num(x.value) })} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </DataTable>

                <Text weight="semibold">Working week</Text>
                <Checkbox
                  disabled={!editable}
                  checked={d.calendarOn}
                  label="Some priorities only count working hours"
                  onChange={(_, x) => {
                    const on = !!x.checked;
                    set({ calendarOn: on, cover: on ? { ...INC_DEFAULT_COVER } : { p1: '24x7', p2: '24x7', p3: '24x7', p4: '24x7' } });
                  }}
                />
                {d.calendarOn && (
                  <>
                    <div className={s.row}>
                      {DAYS.map((name, i) => (
                        <Checkbox
                          key={name}
                          disabled={!editable}
                          label={name}
                          checked={d.calendar.days.includes(i)}
                          onChange={(_, x) => set({ calendar: { ...d.calendar, days: x.checked ? [...d.calendar.days, i].sort() : d.calendar.days.filter((v) => v !== i) } })}
                        />
                      ))}
                    </div>
                    <div className={s.row}>
                      <Field label="From">
                        <Input type="time" disabled={!editable} value={d.calendar.start} onChange={(_, x) => set({ calendar: { ...d.calendar, start: x.value } })} />
                      </Field>
                      <Field label="To">
                        <Input type="time" disabled={!editable} value={d.calendar.end} onChange={(_, x) => set({ calendar: { ...d.calendar, end: x.value } })} />
                      </Field>
                      <Field label="Time zone">
                        <Input list="inc-time-zones" disabled={!editable} value={d.calendar.timeZone} onChange={(_, x) => set({ calendar: { ...d.calendar, timeZone: x.value } })} />
                        <datalist id="inc-time-zones">
                          {tzList.map((z) => (
                            <option key={z} value={z} />
                          ))}
                        </datalist>
                      </Field>
                    </div>
                    <Field label="Days off" hint="One date per line, as YYYY-MM-DD, e.g. bank holidays." validationMessage={badHoliday ? `"${badHoliday}" is not a date like 2026-12-25` : undefined}>
                      <Textarea disabled={!editable} rows={3} resize="vertical" value={d.holidays} onChange={(_, x) => set({ holidays: x.value })} />
                    </Field>
                  </>
                )}

                <Text weight="semibold">Named contacts for major incidents</Text>
                <Text size={200} className={s.muted}>
                  These people are emailed about every major incident (declared, updated, resolved) and every post-incident review, whether or not they follow the incident.
                </Text>
                {editable ? (
                  (customers.data ?? []).length === 0 ? (
                    <Text size={200}>This customer has no users to name yet.</Text>
                  ) : (
                    <div className={s.row}>
                      {(customers.data ?? []).map((u) => (
                        <Checkbox
                          key={u.id}
                          label={`${u.display_name} (${u.email})`}
                          checked={d.stakeholders.includes(u.id)}
                          onChange={(_, x) => set({ stakeholders: x.checked ? [...d.stakeholders, u.id] : d.stakeholders.filter((v) => v !== u.id) })}
                        />
                      ))}
                    </div>
                  )
                ) : (
                  <Text size={200}>{(settings.data?.stakeholders ?? []).length ? settings.data!.stakeholders!.map((x) => x.display_name).join(', ') : 'None named.'}</Text>
                )}

                <Text weight="semibold">Priority from impact and urgency</Text>
                <DataTable size="small" minWidth={720}>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Who is affected</TableHeaderCell>
                      {INC_URGENCIES.map((u) => (
                        <TableHeaderCell key={u}>{INC_URGENCY_LABELS[u].replace(/ \(.*\)$/, '')}</TableHeaderCell>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {INC_IMPACTS.map((i) => (
                      <TableRow key={i}>
                        <TableCell>{INC_IMPACT_LABELS[i]}</TableCell>
                        {INC_URGENCIES.map((u) => (
                          <TableCell key={u}>
                            <Select
                              size="small"
                              disabled={!editable}
                              value={d.matrix[i][u]}
                              onChange={(_, x) => set({ matrix: { ...d.matrix, [i]: { ...d.matrix[i], [u]: x.value as IncPriority } } })}
                              aria-label={`${INC_IMPACT_LABELS[i]}, ${INC_URGENCY_LABELS[u]}`}
                            >
                              {INC_PRIORITIES.map((p) => (
                                <option key={p} value={p}>
                                  {INC_PRIORITY_LABELS[p]}
                                </option>
                              ))}
                            </Select>
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </DataTable>
                <Text size={200} className={s.muted}>
                  Emergency calling problems are always P1, whatever this says.
                </Text>
                {save.isError && <Text className={s.error}>{errorText(save.error, 'Could not save the settings')}</Text>}
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              {editable ? 'Cancel' : 'Close'}
            </Button>
            {editable && (
              <Button appearance="primary" disabled={!d || save.isPending || !targetsOk || !!badHoliday || (d.calendarOn && (d.calendar.days.length === 0 || d.calendar.start >= d.calendar.end))} onClick={() => save.mutate()}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
