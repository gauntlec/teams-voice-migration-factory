/** Table sorting the way a person expects (used by the web app's click-to-sort headers). */
export type SortValue = string | number | boolean | null | undefined;

/** Empty values last, numbers as numbers, text the way a person orders it (case and accents ignored, 2 before 10). */
export function compareValues(a: SortValue, b: SortValue): number {
  const empty = (v: unknown) => v == null || v === '';
  if (empty(a) || empty(b)) return empty(a) && empty(b) ? 0 : empty(a) ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** `compareValues` in either direction (`sign` 1 = ascending, -1 = descending), with empty values still last when descending. */
export function compareSorted(a: SortValue, b: SortValue, sign: 1 | -1): number {
  const empty = (v: unknown) => v == null || v === '';
  return empty(a) || empty(b) ? compareValues(a, b) : compareValues(a, b) * sign;
}
