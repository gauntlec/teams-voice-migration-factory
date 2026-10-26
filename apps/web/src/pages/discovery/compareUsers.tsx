import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Spinner, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles, tokens } from '@fluentui/react-components';
import type { VoiceCompareRow, VoiceProfile } from '@tvmf/shared';
import { api } from '../../api';
import { DataTable } from '../../components/DataTable';
import { LoadError } from '../../components/records';

const useStyles = makeStyles({
  surface: { width: '94vw', maxWidth: '1000px' },
  body: { display: 'grid', rowGap: '10px' },
  muted: { color: tokens.colorNeutralForeground3 },
  section: { backgroundColor: tokens.colorNeutralBackground3, fontWeight: tokens.fontWeightSemibold },
  differs: { backgroundColor: tokens.colorPaletteYellowBackground1 },
  detail: { color: tokens.colorNeutralForeground2, paddingLeft: '24px' },
  value: { wordBreak: 'break-word' },
});

/**
 * Two discovered users' Teams voice setup side by side (shared/voice-compare.ts). Differences are highlighted; where their
 * policies of one type differ, the settings inside those policies that differ are listed under it.
 */
export function CompareUsersDialog({ base, a, b, onClose }: { base: string; a: string; b: string; onClose: () => void }) {
  const s = useStyles();
  const [onlyDiffs, setOnlyDiffs] = useState(true);
  const q = useQuery({
    queryKey: ['tdisc', 'compare', base, a, b],
    queryFn: () => api<{ a: VoiceProfile; b: VoiceProfile; rows: VoiceCompareRow[]; dataAsOf: string | null }>(`${base}/users/compare?a=${a}&b=${b}`),
  });
  const rows = (q.data?.rows ?? []).filter((r) => !onlyDiffs || r.differs);
  const sections = [...new Set(rows.map((r) => r.section))];
  const diffCount = (q.data?.rows ?? []).filter((r) => r.differs).length;
  const label = (p: VoiceProfile) => p.displayName ?? p.upn;

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>Compare voice setup</DialogTitle>
          <DialogContent>
            <div className={s.body}>
              {q.isLoading ? (
                <Spinner size="tiny" />
              ) : q.isError ? (
                <LoadError message={(q.error as Error).message} />
              ) : q.data ? (
                <>
                  <Text size={200} className={s.muted}>
                    From Discovery{q.data.dataAsOf ? `, last synced ${new Date(q.data.dataAsOf).toLocaleString()}` : ''}. Run a sync first if
                    something changed in the last hours. {diffCount === 0 ? 'Nothing differs.' : `${diffCount} ${diffCount === 1 ? 'thing differs' : 'things differ'}.`}
                  </Text>
                  <Checkbox label="Show only what differs" checked={onlyDiffs} onChange={(_, d) => setOnlyDiffs(!!d.checked)} />
                  <DataTable size="small" minWidth={640}>
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell />
                        <TableHeaderCell>
                          {label(q.data.a)}
                          <Text size={200} className={s.muted} block>{q.data.a.upn}</Text>
                        </TableHeaderCell>
                        <TableHeaderCell>
                          {label(q.data.b)}
                          <Text size={200} className={s.muted} block>{q.data.b.upn}</Text>
                        </TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sections.map((sec) => (
                        <Fragment key={sec}>
                          <TableRow>
                            <TableCell colSpan={3} className={s.section}>{sec}</TableCell>
                          </TableRow>
                          {rows
                            .filter((r) => r.section === sec)
                            .map((r) => (
                              <Fragment key={`${sec}-${r.label}`}>
                                <TableRow className={r.differs ? s.differs : undefined}>
                                  <TableCell>
                                    {r.label}
                                    {r.differs && (
                                      <Badge appearance="tint" color="warning" size="small">
                                        differs
                                      </Badge>
                                    )}
                                  </TableCell>
                                  <TableCell className={s.value}>{r.a}</TableCell>
                                  <TableCell className={s.value}>{r.b}</TableCell>
                                </TableRow>
                                {(r.detail ?? []).map((d) => (
                                  <TableRow key={`${r.label}-${d.label}`}>
                                    <TableCell className={s.detail}>{d.label}</TableCell>
                                    <TableCell className={s.value}>{d.a}</TableCell>
                                    <TableCell className={s.value}>{d.b}</TableCell>
                                  </TableRow>
                                ))}
                              </Fragment>
                            ))}
                        </Fragment>
                      ))}
                    </TableBody>
                  </DataTable>
                </>
              ) : null}
            </div>
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
