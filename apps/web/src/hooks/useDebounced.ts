import { useEffect, useState } from 'react';

/**
 * Returns `value` trimmed, delayed by `delayMs` after the last change - the
 * shared basis for every type-ahead search box in the app (previously
 * duplicated between PagedSection and Discovery.tsx).
 */
export function useDebounced(value: string, delayMs = 250): string {
  const [debounced, setDebounced] = useState(value.trim());
  useEffect(() => {
    const h = setTimeout(() => setDebounced(value.trim()), delayMs);
    return () => clearTimeout(h);
  }, [value, delayMs]);
  return debounced;
}
