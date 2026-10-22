import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
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
 * `fitScreen` is for long, wide lists that stay one list (no pages): the box stops at the bottom of the window and scrolls inside, so the
 * sideways scrollbar is always on screen instead of far below the last row. The column headings stay in view while the rows scroll, and
 * headings wrap and cells sit closer together, so fewer columns run off the right edge.
 *
 * Put `<TableHeader>` / `<TableBody>` inside exactly as with `<Table>`. For a
 * cell that must wrap (long pre-formatted text), put the content in an inner
 * `<div style={{ whiteSpace: 'pre-wrap' }}>` — the row grows instead of the
 * text spilling.
 */
/**
 * The nearest ancestor that scrolls vertically, if any, and the space the elements between it and `el` keep below their
 * content (padding, border, margin): a box that ends at the scroll area's edge would otherwise push past it by that much.
 */
function scrollParent(el: HTMLElement): { parent: HTMLElement; below: number } | null {
  let below = 0;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') return { parent: p, below: below + (parseFloat(cs.paddingBottom) || 0) };
    below += (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0) + (parseFloat(cs.marginBottom) || 0);
  }
  return null;
}

export function DataTable({
  children,
  minWidth = 720,
  className,
  fitScreen = false,
  ...rest
}: ComponentProps<typeof Table> & { minWidth?: number; children: ReactNode; fitScreen?: boolean }) {
  const s = useStyles();
  const ref = useRef<HTMLDivElement>(null);
  // How tall the box may be: from where it starts to the bottom of the window, re-measured as the page scrolls or the window resizes.
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!fitScreen) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const el = ref.current;
      if (!el) return;
      // To the bottom of whatever scrolls the page (the content area, less its bottom padding), or of the window if nothing does,
      // so the page never gets a second scroll bar of its own next to the table's.
      let bottom = window.innerHeight;
      const found = scrollParent(el);
      if (found) bottom = Math.min(bottom, found.parent.getBoundingClientRect().bottom - found.below);
      setMaxHeight(Math.max(220, Math.floor(bottom - el.getBoundingClientRect().top - 2)));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    return () => {
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, { capture: true });
      if (frame) cancelAnimationFrame(frame);
    };
  }, [fitScreen]);
  return (
    <div ref={ref} className={mergeClasses(s.scroller, fitScreen && s.fit)} style={fitScreen && maxHeight ? { maxHeight } : undefined}>
      <div style={{ minWidth }}>
        <Table {...rest} className={mergeClasses(s.table, fitScreen && s.tableFit, className)}>
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
  // Scrolls in both directions inside a box that ends at the bottom of the window.
  fit: { overflowY: 'auto', overscrollBehavior: 'contain', ...shorthands.padding('0') },
  // Closer cells, headings that wrap onto two or three short lines instead of one long one, and headings pinned while the rows scroll.
  tableFit: {
    '& th, & td': { paddingLeft: '8px', paddingRight: '8px', maxWidth: '220px' },
    '& th': {
      whiteSpace: 'normal',
      lineHeight: '1.2',
      verticalAlign: 'bottom',
      position: 'sticky',
      top: 0,
      zIndex: 3,
      backgroundColor: tokens.colorNeutralBackground1,
      boxShadow: `inset 0 -1px 0 ${tokens.colorNeutralStroke2}`,
    },
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
