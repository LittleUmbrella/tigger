import { describe, expect, it } from 'vitest';
import { distributeQuantityAcrossTPs, validateAndRedistributeTPQuantities } from '../positionSizing.js';

describe('distributeQuantityAcrossTPs', () => {
  it('default ceil can overshoot total (Bybit-style)', () => {
    const totalQty = 0.091;
    const q = distributeQuantityAcrossTPs(totalQty, 3, 2);
    const sum = q.reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(totalQty + 1e-9);
  });

  it('floor last slice never exceeds total (cTrader N orders)', () => {
    const totalQty = 0.091;
    const q = distributeQuantityAcrossTPs(totalQty, 3, 2, { lastSliceRounding: 'floor' });
    const sum = q.reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(totalQty + 1e-12);
  });
});

describe('validateAndRedistributeTPQuantities + floor', () => {
  it('sum of legs does not exceed risk-sized position qty', () => {
    const totalQty = 0.091;
    const tpPrices = [1.1, 1.2, 1.3];
    const tpQuantities = distributeQuantityAcrossTPs(totalQty, 3, 2, { lastSliceRounding: 'floor' });
    const valid = validateAndRedistributeTPQuantities(
      tpQuantities,
      tpPrices,
      totalQty,
      0.01,
      0.01,
      undefined,
      2,
      { lastSliceRounding: 'floor' }
    );
    const sum = valid.reduce((s, o) => s + o.quantity, 0);
    expect(sum).toBeLessThanOrEqual(totalQty + 1e-9);
  });
});
