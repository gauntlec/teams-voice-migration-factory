import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router-dom';
import { Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';
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
