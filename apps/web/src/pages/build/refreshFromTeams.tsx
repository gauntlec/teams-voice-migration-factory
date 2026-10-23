import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Text } from '@fluentui/react-components';
import { api, ApiError } from '../../api';
import { DangerText } from '../../components/ui';

/**
 * Re-reads an auto attendant or call queue that was made from a discovered voice app from what Teams has now. Shown only for a row that
 * has a discovered voice app behind it. It replaces the row's settings, so it asks first.
 */
export function RefreshFromTeamsButton({
  base,
  kind,
  row,
  onDone,
}: {
  base: string;
  kind: 'auto-attendants' | 'call-queues';
  row: { id: string; name: string; discovery_voice_app_id?: string | null };
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useMutation({
    mutationFn: () => api(`${base}/${kind}/${row.id}/refresh`, { method: 'POST' }),
    onSuccess: () => {
      setOpen(false);
      setError(null);
      onDone();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Refresh failed'),
  });
  if (!row.discovery_voice_app_id) return <>—</>;
  return (
    <>
      <Button size="small" appearance="subtle" onClick={() => setOpen(true)}>
        Refresh from Teams
      </Button>
      <Dialog open={open} onOpenChange={(_, d) => !d.open && setOpen(false)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Refresh {row.name} from Teams?</DialogTitle>
            <DialogContent>
              <Text size={300} block>
                Its settings are read again from what Teams has now and replace what is saved here: call flows, schedules, targets{kind === 'call-queues' ? ', agents' : ''}. Anything you changed on this row in Design & Build is lost. Nothing is changed in Teams.
              </Text>
              {error && <DangerText>{error}</DangerText>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button appearance="primary" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
                {refresh.isPending ? 'Refreshing…' : 'Refresh'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
