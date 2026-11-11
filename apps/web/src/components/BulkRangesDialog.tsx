import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Select, Text, makeStyles, tokens } from '@fluentui/react-components';
import { NUMBER_RANGE_KIND_LABELS, NUMBER_RANGE_KINDS, type NumberRangeKind } from '@tvmf/shared';
import { api, ApiError } from '../api';
import { Dialog } from './AppDialog';
import { DangerText } from './ui';

const useStyles = makeStyles({
  stack: { display: 'grid', rowGap: tokens.spacingVerticalM },
  errors: { margin: 0, paddingLeft: tokens.spacingHorizontalL, maxHeight: '160px', overflowY: 'auto' },
});

type Result = { updated: number; errors: { id: string; range: string | null; message: string }[] };

/**
 * The same change to every ticked number range (bug report "Number Range Import from Excel"): Number transition, carrier, new carrier.
 * Anything left as "Leave as it is" (or blank) isn't changed. Each range is checked as editing it alone would be, so a port still needs
 * its new carrier; ranges that can't change are listed and the rest still change.
 */
export function BulkRangesDialog({ base, ids, onClose, onDone }: { base: string; ids: string[]; onClose: () => void; onDone: () => void }) {
  const s = useStyles();
  const [kind, setKind] = useState<NumberRangeKind | ''>('');
  const [carrier, setCarrier] = useState('');
  const [newCarrier, setNewCarrier] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const body = {
    ids,
    ...(kind ? { kind } : {}),
    ...(carrier.trim() ? { carrier: carrier.trim() } : {}),
    ...(newCarrier.trim() ? { new_carrier: newCarrier.trim() } : {}),
  };
  const nothing = Object.keys(body).length === 1;
  const save = useMutation({
    mutationFn: () => api<Result>(`${base}/number-ranges/bulk-update`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (r) => {
      onDone();
      if (r.errors.length === 0) onClose();
      else setResult(r);
    },
  });
  const plural = ids.length === 1 ? 'range' : 'ranges';
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            Change {ids.length} {plural}
          </DialogTitle>
          <DialogContent className={s.stack}>
            {result ? (
              <>
                <Text>
                  {result.updated} changed. {result.errors.length} couldn&apos;t be:
                </Text>
                <ul className={s.errors}>
                  {result.errors.map((e) => (
                    <li key={e.id}>
                      {e.range ?? 'A range'}: {e.message}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <Text size={200}>Set what should change on every one of them. Anything left blank stays as it is.</Text>
                <Field label="Number transition">
                  <Select value={kind} onChange={(_, d) => setKind(d.value as NumberRangeKind | '')}>
                    <option value="">Leave as it is</option>
                    {NUMBER_RANGE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {NUMBER_RANGE_KIND_LABELS[k]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Carrier (where the numbers are now)">
                  <Input value={carrier} maxLength={160} placeholder="Leave blank to keep each range's own" onChange={(_, d) => setCarrier(d.value)} />
                </Field>
                <Field label="New carrier (port: where they are moving to)" hint={kind === 'port' ? "A port needs one: ranges without one already won't change unless it's given here." : undefined}>
                  <Input value={newCarrier} maxLength={160} placeholder="Leave blank to keep each range's own" onChange={(_, d) => setNewCarrier(d.value)} />
                </Field>
                {save.isError && <DangerText>{save.error instanceof ApiError ? save.error.message : 'The ranges were not changed.'}</DangerText>}
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              {result ? 'Close' : 'Cancel'}
            </Button>
            {!result && (
              <Button appearance="primary" disabled={nothing || save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? 'Changing…' : `Change ${ids.length} ${plural}`}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
