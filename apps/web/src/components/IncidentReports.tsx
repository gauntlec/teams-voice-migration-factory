import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Spinner, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles, tokens } from '@fluentui/react-components';
import { INC_PRIORITY_LABELS, type IncPriority } from '@tvmf/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { DataTable } from './DataTable';
import { LoadError } from './records';

const useLocalStyles = makeStyles({
  w95vwMaxW920: { maxWidth: "920px", width: "95vw" },
  maxW200: { maxWidth: '200px' },
});


const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM, maxHeight: '70vh', overflowY: 'auto' },
  tiles: { display: 'flex', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalM },
  tile: { minWidth: '130px', display: 'flex', flexDirection: 'column', padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  value: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  muted: { color: tokens.colorNeutralForeground3 },
  two: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', columnGap: tokens.spacingHorizontalL, rowGap: tokens.spacingVerticalM },
});

interface Report {
  from: string;
  to: string;
  raised: number;
  resolved: number;
  fixed_by?: { agent: number; person_with_agent: number; person: number };
  reopened: number;
  major: number;
  by_priority: { priority: IncPriority; count: number }[];
  by_category: { category: string; label: string; count: number }[];
  by_site: { site: string; count: number }[];
  median_minutes_to_acknowledge: number | null;
  median_hours_to_restore: number | null;
  median_hours_to_resolve: number | null;
  on_time: Record<'response' | 'restoration' | 'resolution', { met: number; missed: number; percent: number | null }>;
  backlog: { under1d: number; d1to3: number; d3to7: number; over7d: number };
  repeats: { category: string; category_label: string; sitecode: string | null; count: number; references: string[] }[];
  problems?: { id: string; reference: string; title: string; count: number }[];
  truncated: boolean;
}

const thisMonth = () => new Date().toISOString().slice(0, 7);
function monthRange(month: string) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { from: `${month}-01`, to: `${next}-01` };
}
const dur = (v: number | null, unit: string) => (v === null ? '—' : `${v} ${unit}`);

/** A month at a time: how many incidents, how fast we acknowledged and restored, how often targets were met, where they come from. */
export function IncidentReportsDialog({ base, onClose }: { base: string; onClose: () => void }) {
  const ls = useLocalStyles();
  const s = useStyles();
  const { can } = useAuth();
  const [month, setMonth] = useState(thisMonth());
  const { from, to } = monthRange(month);
  const q = useQuery({ queryKey: ['incident-report', base, from, to], queryFn: () => api<Report>(`${base}/report?from=${from}&to=${to}`) });
  const r = q.data;
  const pct = (k: keyof Report['on_time']) => (r?.on_time[k].percent === null || !r ? '—' : `${r.on_time[k].percent}%`);
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={ls.w95vwMaxW920}>
        <DialogBody>
          <DialogTitle>Incident report</DialogTitle>
          <DialogContent className={s.stack}>
            <Field label="Month">
              <Input type="month" value={month} max={thisMonth()} onChange={(_, d) => d.value && setMonth(d.value)} className={ls.maxW200} />
            </Field>
            {q.isLoading && <Spinner size="tiny" />}
            {q.isError && <LoadError message={(q.error as Error).message} />}
            {r && (
              <>
                <div className={s.tiles}>
                  {[
                    ['Raised', r.raised],
                    ['Resolved', r.resolved],
                    ['Reopened', r.reopened],
                    ['Major incidents', r.major],
                    ['Open now', r.backlog.under1d + r.backlog.d1to3 + r.backlog.d3to7 + r.backlog.over7d],
                  ].map(([label, n]) => (
                    <div key={label} className={s.tile}>
                      <Text size={200}>{label}</Text>
                      <span className={s.value}>{n}</span>
                    </div>
                  ))}
                </div>
                <div className={s.two}>
                  <div>
                    <Text weight="semibold">Speed</Text>
                    <DataTable size="small" minWidth={300}>
                      <TableBody>
                        <TableRow>
                          <TableCell>Typical time to acknowledge</TableCell>
                          <TableCell>{dur(r.median_minutes_to_acknowledge, 'min')}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell>Typical time to restore service</TableCell>
                          <TableCell>{dur(r.median_hours_to_restore, 'h')}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell>Typical time to resolve</TableCell>
                          <TableCell>{dur(r.median_hours_to_resolve, 'h')}</TableCell>
                        </TableRow>
                      </TableBody>
                    </DataTable>
                    <Text size={200} className={s.muted} block>
                      Time on hold waiting for you, a carrier or Microsoft isn&apos;t counted.
                    </Text>
                  </div>
                  <div>
                    <Text weight="semibold">Targets met</Text>
                    <DataTable size="small" minWidth={300}>
                      <TableBody>
                        {(['response', 'restoration', 'resolution'] as const).map((k) => (
                          <TableRow key={k}>
                            <TableCell>{k === 'response' ? 'First response' : k === 'restoration' ? 'Service restored' : 'Resolved'}</TableCell>
                            <TableCell>
                              {pct(k)} <Text size={200} className={s.muted}>({r.on_time[k].met} of {r.on_time[k].met + r.on_time[k].missed})</Text>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </DataTable>
                  </div>
                </div>
                {r.fixed_by && r.resolved > 0 && (r.fixed_by.agent > 0 || r.fixed_by.person_with_agent > 0) && (
                  <div>
                    <Text weight="semibold">Who fixed them</Text>
                    <DataTable size="small" minWidth={300}>
                      <TableBody>
                        <TableRow>
                          <TableCell>An assistant on its own</TableCell>
                          <TableCell>{r.fixed_by.agent}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell>A person, with an assistant&apos;s help</TableCell>
                          <TableCell>{r.fixed_by.person_with_agent}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell>A person on their own</TableCell>
                          <TableCell>{r.fixed_by.person}</TableCell>
                        </TableRow>
                      </TableBody>
                    </DataTable>
                  </div>
                )}
                <div className={s.two}>
                  <div>
                    <Text weight="semibold">By priority</Text>
                    <DataTable size="small" minWidth={260}>
                      <TableBody>
                        {r.by_priority.map((p) => (
                          <TableRow key={p.priority}>
                            <TableCell>{INC_PRIORITY_LABELS[p.priority]}</TableCell>
                            <TableCell>{p.count}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </DataTable>
                  </div>
                  <div>
                    <Text weight="semibold">Open now, by age</Text>
                    <DataTable size="small" minWidth={260}>
                      <TableBody>
                        {[
                          ['Under a day', r.backlog.under1d],
                          ['1 to 3 days', r.backlog.d1to3],
                          ['3 to 7 days', r.backlog.d3to7],
                          ['Over a week', r.backlog.over7d],
                        ].map(([label, n]) => (
                          <TableRow key={label}>
                            <TableCell>{label}</TableCell>
                            <TableCell>{n}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </DataTable>
                  </div>
                </div>
                <div className={s.two}>
                  <div>
                    <Text weight="semibold">By category</Text>
                    {r.by_category.length === 0 ? <Text size={200} block>None this month.</Text> : (
                      <DataTable size="small" minWidth={300}>
                        <TableBody>
                          {r.by_category.map((c) => (
                            <TableRow key={c.category}>
                              <TableCell>{c.label}</TableCell>
                              <TableCell>{c.count}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </DataTable>
                    )}
                  </div>
                  <div>
                    <Text weight="semibold">By site</Text>
                    {r.by_site.length === 0 ? <Text size={200} block>None this month.</Text> : (
                      <DataTable size="small" minWidth={260}>
                        <TableBody>
                          {r.by_site.map((c) => (
                            <TableRow key={c.site}>
                              <TableCell>{c.site}</TableCell>
                              <TableCell>{c.count}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </DataTable>
                    )}
                  </div>
                </div>
                {r.repeats.length > 0 && (
                  <div>
                    <Text weight="semibold">Keeps happening</Text>
                    <DataTable size="small" minWidth={500}>
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>What</TableHeaderCell>
                          <TableHeaderCell>Where</TableHeaderCell>
                          <TableHeaderCell>Times</TableHeaderCell>
                          <TableHeaderCell>Incidents</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {r.repeats.map((x) => (
                          <TableRow key={`${x.category}:${x.sitecode}`}>
                            <TableCell>{x.category_label}</TableCell>
                            <TableCell>{x.sitecode ?? 'All sites'}</TableCell>
                            <TableCell>{x.count}</TableCell>
                            <TableCell>{x.references.join(', ')}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </DataTable>
                  </div>
                )}
                {can('inc:manage') && r.problems && r.problems.length > 0 && (
                  <div>
                    <Text weight="semibold">Problems behind this month&apos;s incidents</Text>
                    <DataTable size="small" minWidth={400}>
                      <TableBody>
                        {r.problems.map((p) => (
                          <TableRow key={p.id}>
                            <TableCell>
                              {p.reference} · {p.title}
                            </TableCell>
                            <TableCell>{p.count} incidents</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </DataTable>
                  </div>
                )}
                {r.truncated && <Text size={200}>This month has more incidents than the report reads; the figures cover the most recent ones.</Text>}
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
