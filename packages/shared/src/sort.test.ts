import { describe, expect, it } from 'vitest';
import { compareSorted, compareValues } from './sort';

const sorted = (xs: (string | number | null | undefined)[], dir = 1) => [...xs].sort((a, b) => compareValues(a, b) * dir);

describe('compareValues', () => {
  it('orders numbers as numbers and text with numbers inside it naturally', () => {
    expect(sorted([10, 2, 33, 1])).toEqual([1, 2, 10, 33]);
    expect(sorted(['INC-0010', 'INC-0002', 'INC-0001'])).toEqual(['INC-0001', 'INC-0002', 'INC-0010']);
  });
  it('ignores case and accents', () => {
    expect(String(sorted(['banana', 'Apple', 'cherry', 'apple'])[0]).toLowerCase()).toBe('apple');
    expect(compareValues('Émile', 'emile')).toBe(0);
  });
  it('puts empty values last, ascending and descending alike', () => {
    expect(sorted(['b', null, 'a', '', undefined])).toEqual(['a', 'b', null, '', undefined]);
    expect(compareValues(null, 'a')).toBe(1);
    expect(compareValues('a', null)).toBe(-1);
    expect(compareValues(null, '')).toBe(0);
  });
  it('keeps empty values last when sorting descending', () => {
    const xs: (string | null)[] = ['b', null, 'a', 'c'];
    expect([...xs].sort((a, b) => compareSorted(a, b, -1))).toEqual(['c', 'b', 'a', null]);
    expect([...xs].sort((a, b) => compareSorted(a, b, 1))).toEqual(['a', 'b', 'c', null]);
  });
});
