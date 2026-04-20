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

  it('cTrader floor distribution spreads remainder instead of concentrating it on last TP', () => {
    const totalQty = 0.05;
    const q = distributeQuantityAcrossTPs(totalQty, 3, 2, { lastSliceRounding: 'floor' });
    expect(q).toEqual([0.02, 0.02, 0.01]);
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

  it('cTrader trim never zeroes a leg (regression: broker Order volume = 0.00)', () => {
    const totalQty = 0.02;
    const tpPrices = [1.0, 1.1, 1.2];
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
    for (const tp of valid) {
      expect(tp.quantity).toBeGreaterThanOrEqual(0.01);
    }
    expect(valid.length).toBeGreaterThan(0);
    const sum = valid.reduce((s, o) => s + o.quantity, 0);
    expect(sum).toBeLessThanOrEqual(totalQty + 1e-9);
  });

  it('when min-lot legs overshoot risk total, drops a TP level instead of a zero-volume leg', () => {
    const tpPrices = [1.0, 1.1, 1.2];
    const tpQuantities = [0.01, 0.01, 0.01];
    const valid = validateAndRedistributeTPQuantities(
      tpQuantities,
      tpPrices,
      0.02,
      0.01,
      0.01,
      undefined,
      2,
      { lastSliceRounding: 'floor' }
    );
    for (const tp of valid) {
      expect(tp.quantity).toBeGreaterThan(0);
    }
    expect(valid.reduce((s, o) => s + o.quantity, 0)).toBeLessThanOrEqual(0.02 + 1e-9);
  });
});
