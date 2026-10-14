import type { ComponentProps, ReactNode } from 'react';
import { Table, makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';

/**
 * Standard data table for the whole app. Use this instead of Fluent's `<Table>`
 * directly.
 *
 * Fluent defaults tables to `table-layout: fixed` + `width: 100%`, so on a
 * narrow window every column collapses to an equal sliver and `nowrap` text
 * spills across the column edge (cells visually overlap). This wrapper:
 *   - sizes columns to their content (`table-layout: auto`);
 *   - keeps every cell on one line and clips overflow with an ellipsis, so text
 *     never crosses into the next column;
 *   - holds a `minWidth` floor and lets the surrounding box scroll sideways
 *     once the table can't fit, giving a scrollbar along the bottom.
 *
 * Pass `minWidth` sized to the table's columns (rule of thumb: ~130px per
 * column, a little more when a column holds long free text).
 *
 * Put `<TableHeader>` / `<TableBody>` inside exactly as with `<Table>`. For a
 * cell that must wrap (long pre-formatted text), put the content in an inner
 * `<div style={{ whiteSpace: 'pre-wrap' }}>` — the row grows instead of the
 * text spilling.
 */
export function DataTable({
  children,
  minWidth = 720,
  className,
  ...rest
}: ComponentProps<typeof Table> & { minWidth?: number; children: ReactNode }) {
  const s = useStyles();
  return (
    <div className={s.scroller}>
      <div style={{ minWidth }}>
        <Table {...rest} className={mergeClasses(s.table, className)}>
          {children}
        </Table>
      </div>
    </div>
  );
}

const useStyles = makeStyles({
  // A soft shadow on whichever edge has more to scroll to, so a wide table never looks like it ends at the window edge. The two
  // "local" gradients are page-coloured covers that hide the shadow once you reach that end.
  scroller: {
    width: '100%',
    overflowX: 'auto',
    overflowY: 'hidden',
    ...shorthands.padding('0', '0', '2px', '0'),
    backgroundImage: `linear-gradient(to right, ${tokens.colorNeutralBackground1} 30%, transparent), linear-gradient(to left, ${tokens.colorNeutralBackground1} 30%, transparent), radial-gradient(farthest-side at 0 50%, rgba(0, 0, 0, 0.18), transparent), radial-gradient(farthest-side at 100% 50%, rgba(0, 0, 0, 0.18), transparent)`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'left center, right center, left center, right center',
    backgroundSize: '40px 100%, 40px 100%, 12px 100%, 12px 100%',
    backgroundAttachment: 'local, local, scroll, scroll',
  },
  table: {
    width: '100%',
    tableLayout: 'auto',
    '& th, & td': {
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      maxWidth: '360px',
    },
  },
});
