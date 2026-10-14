import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Text, Textarea, makeStyles, tokens , mergeClasses } from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import { INC_REVIEW_SECTIONS, type IncReviewAction } from '@tvmf/shared';
import { api } from '../api';
import { errorText, when } from '../pages/ServiceRequests';

const useLocalStyles = makeStyles({
  w94vwMaxW780: { maxWidth: "780px", width: "94vw" },
  preWrap: { whiteSpace: "pre-wrap" },
  minW150: { minWidth: '150px' },
  mt8: { marginTop: '8px' },
});


const useStyles = makeStyles({
  card: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  row: { display: 'flex', columnGap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  error: { color: tokens.colorPaletteRedForeground1 },
  stack: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM, maxHeight: '68vh', overflowY: 'auto' },
  action: { display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) 1fr 150px auto', columnGap: tokens.spacingHorizontalS, alignItems: 'end' },
  event: { display: 'flex', columnGap: tokens.spacingHorizontalM },
});

export interface ReviewInfo {
  status: 'draft' | 'shared';
  shared_at: string | null;
  updated_at: string;
}

interface ReviewPayload {
  review: { status: 'draft' | 'shared'; summary: string; cause: string; went_well: string; went_badly: string; actions: IncReviewAction[]; shared_at: string | null; shared_by_name: string | null; created_by_name: string | null } | null;
  timeline: { kind: string; at: string; text: string; to_status: string | null; move: string | null }[];
  incident: { reference: string; title: string };
}

const MOVE_TEXT: Record<string, string> = { acknowledge: 'Acknowledged', hold: 'Put on hold', restore: 'Service restored', resolve: 'Resolved', close: 'Closed', reopen: 'Reopened', cancel: 'Cancelled', duplicate: 'Merged' };
const timelineText = (e: ReviewPayload['timeline'][number]) =>
  e.kind === 'created' ? 'Raised' : e.kind === 'status_changed' ? `${MOVE_TEXT[e.move ?? ''] ?? 'Moved on'}${e.text ? `: ${e.text}` : ''}` : e.kind === 'major_declared' ? `Declared a major incident: ${e.text}` : e.kind === 'major_update' ? `Update: ${e.text}` : e.kind === 'major_ended' ? 'Major incident ended' : e.kind === 'priority_changed' ? 'Priority changed' : e.text;

/**
 * The post-incident review: staff write it (what happened, why, what worked, what didn't, follow-up
 * actions) and share it; customers see it, and are emailed, once it is shared.
 */
export function IncidentReviewCard({ base, incident, review, staff, show }: { base: string; incident: { id: string; reference: string }; review: ReviewInfo | null; staff: boolean; show: boolean }) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  if (!staff && !review) return null;
  if (staff && !review && !show) return null;
  return (
    <Card className={s.card}>
      <div className={s.row}>
        <Text weight="semibold">Post-incident review</Text>
        {review && (
          <Badge appearance="tint" color={review.status === 'shared' ? 'success' : 'warning'}>
            {review.status === 'shared' ? 'Shared with the customer' : 'Draft - the customer can\'t see it yet'}
          </Badge>
        )}
      </div>
      {!review ? (
        <Text size={200} className={s.muted}>
          What happened, why, what worked and what didn&apos;t, and what we&apos;re changing. Worth doing for every major incident.
        </Text>
      ) : (
        <Text size={200} className={s.muted}>
          {review.status === 'shared' && review.shared_at ? `Shared ${when(review.shared_at)}.` : `Last saved ${when(review.updated_at)}.`}
        </Text>
      )}
      <div>
        <Button appearance={review ? 'secondary' : 'primary'} onClick={() => setOpen(true)}>
          {staff ? (review ? 'Open the review' : 'Write the review') : 'Read the review'}
        </Button>
      </div>
      {open && <ReviewDialog base={base} incident={incident} staff={staff} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function ReviewDialog({ base, incident, staff, onClose }: { base: string; incident: { id: string; reference: string }; staff: boolean; onClose: () => void }) {
  const ls = useLocalStyles();
  const s = useStyles();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['incident-review', base, incident.id], queryFn: () => api<ReviewPayload>(`${base}/${incident.id}/review`) });
  const [f, setF] = useState({ summary: '', cause: '', wentWell: '', wentBadly: '', actions: [] as IncReviewAction[] });
  useEffect(() => {
    const r = q.data?.review;
    if (r) setF({ summary: r.summary, cause: r.cause, wentWell: r.went_well, wentBadly: r.went_badly, actions: r.actions });
  }, [q.data]);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['incident-review', base, incident.id] });
    qc.invalidateQueries({ queryKey: ['incident', base, incident.id] });
  };
  const save = useMutation({ mutationFn: () => api(`${base}/${incident.id}/review`, { method: 'PUT', body: JSON.stringify(f) }), onSuccess: refresh });
  const share = useMutation({
    mutationFn: async () => {
      await api(`${base}/${incident.id}/review`, { method: 'PUT', body: JSON.stringify(f) });
      return api(`${base}/${incident.id}/review/share`, { method: 'POST' });
    },
    onSuccess: refresh,
  });
  const r = q.data?.review;
  const shared = r?.status === 'shared';
  const editable = staff && !shared;
  const values: Record<string, string> = { summary: f.summary, cause: f.cause, went_well: f.wentWell, went_badly: f.wentBadly };
  const setValue = (key: string, v: string) => setF((p) => ({ ...p, ...(key === 'summary' ? { summary: v } : key === 'cause' ? { cause: v } : key === 'went_well' ? { wentWell: v } : { wentBadly: v }) }));
  const setAction = (i: number, patch: Partial<IncReviewAction>) => setF((p) => ({ ...p, actions: p.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) }));
  const error = save.error ?? share.error;

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={ls.w94vwMaxW780}>
        <DialogBody>
          <DialogTitle>Post-incident review · {incident.reference}</DialogTitle>
          <DialogContent className={s.stack}>
            {q.isLoading && <Text>Loading…</Text>}
            {q.data && (
              <>
                {shared && <Text size={200}>Shared with the customer {r?.shared_at ? when(r.shared_at) : ''}{r?.shared_by_name ? ` by ${r.shared_by_name}` : ''}.</Text>}
                {INC_REVIEW_SECTIONS.map((sec) => (
                  <Field key={sec.key} label={sec.label} hint={editable ? sec.help : undefined}>
                    {editable ? (
                      <Textarea value={values[sec.key]} maxLength={4000} rows={3} resize="vertical" onChange={(_, d) => setValue(sec.key, d.value)} />
                    ) : (
                      <Text className={ls.preWrap}>{values[sec.key] || '—'}</Text>
                    )}
                  </Field>
                ))}
                <div>
                  <Text weight="semibold">What happened, in order</Text>
                  {q.data.timeline.map((e, i) => (
                    <div key={i} className={s.event}>
                      <Text size={200} className={mergeClasses(s.muted, ls.minW150)}>
                        {when(e.at)}
                      </Text>
                      <Text size={200}>{timelineText(e)}</Text>
                    </div>
                  ))}
                </div>
                <div>
                  <Text weight="semibold">What we&apos;re doing about it</Text>
                  {f.actions.length === 0 && <Text size={200} block>{editable ? 'No actions yet.' : 'None.'}</Text>}
                  {f.actions.map((a, i) =>
                    editable ? (
                      <div key={i} className={mergeClasses(s.action, ls.mt8)}>
                        <Field label={i === 0 ? 'Action' : undefined}>
                          <Input value={a.text} maxLength={300} onChange={(_, d) => setAction(i, { text: d.value })} />
                        </Field>
                        <Field label={i === 0 ? 'Owner' : undefined}>
                          <Input value={a.owner ?? ''} maxLength={120} onChange={(_, d) => setAction(i, { owner: d.value || undefined })} />
                        </Field>
                        <Field label={i === 0 ? 'By' : undefined}>
                          <Input type="date" value={a.due ?? ''} onChange={(_, d) => setAction(i, { due: d.value || undefined })} />
                        </Field>
                        <Button appearance="subtle" icon={<DeleteRegular />} aria-label="Remove this action" onClick={() => setF((p) => ({ ...p, actions: p.actions.filter((_, j) => j !== i) }))} />
                      </div>
                    ) : (
                      <Text key={i} block>
                        • {a.text}
                        {a.owner || a.due ? ` (${[a.owner, a.due && `by ${a.due}`].filter(Boolean).join(', ')})` : ''}
                      </Text>
                    ),
                  )}
                  {editable && (
                    <div className={ls.mt8}>
                      <Button size="small" disabled={f.actions.length >= 20} onClick={() => setF((p) => ({ ...p, actions: [...p.actions, { text: '' }] }))}>
                        Add an action
                      </Button>
                    </div>
                  )}
                </div>
                {error && <Text className={s.error}>{errorText(error, 'That did not work')}</Text>}
              </>
            )}
            {q.isError && <Text className={s.error}>{errorText(q.error, 'Could not open the review')}</Text>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Close
            </Button>
            {editable && (
              <>
                <Button disabled={save.isPending || f.actions.some((a) => !a.text.trim())} onClick={() => save.mutate()}>
                  {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved' : 'Save draft'}
                </Button>
                <Button
                  appearance="primary"
                  title="Makes it visible to the customer and emails the reporter, followers and named contacts"
                  disabled={share.isPending || !f.summary.trim() || !f.cause.trim() || f.actions.some((a) => !a.text.trim())}
                  onClick={() => window.confirm('Share this review with the customer? They will be emailed it.') && share.mutate()}
                >
                  Share with the customer
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
