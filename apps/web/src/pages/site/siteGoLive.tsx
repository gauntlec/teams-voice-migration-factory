import { useQuery } from '@tanstack/react-query';
import { Button, Text, makeStyles, shorthands } from '@fluentui/react-components';
import { CalendarLtrRegular } from '@fluentui/react-icons';
import { goLiveDateLabel } from '@tvmf/shared';
import { api } from '../../api';

interface GoLive {
  siteId: string;
  targetGoLive: string | null;
  firstGoLive: string | null;
  changedAt: string | null;
}

const useStyles = makeStyles({
  line: { display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', ...shorthands.gap('6px') },
  muted: { opacity: 0.75 },
});

export const goLiveQueryKey = (tenantId: string, siteId: string) => ['go-live', tenantId, siteId];

/**
 * A site's go-live date beside its number summary: the Target go-live field of the site's Overview, and the date first
 * agreed when it has moved (docs/INSIGHTS.md). The date is set in the Overview tab; `onChange` opens it.
 */
export function SiteGoLive({ tenantId, siteId, onChange }: { tenantId: string; siteId: string; onChange?: () => void }) {
  const s = useStyles();
  const q = useQuery({ queryKey: goLiveQueryKey(tenantId, siteId), queryFn: () => api<GoLive>(`/t/${tenantId}/insights/sites/${siteId}/go-live`) });
  if (!q.data) return null;
  const { targetGoLive, firstGoLive } = q.data;
  const moved = targetGoLive && firstGoLive && firstGoLive !== targetGoLive;
  return (
    <span className={s.line}>
      <Text size={200}>
        Go-live: <b>{targetGoLive ? goLiveDateLabel(targetGoLive) : 'not set'}</b>
      </Text>
      {moved && (
        <Text size={200} className={s.muted}>
          (first agreed {goLiveDateLabel(firstGoLive)})
        </Text>
      )}
      {onChange && (
        <Button size="small" appearance="transparent" icon={<CalendarLtrRegular />} onClick={onChange}>
          {targetGoLive ? 'Change' : 'Set date'}
        </Button>
      )}
    </span>
  );
}
