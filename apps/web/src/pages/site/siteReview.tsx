import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Spinner,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  shorthands,
} from '@fluentui/react-components';
import type { DiscoveryStatus } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { DataTable } from '../../components/DataTable';
import { ReviewStatusBadge } from '../../components/ReviewStatusBadge';
import { LoadError, useRecordStyles } from '../../components/records';
import { DangerText } from '../../components/ui';

const useStyles = makeStyles({
  bar: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', ...shorthands.gap('10px') },
  scroll: { maxHeight: '36vh', overflowY: 'auto' },
});

export interface SiteReview {
  status: DiscoveryStatus;
  submitted_at: string | null;
  accepted_at: string | null;
}

interface SiteChange {
  id: string;
  changed_at: string;
  actor_name: string | null;
  entity: string;
  entity_label: string | null;
  action: 'added' | 'changed' | 'removed';
  detail: string | null;
}

const ACTION_COLOR = { added: 'success', changed: 'warning', removed: 'danger' } as const;

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * A site's Site Data review: its status and the buttons to move it on. Nothing is locked, so people can keep
 * adding and changing data after it is submitted; those changes are listed for the engineer in SiteChangesCard.
 */
export function SiteReviewBar({
  base,
  siteId,
  review,
  pendingChanges,
  canWrite,
  canReview,
  onChanged,
}: {
  base: string;
  siteId: string;
  review: SiteReview;
  pendingChanges: number;
  canWrite: boolean;
  canReview: boolean;
  onChanged: () => void;
}) {
  const s = useStyles();
  const act = useMutation({
    mutationFn: (verb: 'submit' | 'accept' | 'reopen') => api(`${base}/sites/${siteId}/${verb}`, { method: 'POST' }),
    onSuccess: onChanged,
  });
  const { status } = review;

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div className={s.bar}>
        <Text size={200}>Review:</Text>
        <ReviewStatusBadge status={status} pendingChanges={canReview ? pendingChanges : 0} />
        {status === 'draft' && canWrite && (
          <Button size="small" appearance="primary" disabled={act.isPending} onClick={() => act.mutate('submit')}>
            Submit for review
          </Button>
        )}
        {status === 'submitted' && canReview && (
          <Button size="small" appearance="primary" disabled={act.isPending} onClick={() => act.mutate('accept')}>
            Accept
          </Button>
        )}
        {status !== 'draft' && canReview && (
          <Button size="small" disabled={act.isPending} onClick={() => act.mutate('reopen')}>
            Reopen
          </Button>
        )}
      </div>
      {status !== 'draft' && (
        <Text size={200} style={{ opacity: 0.75 }}>
          {status === 'accepted' ? 'Accepted' : 'Submitted'}
          {review.submitted_at ? ` (submitted ${when(review.submitted_at)})` : ''}. Nothing is locked: you can keep making changes, and
          anything changed from now on is listed for the engineer.
        </Text>
      )}
      {act.isError && <DangerText>{act.error instanceof ApiError ? act.error.message : 'That did not work.'}</DangerText>}
    </div>
  );
}

/** For the engineer: what changed on this site since it was submitted, until they mark it as reviewed. */
export function SiteChangesCard({ base, siteId, onChanged }: { base: string; siteId: string; onChanged: () => void }) {
  const s = useStyles();
  const rs = useRecordStyles();
  const qc = useQueryClient();
  const key = ['site-changes', base, siteId];
  const list = useQuery({ queryKey: key, queryFn: () => api<{ items: SiteChange[]; total: number }>(`${base}/sites/${siteId}/changes`) });
  const ack = useMutation({
    mutationFn: () => api(`${base}/sites/${siteId}/changes/acknowledge`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      onChanged();
    },
  });

  return (
    <Card className={rs.card}>
      <div className={rs.cardHead}>
        <div>
          <Text weight="semibold">Changed since submitted</Text>
          <Text size={200} className={rs.muted} block>
            These changes were made after this site was submitted for review. Mark them as reviewed once you have dealt with them.
          </Text>
        </div>
        <Button size="small" appearance="primary" disabled={ack.isPending || (list.data?.total ?? 0) === 0} onClick={() => ack.mutate()}>
          {ack.isPending ? <Spinner size="tiny" /> : 'Mark as reviewed'}
        </Button>
      </div>
      {list.isLoading ? (
        <Spinner size="tiny" />
      ) : list.isError ? (
        <LoadError message={(list.error as Error).message} />
      ) : (
        <div className={s.scroll}>
          <DataTable size="small" minWidth={640}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>When</TableHeaderCell>
                <TableHeaderCell>Who</TableHeaderCell>
                <TableHeaderCell>What</TableHeaderCell>
                <TableHeaderCell>Change</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data?.items ?? []).map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{when(c.changed_at)}</TableCell>
                  <TableCell>{c.actor_name ?? '—'}</TableCell>
                  <TableCell>
                    {c.entity}
                    {c.entity_label ? `: ${c.entity_label}` : ''}
                  </TableCell>
                  <TableCell>
                    <Badge appearance="tint" size="small" color={ACTION_COLOR[c.action]}>
                      {c.action}
                    </Badge>
                    {c.detail ? ` ${c.detail}` : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
          {(list.data?.total ?? 0) > (list.data?.items.length ?? 0) && (
            <Text size={200} className={rs.muted}>
              Showing the newest {list.data?.items.length} of {list.data?.total}.
            </Text>
          )}
        </div>
      )}
    </Card>
  );
}
