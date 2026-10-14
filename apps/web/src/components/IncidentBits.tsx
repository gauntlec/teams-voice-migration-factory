import { Badge, Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import {
  INC_HOLD_CUSTOMER_LABELS,
  INC_HOLD_LABELS,
  INC_PRIORITY_LABELS,
  INC_STATUS_CUSTOMER_LABELS,
  INC_STATUS_LABELS,
  srDuration,
  type IncClock,
  type IncMajorClock,
  type IncHoldReason,
  type IncImpact,
  type IncPriority,
  type IncStatus,
  type IncUrgency,
} from '@tvmf/shared';

/**
 * Incident badges, summary tiles and the row/payload types shared by the
 * Incidents list, the raise form and the incident page. The rules themselves
 * (priority, status moves, clocks) live in packages/shared/src/incidents.ts.
 */

export interface IncidentRow {
  id: string;
  number: number;
  reference: string;
  title: string;
  category: string;
  subcategory: string | null;
  category_label: string;
  priority: IncPriority;
  status: IncStatus;
  hold_reason: IncHoldReason | null;
  impact: IncImpact;
  urgency: IncUrgency;
  site_id: string | null;
  sitecode: string | null;
  reporter_id: string;
  reporter_name: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  assigned_agent_id: string | null;
  created_at: string;
  updated_at: string;
  acknowledged_at: string | null;
  /** The clock that matters now: response, then restoration, then resolution. */
  sla: { which: 'response' | 'restoration' | 'resolution'; clock: IncClock };
  /** A major incident (declared; check major_clock / major_ended_at for whether it is still live). */
  major?: boolean;
  major_ended_at?: string | null;
  parent_id?: string | null;
  /** The cadence of customer updates on a live major incident. */
  major_clock?: IncMajorClock;
}

export const INC_STATUS_COLOR: Record<IncStatus, 'informative' | 'brand' | 'warning' | 'success' | 'subtle' | 'danger'> = {
  new: 'informative',
  in_progress: 'brand',
  on_hold: 'warning',
  restored: 'success',
  resolved: 'success',
  closed: 'subtle',
  cancelled: 'subtle',
  duplicate: 'subtle',
};

const PRIORITY_COLOR: Record<IncPriority, 'danger' | 'severe' | 'warning' | 'informative'> = {
  p1: 'danger',
  p2: 'severe',
  p3: 'warning',
  p4: 'informative',
};

export function PriorityBadge({ priority, staff = true }: { priority: IncPriority; staff?: boolean }) {
  // Customers get plain words; the team gets P1-P4.
  const label = staff ? INC_PRIORITY_LABELS[priority] : INC_PRIORITY_LABELS[priority].replace(/^P\d /, '');
  return (
    <Badge appearance={priority === 'p1' ? 'filled' : 'tint'} color={PRIORITY_COLOR[priority]}>
      {label}
    </Badge>
  );
}

/** Status, with what it is on hold for when it is. */
export function IncStatusBadge({ status, hold, staff }: { status: IncStatus; hold: IncHoldReason | null; staff: boolean }) {
  return (
    <>
      <Badge appearance="tint" color={INC_STATUS_COLOR[status]}>
        {(staff ? INC_STATUS_LABELS : INC_STATUS_CUSTOMER_LABELS)[status]}
      </Badge>
      {status === 'on_hold' && hold && (
        <Badge appearance="outline" color="warning" style={{ marginLeft: 4 }}>
          {(staff ? INC_HOLD_LABELS : INC_HOLD_CUSTOMER_LABELS)[hold]}
        </Badge>
      )}
    </>
  );
}

const WHICH_PREFIX = { response: 'Reply', restoration: 'Restore', resolution: 'Resolve' } as const;

/** "Reply in 12m" / "Overdue 2h" / "Paused" / "Met" ... */
export function IncSlaBadge({ clock, which }: { clock: IncClock; which?: keyof typeof WHICH_PREFIX }) {
  const prefix = which ? `${WHICH_PREFIX[which]} ` : '';
  const due = clock.dueAt ? new Date(clock.dueAt).toLocaleString() : undefined;
  switch (clock.state) {
    case 'on_track':
      return (
        <Badge appearance="outline" color="informative" title={due && `Due ${due}`}>
          {prefix ? `${prefix}in` : 'Due in'} {srDuration(clock.leftMs ?? 0)}
        </Badge>
      );
    case 'at_risk':
      return (
        <Badge appearance="tint" color="warning" title={due && `Due ${due}`}>
          {prefix ? `${prefix}in` : 'Due in'} {srDuration(clock.leftMs ?? 0)}
        </Badge>
      );
    case 'overdue':
      return (
        <Badge appearance="filled" color="danger" title={due && `Was due ${due}`}>
          {prefix}Overdue {srDuration(clock.leftMs ?? 0)}
        </Badge>
      );
    case 'paused':
      return (
        <Badge appearance="outline" color="subtle" title="The incident is on hold - the clock is paused.">
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
    case 'none':
      return <Text size={200}>No target</Text>;
    default:
      return <Text size={200}>—</Text>;
  }
}

const useStyles = makeStyles({
  tiles: { display: 'flex', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalM },
  tile: {
    minWidth: '128px',
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXXS,
    cursor: 'pointer',
    textAlign: 'left',
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  active: { ...shorthands.border('1px', 'solid', tokens.colorBrandStroke1) },
  value: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  danger: { color: tokens.colorPaletteRedForeground1 },
  warning: { color: tokens.colorPaletteMarigoldForeground1 },
});

export type IncQueueFilter = 'all' | 'new' | 'unassigned' | 'on_hold' | 'at_risk' | 'overdue';

/** What the queue tiles need from a row - shared by a customer's list and the MSP console. */
export interface IncQueueRow {
  status: IncStatus;
  assigned_to: string | null;
  assigned_agent_id: string | null;
  sla: { clock: IncClock };
}

const OPEN: readonly IncStatus[] = ['new', 'in_progress', 'on_hold', 'restored'];

/** Which rows a queue tile counts and filters to. */
export function incQueueFilter(f: IncQueueFilter) {
  return (i: IncQueueRow) => {
    if (f === 'all') return true;
    if (!OPEN.includes(i.status)) return false;
    switch (f) {
      case 'new':
        return i.status === 'new';
      case 'unassigned':
        return !i.assigned_to && !i.assigned_agent_id;
      case 'on_hold':
        return i.status === 'on_hold';
      case 'at_risk':
        return i.sla.clock.state === 'at_risk';
      case 'overdue':
        return i.sla.clock.state === 'overdue';
    }
  };
}

/** Open / Not acknowledged / Unassigned / On hold / At risk / Overdue - click one to filter the list. */
export function IncQueueTiles({ items, filter, onFilter }: { items: IncQueueRow[]; filter: IncQueueFilter; onFilter: (f: IncQueueFilter) => void }) {
  const s = useStyles();
  const tiles: { key: IncQueueFilter; label: string; tone?: 'danger' | 'warning' }[] = [
    { key: 'all', label: 'Open' },
    { key: 'new', label: 'Not acknowledged', tone: 'warning' },
    { key: 'unassigned', label: 'Unassigned' },
    { key: 'on_hold', label: 'On hold' },
    { key: 'at_risk', label: 'At risk', tone: 'warning' },
    { key: 'overdue', label: 'Overdue', tone: 'danger' },
  ];
  return (
    <div className={s.tiles} role="group" aria-label="Queue summary">
      {tiles.map((t) => {
        // "Open" counts what needs the team's work, not incidents waiting for the customer to confirm.
        const n = items.filter(t.key === 'all' ? (i) => OPEN.includes(i.status) : incQueueFilter(t.key)).length;
        return (
          <button
            key={t.key}
            type="button"
            className={`${s.tile} ${filter === t.key ? s.active : ''}`}
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

/** "Major" on a live major incident; "Part of INC-0040" is shown by the pages that know the parent. */
export function MajorBadge({ row }: { row: { major?: boolean; major_ended_at?: string | null; status: IncStatus } }) {
  if (!row.major) return null;
  const live = !row.major_ended_at && ['new', 'in_progress', 'on_hold', 'restored'].includes(row.status);
  return (
    <Badge appearance={live ? 'filled' : 'outline'} color="danger" style={{ marginLeft: 4 }} title={live ? 'A live major incident' : 'Was a major incident'}>
      Major
    </Badge>
  );
}

/** "Update due in 12m" / "Update due now" / "Update late 20m" for a live major incident. */
export function MajorClockBadge({ clock }: { clock: IncMajorClock | undefined }) {
  if (!clock || clock.state === 'none' || clock.leftMs === null) return null;
  if (clock.state === 'on_track') {
    return (
      <Badge appearance="outline" color="informative" title={clock.dueAt ? `Next customer update due ${new Date(clock.dueAt).toLocaleString()}` : undefined}>
        Update in {srDuration(clock.leftMs)}
      </Badge>
    );
  }
  return (
    <Badge appearance="filled" color={clock.state === 'overdue' ? 'danger' : 'warning'} title="The next customer update is due">
      {clock.state === 'overdue' ? `Update late ${srDuration(clock.leftMs)}` : 'Update due now'}
    </Badge>
  );
}
