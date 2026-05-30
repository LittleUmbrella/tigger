import { describe, expect, it } from 'vitest';
import {
  assertMinRiskReward,
  calculateRiskRewardRatio,
  resolveMinRiskReward,
} from '../minRiskReward.js';
import type { AccountConfig } from '../../types/config.js';

describe('calculateRiskRewardRatio', () => {
  it('computes long R:R with equal TP weighting', () => {
    // entry 100, SL 95 (risk 5), TPs 110 and 120 → avg reward 15 → R:R 3
    expect(calculateRiskRewardRatio('long', 100, 95, [110, 120])).toBe(3);
  });

  it('computes short R:R', () => {
    // entry 100, SL 105 (risk 5), TPs 90 and 85 → avg reward 12.5 → R:R 2.5
    expect(calculateRiskRewardRatio('short', 100, 105, [90, 85])).toBe(2.5);
  });

  it('returns null when risk is zero or negative', () => {
    expect(calculateRiskRewardRatio('long', 100, 100, [110])).toBeNull();
    expect(calculateRiskRewardRatio('long', 100, 101, [110])).toBeNull();
  });

  it('returns null when no valid take profits', () => {
    expect(calculateRiskRewardRatio('long', 100, 95, [99])).toBeNull();
  });
});

describe('resolveMinRiskReward', () => {
  const account = (minRiskReward?: number): AccountConfig => ({
    name: 'test',
    exchange: 'bybit',
    minRiskReward,
  });

  it('uses account override when set', () => {
    expect(resolveMinRiskReward(2, account(3))).toBe(3);
    expect(resolveMinRiskReward(2, account(1))).toBe(1);
  });

  it('falls back to channel when account unset', () => {
    expect(resolveMinRiskReward(2, account())).toBe(2);
    expect(resolveMinRiskReward(undefined, account())).toBeUndefined();
  });
});

describe('assertMinRiskReward', () => {
  it('passes when ratio meets minimum', () => {
    expect(() =>
      assertMinRiskReward({
        minRiskReward: 2,
        signalType: 'long',
        entryPrice: 100,
        stopLoss: 95,
        takeProfits: [110, 120],
      })
    ).not.toThrow();
  });

  it('throws when ratio is below minimum', () => {
    expect(() =>
      assertMinRiskReward({
        minRiskReward: 3,
        signalType: 'long',
        entryPrice: 100,
        stopLoss: 95,
        takeProfits: [105],
      })
    ).toThrow(/below minimum 3/);
  });

  it('skips when minRiskReward is not configured', () => {
    expect(() =>
      assertMinRiskReward({
        minRiskReward: undefined,
        signalType: 'long',
        entryPrice: 100,
        stopLoss: 95,
        takeProfits: [101],
      })
    ).not.toThrow();
  });
});
