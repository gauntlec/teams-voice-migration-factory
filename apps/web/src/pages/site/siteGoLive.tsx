import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Text,
  Textarea,
  makeStyles,
  shorthands,
} from '@fluentui/react-components';
import { CalendarLtrRegular } from '@fluentui/react-icons';
import { goLiveDateLabel } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { useNotify } from '../../hooks/useNotify';
import { DangerText } from '../../components/ui';

interface GoLive {
  siteId: string;
  targetGoLive: string | null;
  firstGoLive: string | null;
  changedAt: string | null;
}

const useStyles = makeStyles({
  line: { display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', ...shorthands.gap('6px') },
  muted: { opacity: 0.75 },
  form: { display: 'grid', ...shorthands.gap('12px') },
});

/**
 * A site's target go-live date (docs/INSIGHTS.md): shown to everyone who can open the site, set by project managers,
 * engineers and admins. Insights uses it to say whether the site is on track. Setting it is not a Site Data change.
 */
export function SiteGoLive({ tenantId, siteId, canEdit }: { tenantId: string; siteId: string; canEdit: boolean }) {
  const s = useStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  const path = `/t/${tenantId}/insights/sites/${siteId}/go-live`;
  const q = useQuery({ queryKey: ['go-live', tenantId, siteId], queryFn: () => api<GoLive>(path) });
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');

  const current = q.data?.targetGoLive ?? null;
  useEffect(() => {
    if (open) {
      setDate(current ?? '');
      setReason('');
    }
  }, [open, current]);

  const save = useMutation({
    mutationFn: (targetGoLive: string | null) =>
      api<GoLive>(path, { method: 'PUT', body: JSON.stringify({ targetGoLive, ...(reason.trim() ? { reason: reason.trim() } : {}) }) }),
    onSuccess: (r) => {
      qc.setQueryData(['go-live', tenantId, siteId], r);
      void qc.invalidateQueries({ queryKey: ['insights', tenantId] });
      setOpen(false);
      notify(r.targetGoLive ? `Go-live set to ${goLiveDateLabel(r.targetGoLive)}` : 'Go-live date cleared');
    },
  });

  if (!q.data) return null;
  const moved = current && q.data.firstGoLive && q.data.firstGoLive !== current;
  const changing = !!current && date !== current;

  return (
    <>
      <span className={s.line}>
        <Text size={200}>
          Go-live: <b>{current ? goLiveDateLabel(current) : 'not set'}</b>
        </Text>
        {moved && (
          <Text size={200} className={s.muted}>
            (first agreed {goLiveDateLabel(q.data.firstGoLive!)})
          </Text>
        )}
        {canEdit && (
          <Button size="small" appearance="transparent" icon={<CalendarLtrRegular />} onClick={() => setOpen(true)}>
            {current ? 'Change' : 'Set date'}
          </Button>
        )}
      </span>
      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (date) save.mutate(date);
            }}
          >
            <DialogBody>
              <DialogTitle>Go-live date</DialogTitle>
              <DialogContent className={s.form}>
                <Text>
                  The date this site is planned to go live on Teams Phone. Voxshift uses it to show whether the site is on track. The first
                  date you set is kept, so a moved date shows what was agreed.
                </Text>
                <Field label="Target go-live date" required>
                  <Input type="date" value={date} onChange={(_, d) => setDate(d.value)} />
                </Field>
                {changing && (
                  <Field label="Why is the date moving? (optional)" hint="Recorded in the audit log.">
                    <Textarea value={reason} maxLength={500} onChange={(_, d) => setReason(d.value)} />
                  </Field>
                )}
                {save.isError && <DangerText>{save.error instanceof ApiError ? save.error.message : 'The date was not saved.'}</DangerText>}
              </DialogContent>
              <DialogActions>
                {current && (
                  <Button appearance="subtle" disabled={save.isPending} onClick={() => save.mutate(null)}>
                    Clear date
                  </Button>
                )}
                <Button onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" appearance="primary" disabled={!date || date === current || save.isPending}>
                  Save
                </Button>
              </DialogActions>
            </DialogBody>
          </form>
        </DialogSurface>
      </Dialog>
    </>
  );
}
