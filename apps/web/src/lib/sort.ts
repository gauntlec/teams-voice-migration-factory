import { useMemo, useState } from 'react';
import { compareSorted, type SortValue } from '@tvmf/shared';

export type { SortValue };

type Dir = 'ascending' | 'descending';

/**
 * Click-to-sort for a table you render yourself. `getters` says what each sortable column sorts by (a priority sorts by its rank, not
 * its label). Spread `header('key')` onto a `TableHeaderCell`: first click ascending, second descending, third back to the original order.
 */
export function useSort<T>(rows: T[], getters: Record<string, (r: T) => SortValue>) {
  const [sort, setSort] = useState<{ key: string; dir: Dir } | null>(null);
  const sorted = useMemo(() => {
    const get = sort && getters[sort.key];
    if (!sort || !get) return rows;
    const sign = sort.dir === 'ascending' ? (1 as const) : (-1 as const);
    return [...rows].sort((a, b) => compareSorted(get(a), get(b), sign));
    // getters are rebuilt every render by callers; the sort only depends on which column and direction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort]);
  const header = (key: string) => {
    const dir = sort?.key === key ? sort.dir : undefined;
    return {
      sortable: true as const,
      sortDirection: dir,
      title: 'Sorts the rows on this page',
      onClick: () => setSort(dir === 'ascending' ? { key, dir: 'descending' } : dir === 'descending' ? null : { key, dir: 'ascending' }),
    };
  };
  return { sorted, header };
}
