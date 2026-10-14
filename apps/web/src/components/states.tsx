import type { ReactNode } from 'react';
import { Skeleton, SkeletonItem, Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  rows: { display: 'grid', ...shorthands.gap('10px'), ...shorthands.padding('4px', '0') },
  row: { display: 'grid', ...shorthands.gap('16px'), alignItems: 'center' },
  empty: { display: 'grid', justifyItems: 'start', ...shorthands.gap('6px'), ...shorthands.padding('12px', '4px') },
  hint: { color: tokens.colorNeutralForeground3 },
});

/**
 * What a list looks like while it loads: the rows it is about to have, so the page does not jump when the data arrives.
 * Use instead of a lone spinner for tables and queues; keep a spinner for a one-off wait inside a dialog.
 */
export function TableSkeleton({ rows = 5, cols = 5, label = 'Loading' }: { rows?: number; cols?: number; label?: string }) {
  const s = useStyles();
  return (
    <Skeleton aria-label={label} className={s.rows}>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className={s.row} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {Array.from({ length: cols }, (_, c) => (
            <SkeletonItem key={c} size={16} style={{ width: c === 0 ? '60%' : c === 1 ? '90%' : '75%' }} />
          ))}
        </div>
      ))}
    </Skeleton>
  );
}

/** An empty list says what it is and what to do about it, not just "nothing". */
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  const s = useStyles();
  return (
    <div className={s.empty}>
      <Text weight="semibold">{title}</Text>
      {hint && (
        <Text size={200} className={s.hint}>
          {hint}
        </Text>
      )}
      {action}
    </div>
  );
}
