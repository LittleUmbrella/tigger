import { describe, expect, it } from 'vitest';
import {
  calculateWorstCaseLossForOpenPositions,
  worstCaseLossQuoteForLeg,
} from '../bybitWorstCaseLoss.js';

describe('worstCaseLossQuoteForLeg', () => {
  it('computes long loss from mark to SL', () => {
    expect(worstCaseLossQuoteForLeg(100, 95, 'Buy', 2, 98)).toBe((98 - 95) * 2);
  });

  it('computes short loss from mark to SL', () => {
    expect(worstCaseLossQuoteForLeg(100, 105, 'Sell', 1, 102)).toBe((105 - 102) * 1);
  });

  it('returns 0 when quantity is zero', () => {
    expect(worstCaseLossQuoteForLeg(100, 95, 'Buy', 0)).toBe(0);
  });

  it('returns Infinity when SL missing', () => {
    expect(worstCaseLossQuoteForLeg(100, 0, 'Buy', 1)).toBe(Infinity);
  });
});

describe('calculateWorstCaseLossForOpenPositions', () => {
  it('sums legs with position SL', () => {
    const { worstCaseLoss, missingStopLossSymbols } = calculateWorstCaseLossForOpenPositions([
      { symbol: 'BTCUSDT', side: 'Buy', size: '1', avgPrice: '100', stopLoss: '95', markPrice: '99' },
    ]);
    expect(missingStopLossSymbols).toEqual([]);
    expect(worstCaseLoss).toBe(4);
  });

  it('flags missing SL symbols', () => {
    const result = calculateWorstCaseLossForOpenPositions([
      { symbol: 'ETHUSDT', side: 'Buy', size: '1', avgPrice: '100' },
    ]);
    expect(result.worstCaseLoss).toBe(Infinity);
    expect(result.missingStopLossSymbols).toContain('ETHUSDT');
  });

  it('ignores zero-size rows', () => {
    const result = calculateWorstCaseLossForOpenPositions([
      { symbol: 'BTCUSDT', side: 'Buy', size: '0', avgPrice: '100', stopLoss: '95' },
    ]);
    expect(result.worstCaseLoss).toBe(0);
  });
});
