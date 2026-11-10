import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Text } from '@fluentui/react-components';
import { Dialog } from '../../components/AppDialog';
import { ArrowSyncRegular } from '@fluentui/react-icons';
import { api, ApiError } from '../../api';
import { DangerText } from '../../components/ui';
import { useNotify } from '../../hooks/useNotify';

interface CopyResult {
  copied: { name: string; flowId: string; added: boolean }[];
  skipped: { name: string; reason: string }[];
  notes: string[];
}

/**
 * "Copy to Site Data" (bug report "Site Data Sync Back for Auto Attendants and Call Queues"): writes one Design & Build auto
 * attendant or call queue - or every one on the site - back to Site Data's Call flows as the wizard's answers, so Site Data shows
 * what is being built. Asks first, because it replaces the Call flows row's answers; nothing is changed in Teams.
 */
export function CopyToSiteDataButton({
  base,
  kind,
  siteId,
  row,
  onDone,
}: {
  base: string;
  kind: 'auto-attendants' | 'call-queues';
  siteId: string;
  /** one row; omitted = every one on the site */
  row?: { id: string; name: string };
  onDone: () => void;
}) {
  const notify = useNotify();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CopyResult | null>(null);
  const noun = kind === 'auto-attendants' ? 'auto attendant' : 'call queue';
  const copy = useMutation({
    mutationFn: () =>
      api<CopyResult>(`${base}/${kind}/copy-to-site-data`, {
        method: 'POST',
        body: JSON.stringify(row ? { ids: [row.id] } : { site_id: siteId, all: true }),
      }),
    onSuccess: (r) => {
      setError(null);
      onDone();
      const n = r.copied.length;
      if (!r.skipped.length && !r.notes.length) {
        setOpen(false);
        notify(`Copied ${n === 1 ? r.copied[0]!.name : `${n} ${noun}s`} to Site Data`);
      } else setResult(r);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Copy failed'),
  });
  const close = () => {
    setOpen(false);
    setResult(null);
    setError(null);
  };
  return (
    <>
      <Button size="small" appearance="subtle" icon={row ? undefined : <ArrowSyncRegular />} onClick={() => setOpen(true)}>
        {row ? 'Copy to Site Data' : 'Copy all to Site Data'}
      </Button>
      <Dialog open={open} onOpenChange={(_, d) => !d.open && close()}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{result ? 'Copied to Site Data' : row ? `Copy ${row.name} to Site Data?` : `Copy every ${noun} to Site Data?`}</DialogTitle>
            <DialogContent>
              {result ? (
                <>
                  <Text size={300} block>
                    {result.copied.length} copied{result.skipped.length ? `, ${result.skipped.length} not copied` : ''}.
                  </Text>
                  {result.skipped.map((s) => (
                    <Text key={s.name} size={200} block>
                      Not copied: {s.name} - {s.reason}
                    </Text>
                  ))}
                  {result.notes.length > 0 && (
                    <Text size={200} block>
                      Kept in Design & Build only (the wizard cannot show these): {result.notes.join(' ')}
                    </Text>
                  )}
                </>
              ) : (
                <Text size={300} block>
                  {row ? `Its settings` : `The settings of every ${noun} on this site`} replace the call flow Site Data's Auto attendants & call queues tab has for {row ? 'it' : 'them'}, so
                  the wizard shows what is being built. A {noun} with no call flow in Site Data gets one. Nothing is changed in Teams.
                </Text>
              )}
              {error && <DangerText>{error}</DangerText>}
            </DialogContent>
            <DialogActions>
              {result ? (
                <Button appearance="primary" onClick={close}>
                  Done
                </Button>
              ) : (
                <>
                  <Button appearance="secondary" onClick={close}>
                    Cancel
                  </Button>
                  <Button appearance="primary" disabled={copy.isPending} onClick={() => copy.mutate()}>
                    {copy.isPending ? 'Copying…' : 'Copy'}
                  </Button>
                </>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
