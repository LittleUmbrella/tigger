import { describe, expect, it } from 'vitest';
import {
  clampBreakevenStopLossToMarket,
  isValidBreakevenStopLoss,
  stopLossMatchesTarget,
} from '../ctraderBreakeven.js';

describe('isValidBreakevenStopLoss', () => {
  it('requires short BE SL above entry', () => {
    expect(isValidBreakevenStopLoss(false, 4575.28, 4575.38, 0.01)).toBe(true);
    expect(isValidBreakevenStopLoss(false, 4575.28, 4575, 0.01)).toBe(false);
  });

  it('requires long BE SL below entry', () => {
    expect(isValidBreakevenStopLoss(true, 100, 99.5, 0.01)).toBe(true);
    expect(isValidBreakevenStopLoss(true, 100, 100.5, 0.01)).toBe(false);
  });
});

describe('clampBreakevenStopLossToMarket', () => {
  it('clamps long BE SL to below BID when market fell below entry', () => {
    const r = clampBreakevenStopLossToMarket(true, 4574.21, 4568.17, 0.01, 2);
    expect(r.clamped).toBe(true);
    expect(r.slPrice).toBeLessThanOrEqual(4568.17);
  });
});

describe('stopLossMatchesTarget', () => {
  it('matches within tick tolerance', () => {
    expect(stopLossMatchesTarget(4575.37, 4575.38, 0.01)).toBe(true);
    expect(stopLossMatchesTarget(4580, 4575.38, 0.01)).toBe(false);
  });
});
