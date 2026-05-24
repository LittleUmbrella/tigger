import { describe, expect, it } from 'vitest';
import { calculateEntryPrice } from '../entryPriceStrategy.js';

describe('calculateEntryPrice', () => {
  it('uses worst price for long (higher entry)', () => {
    expect(calculateEntryPrice(100, 105, 'long', 'worst')).toBe(105);
  });

  it('uses worst price for short (lower entry)', () => {
    expect(calculateEntryPrice(100, 95, 'short', 'worst')).toBe(95);
  });

  it('uses average when strategy is average', () => {
    expect(calculateEntryPrice(100, 110, 'long', 'average')).toBe(105);
    expect(calculateEntryPrice(100, 110, 'short', 'average')).toBe(105);
  });

  it('defaults to worst strategy', () => {
    expect(calculateEntryPrice(50, 60, 'long')).toBe(60);
  });
});
