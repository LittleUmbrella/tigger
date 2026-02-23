import { describe, it, expect } from 'vitest';
import { tryAdjustStopLossWhenPastSL } from '../slAdjustment.js';

const round = (p: number) => Math.round(p * 100) / 100;

describe('tryAdjustStopLossWhenPastSL', () => {
  it('adjusts LONG when price past SL within tolerance', () => {
    // Entry 100, SL 98, risk=2. Current price 97 (1 point past SL = 50% of risk)
    const result = tryAdjustStopLossWhenPastSL(100, 98, 97, 'long', 50, round);
    expect(result.adjusted).toBe(true);
    if (result.adjusted) {
      // new SL = 97 - 2 = 95
      expect(result.newStopLoss).toBe(95);
    }
  });

  it('rejects LONG when overshoot exceeds tolerance', () => {
    // Entry 100, SL 98, risk=2. Current price 96 (2 points past = 100% overshoot)
    const result = tryAdjustStopLossWhenPastSL(100, 98, 96, 'long', 10, round);
    expect(result.adjusted).toBe(false);
    if (!result.adjusted) {
      expect(result.rejectReason).toContain('100.0%');
      expect(result.rejectReason).toContain('max 10%');
    }
  });

  it('adjusts SHORT when price past SL within tolerance', () => {
    // Entry 100, SL 102, risk=2. Current price 103 (1 point past = 50% of risk)
    const result = tryAdjustStopLossWhenPastSL(100, 102, 103, 'short', 50, round);
    expect(result.adjusted).toBe(true);
    if (result.adjusted) {
      // new SL = 103 + 2 = 105
      expect(result.newStopLoss).toBe(105);
    }
  });

  it('rejects when tolerance is 0', () => {
    const result = tryAdjustStopLossWhenPastSL(100, 98, 97, 'long', 0, round);
    expect(result.adjusted).toBe(false);
    if (!result.adjusted) {
      expect(result.rejectReason).toContain('max 0%');
    }
  });

  it('returns reject when price not past SL (unexpected path)', () => {
    // LONG: current 99, SL 98 - price not past
    const result = tryAdjustStopLossWhenPastSL(100, 98, 99, 'long', 10, round);
    expect(result.adjusted).toBe(false);
    if (!result.adjusted) {
      expect(result.rejectReason).toContain('not past SL');
    }
  });
});
