import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Checkbox, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import type { LiveSharedCallingPolicy } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { Dialog } from '../../components/AppDialog';
import { useNotify } from '../../hooks/useNotify';

const useStyles = makeStyles({
  list: { display: 'grid', gap: '6px', maxHeight: '50vh', overflowY: 'auto', paddingRight: '4px' },
  row: { display: 'grid', gridTemplateColumns: 'auto 1fr', alignItems: 'start', gap: '4px' },
  detail: { color: tokens.colorNeutralForeground3, display: 'block', paddingLeft: '2px' },
  badges: { display: 'inline-flex', gap: '4px', marginLeft: '6px', verticalAlign: 'middle' },
  warnings: { display: 'grid', gap: '4px', marginTop: '8px' },
});

/**
 * "Populate from Teams" on the Shared calling tab: the Shared Calling policies Discovery read from Teams, the ones this site uses
 * ticked, the rest there to tick. Rows already in Design & Build are kept as they are unless "Also update" is ticked.
 */
export function SharedCallingPopulateButton({ base, siteId, onDone }: { base: string; siteId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)}>
        Populate from Teams
      </Button>
      {open && <SharedCallingPopulateDialog base={base} siteId={siteId} onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  );
}

function SharedCallingPopulateDialog({ base, siteId, onClose, onDone }: { base: string; siteId: string; onClose: () => void; onDone: () => void }) {
  const s = useStyles();
  const notify = useNotify();
  const qc = useQueryClient();
  const live = useQuery({ queryKey: ['shared-calling-live', base, siteId], queryFn: () => api<LiveSharedCallingPolicy[]>(`${base}/shared-calling-policies/live?siteId=${siteId}`) });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [updateExisting, setUpdateExisting] = useState(false);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [summary, setSummary] = useState('');

  // the ones this site uses and Design & Build doesn't have yet start ticked
  useEffect(() => {
    if (live.data) setPicked(new Set(live.data.filter((p) => p.usedOnSite && !p.inDesign).map((p) => p.name)));
  }, [live.data]);

  const run = useMutation({
    mutationFn: () =>
      api<{ created: number; updated: number; skipped: number; warnings: string[] }>(`${base}/shared-calling-policies/populate`, {
        method: 'POST',
        body: JSON.stringify({ site_id: siteId, names: [...picked], updateExisting }),
      }),
    onSuccess: (r) => {
      onDone();
      void qc.invalidateQueries({ queryKey: ['shared-calling-live', base, siteId] });
      const parts = [`${r.created} added`, ...(r.updated ? [`${r.updated} updated`] : []), ...(r.skipped ? [`${r.skipped} already in Design & Build, left as they are`] : [])];
      setSummary(parts.join(', '));
      if (r.warnings.length) setWarnings(r.warnings);
      else {
        notify('Shared Calling policies populated', { body: parts.join(', ') });
        onClose();
      }
    },
  });

  const toggle = (name: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  const chosenExisting = (live.data ?? []).some((p) => p.inDesign && picked.has(p.name));

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{warnings ? 'Populated, with a few things to check' : 'Populate Shared Calling policies from Teams'}</DialogTitle>
          <DialogContent>
            {warnings ? (
              <div className={s.warnings}>
                <Text block>{summary}.</Text>
                {warnings.map((w, i) => (
                  <Text key={i} size={200} block>
                    · {w}
                  </Text>
                ))}
              </div>
            ) : live.isLoading ? (
              <Spinner size="small" label="Reading the policies Discovery found…" />
            ) : live.error ? (
              <Text block>{live.error instanceof ApiError ? live.error.message : 'Could not read the policies.'}</Text>
            ) : !live.data?.length ? (
              <Text block>Discovery hasn't found any Shared Calling policies in Teams (other than Global). Run a sync if some were added recently.</Text>
            ) : (
              <>
                <Text block size={200} style={{ marginBottom: 8 }}>
                  From Discovery's last read of Teams. The ones this site uses are ticked. Each becomes a Design & Build row with its resource account, emergency
                  numbers and description.
                </Text>
                <div className={s.list}>
                  {live.data.map((p) => (
                    <div key={p.name} className={s.row}>
                      <Checkbox checked={picked.has(p.name)} onChange={(_, d) => toggle(p.name, !!d.checked)} aria-label={`Populate ${p.name}`} />
                      <div>
                        <Text weight="semibold">{p.name}</Text>
                        <span className={s.badges}>
                          {p.usedOnSite && (
                            <Badge size="small" appearance="tint" color="brand">
                              Used on this site
                            </Badge>
                          )}
                          {p.inDesign && (
                            <Badge size="small" appearance="tint" color="informative">
                              In Design & Build
                            </Badge>
                          )}
                        </span>
                        <Text size={200} className={s.detail}>
                          Resource account: {p.resourceAccount ?? 'none'}
                          {p.resourceAccount && !p.resourceAccountRowId ? ' (not in Design & Build on this site)' : ''} · Emergency numbers:{' '}
                          {p.emergencyNumbers.length ? p.emergencyNumbers.join(', ') : 'none'}
                        </Text>
                      </div>
                    </div>
                  ))}
                </div>
                {chosenExisting && (
                  <Checkbox
                    style={{ marginTop: 8 }}
                    checked={updateExisting}
                    onChange={(_, d) => setUpdateExisting(!!d.checked)}
                    label="Also update the ones already in Design & Build with what Teams has (replaces edits made there)"
                  />
                )}
                {run.error && (
                  <Text block style={{ color: tokens.colorPaletteRedForeground1, marginTop: 8 }}>
                    {run.error instanceof ApiError ? run.error.message : 'Populate failed.'}
                  </Text>
                )}
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              {warnings ? 'Close' : 'Cancel'}
            </Button>
            {!warnings && (
              <Button appearance="primary" disabled={!picked.size || run.isPending} onClick={() => run.mutate()}>
                {run.isPending ? 'Populating…' : `Populate ${picked.size || ''}`.trim()}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
