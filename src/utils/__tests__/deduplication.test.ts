import { describe, expect, it } from 'vitest';
import { deduplicateNumbers, deduplicateTakeProfits } from '../deduplication.js';

describe('deduplicateNumbers', () => {
  it('returns empty for empty input', () => {
    expect(deduplicateNumbers([], 'long')).toEqual([]);
  });

  it('sorts ascending for long and removes epsilon duplicates', () => {
    expect(deduplicateNumbers([100.00005, 99, 100.00004], 'long', 0.0001)).toEqual([99, 100.00004]);
  });

  it('sorts descending for short', () => {
    expect(deduplicateNumbers([99, 101, 100], 'short')).toEqual([101, 100, 99]);
  });
});

describe('deduplicateTakeProfits', () => {
  it('delegates to deduplicateNumbers', () => {
    expect(deduplicateTakeProfits([1.0001, 1.00015, 2], 'long', 0.0001)).toEqual([1.0001, 2]);
  });
});
