import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router-dom';
import { useState } from 'react';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Select, Spinner, Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { WarningRegular } from '@fluentui/react-icons';
import { api } from '../api';
import { useAuth } from '../auth';

const useStyles = makeStyles({
  notice: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalS,
    alignItems: 'flex-start',
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.border('1px', 'solid', tokens.colorPaletteRedBorder1),
    backgroundColor: tokens.colorPaletteRedBackground1,
  },
  list: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS },
});

interface Notice {
  id: string;
  reference: string;
  title: string;
  sitecode: string | null;
  declared_at: string | null;
  next_update_due_at: string | null;
  latest_update: { body: string | null; at: string } | null;
  can_open: boolean;
}

/** "We're aware of a problem": live major incidents, as the customer is told about them. Nothing renders when there are none. */
export function IncidentNotices({ base, enabled }: { base: string; enabled: boolean }) {
  const s = useStyles();
  const { activeTenantId } = useAuth();
  const q = useQuery({ queryKey: ['incident-notices', activeTenantId], enabled: enabled && !!activeTenantId, refetchInterval: 60_000, queryFn: () => api<Notice[]>(`${base}/notices`) });
  const notices = q.data ?? [];
  if (notices.length === 0) return null;
  return (
    <div className={s.list} role="region" aria-label="Service notices">
      {notices.map((n) => (
        <div key={n.id} className={s.notice} role="alert">
          <WarningRegular fontSize={24} />
          <div>
            <Text weight="semibold" block>
              We&apos;re aware of a problem{n.sitecode ? ` at ${n.sitecode}` : ' affecting all sites'}: {n.title}
            </Text>
            {n.latest_update?.body && (
              <Text block style={{ whiteSpace: 'pre-wrap' }}>
                {n.latest_update.body}
              </Text>
            )}
            <Text size={200} block>
              {n.latest_update ? `Updated ${new Date(n.latest_update.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. ` : ''}
              {n.next_update_due_at ? `Next update by ${new Date(n.next_update_due_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. ` : ''}
              {n.can_open && <RouterLink to={`/incidents/${n.id}`}>{n.reference} - follow it</RouterLink>}
            </Text>
          </div>
        </div>
      ))}
    </div>
  );
}

interface PastNotice {
  id: string;
  reference: string;
  title: string;
  sitecode: string | null;
  declared_at: string | null;
  ended_at: string | null;
  minutes: number | null;
  outcome: string | null;
  can_open: boolean;
}

const duration = (m: number | null) => (m === null ? '' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`);

/** The notices that have ended, for looking back: what the customer was told, where, for how long, and how it ended. */
export function PastNoticesDialog({ base, enabled, onClose }: { base: string; enabled: boolean; onClose: () => void }) {
  const [days, setDays] = useState('90');
  const q = useQuery({ queryKey: ['incident-notice-history', base, days], enabled, queryFn: () => api<PastNotice[]>(`${base}/notices/history?days=${days}`) });
  return (
    <>
      {(
        <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
          <DialogSurface style={{ maxWidth: '720px', width: '94vw' }}>
            <DialogBody>
              <DialogTitle>Past service notices</DialogTitle>
              <DialogContent style={{ display: 'flex', flexDirection: 'column', rowGap: 12, maxHeight: '70vh', overflowY: 'auto' }}>
                <Select value={days} onChange={(_, d) => setDays(d.value)} aria-label="How far back">
                  <option value="30">Last 30 days</option>
                  <option value="90">Last 90 days</option>
                  <option value="365">Last year</option>
                </Select>
                {q.isLoading && <Spinner size="tiny" />}
                {q.data?.length === 0 && <Text>No service notices in this time.</Text>}
                {q.data?.map((n) => (
                  <div key={n.id} style={{ display: 'flex', flexDirection: 'column', rowGap: 2, paddingBottom: 8, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
                    <Text weight="semibold">
                      {n.title}
                      {n.sitecode ? ` · ${n.sitecode}` : ' · all sites'}
                    </Text>
                    <Text size={200}>
                      {n.declared_at ? new Date(n.declared_at).toLocaleString() : ''}
                      {n.minutes !== null ? ` · lasted ${duration(n.minutes)}` : ''}
                      {n.can_open && (
                        <>
                          {' · '}
                          <RouterLink to={`/incidents/${n.id}`}>{n.reference}</RouterLink>
                        </>
                      )}
                    </Text>
                    {n.outcome && (
                      <Text size={200} style={{ whiteSpace: 'pre-wrap' }}>
                        {n.outcome}
                      </Text>
                    )}
                  </div>
                ))}
              </DialogContent>
              <DialogActions>
                <Button appearance="primary" onClick={onClose}>
                  Close
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </>
  );
}
