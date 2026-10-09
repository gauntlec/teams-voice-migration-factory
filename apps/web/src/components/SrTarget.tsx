import { Badge, Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { srDuration, type SrClock } from '@tvmf/shared';

/**
 * Managed Services target badges and the queue summary strip - shared by a
 * customer's Service Requests list, the request page and the MSP queue. See
 * packages/shared/src/service-request-sla.ts for how the clocks work.
 */

/** "Due in 3h 10m" / "Overdue 2h" / "Paused" / "Met" ... */
export function SlaBadge({ clock, which }: { clock: SrClock; which?: 'response' | 'resolution' }) {
  const prefix = which === 'response' ? 'Reply ' : which === 'resolution' ? 'Finish ' : '';
  const due = clock.dueAt ? new Date(clock.dueAt).toLocaleString() : undefined;
  switch (clock.state) {
    case 'on_track':
      return (
        <Badge appearance="outline" color="informative" title={due && `Due ${due}`}>
          {prefix}
          {prefix ? 'in' : 'Due in'} {srDuration(clock.leftMs ?? 0)}
        </Badge>
      );
    case 'at_risk':
      return (
        <Badge appearance="tint" color="warning" title={due && `Due ${due}`}>
          {prefix}
          {prefix ? 'in' : 'Due in'} {srDuration(clock.leftMs ?? 0)}
        </Badge>
      );
    case 'overdue':
      return (
        <Badge appearance="filled" color="danger" title={due && `Was due ${due}`}>
          Overdue {srDuration(clock.leftMs ?? 0)}
        </Badge>
      );
    case 'paused':
      return (
        <Badge appearance="outline" color="subtle" title="Waiting on the customer - the clock is paused.">
          Paused
        </Badge>
      );
    case 'met':
      return (
        <Badge appearance="tint" color="success">
          Met
        </Badge>
      );
    case 'missed':
      return (
        <Badge appearance="tint" color="danger">
          Missed
        </Badge>
      );
    default:
      return <Text size={200}>—</Text>;
  }
}

const useStyles = makeStyles({
  tiles: { display: 'flex', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalM, marginBottom: tokens.spacingVerticalM },
  tile: {
    minWidth: '128px',
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXXS,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'default',
  },
  clickable: { cursor: 'pointer', ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover } },
  active: { ...shorthands.border('1px', 'solid', tokens.colorBrandStroke1) },
  value: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  danger: { color: tokens.colorPaletteRedForeground1 },
  warning: { color: tokens.colorPaletteMarigoldForeground1 },
});

export interface QueueItemForTiles {
  status: string;
  assigned_to?: string | null;
  waiting_since: string | null;
  sla: { clock: SrClock };
}

export type QueueFilter = 'all' | 'unassigned' | 'waiting' | 'at_risk' | 'overdue';

export function queueFilter(filter: QueueFilter) {
  return (i: QueueItemForTiles) => {
    switch (filter) {
      case 'unassigned':
        return !i.assigned_to;
      case 'waiting':
        return !!i.waiting_since;
      case 'at_risk':
        return i.sla.clock.state === 'at_risk';
      case 'overdue':
        return i.sla.clock.state === 'overdue';
      default:
        return true;
    }
  };
}

/** Open / Unassigned / Waiting on customer / At risk / Overdue - click one to filter the list. */
export function QueueTiles({ items, filter, onFilter }: { items: QueueItemForTiles[]; filter: QueueFilter; onFilter: (f: QueueFilter) => void }) {
  const s = useStyles();
  const count = (f: QueueFilter) => items.filter(queueFilter(f)).length;
  const tiles: { key: QueueFilter; label: string; tone?: 'danger' | 'warning' }[] = [
    { key: 'all', label: 'Open' },
    { key: 'unassigned', label: 'Unassigned' },
    { key: 'waiting', label: 'Waiting on customer' },
    { key: 'at_risk', label: 'At risk', tone: 'warning' },
    { key: 'overdue', label: 'Overdue', tone: 'danger' },
  ];
  return (
    <div className={s.tiles} role="group" aria-label="Queue summary">
      {tiles.map((t) => {
        const n = count(t.key);
        return (
          <button
            key={t.key}
            type="button"
            className={`${s.tile} ${s.clickable} ${filter === t.key ? s.active : ''}`}
            onClick={() => onFilter(filter === t.key ? 'all' : t.key)}
            aria-pressed={filter === t.key}
          >
            <Text size={200}>{t.label}</Text>
            <span className={`${s.value} ${n > 0 && t.tone ? s[t.tone] : ''}`}>{n}</span>
          </button>
        );
      })}
    </div>
  );
}
