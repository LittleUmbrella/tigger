import { describe, it, expect } from 'vitest';
import {
  getRangeBoundaryTpIndex,
  getRangeBoundaryTpPrice,
  computeSlippagePointsForBoundaryTp,
  hasNoRoomToBoundaryTpForMarketRange
} from '../ctraderMarketRange.js';

describe('getRangeBoundaryTpIndex', () => {
  it('defaults to 0 when maxSkippablePastTPs is undefined', () => {
    expect(getRangeBoundaryTpIndex(undefined, 3)).toBe(0);
  });

  it('uses maxSkippablePastTPs as index when in range', () => {
    expect(getRangeBoundaryTpIndex(0, 3)).toBe(0);
    expect(getRangeBoundaryTpIndex(1, 3)).toBe(1);
    expect(getRangeBoundaryTpIndex(2, 3)).toBe(2);
  });

  it('clamps to last TP when index too high', () => {
    expect(getRangeBoundaryTpIndex(5, 2)).toBe(1);
  });
});

describe('getRangeBoundaryTpPrice', () => {
  const tps = [1.0, 1.1, 1.2];

  it('TP1 when maxSkippablePastTPs unset or 0', () => {
    expect(getRangeBoundaryTpPrice(tps, undefined)).toBe(1.0);
    expect(getRangeBoundaryTpPrice(tps, 0)).toBe(1.0);
  });

  it('TP2 when maxSkippablePastTPs is 1', () => {
    expect(getRangeBoundaryTpPrice(tps, 1)).toBe(1.1);
  });

  it('returns last TP when index beyond array', () => {
    expect(getRangeBoundaryTpPrice(tps, 99)).toBe(1.2);
  });

  it('single TP always that price', () => {
    expect(getRangeBoundaryTpPrice([1.05], 0)).toBe(1.05);
    expect(getRangeBoundaryTpPrice([1.05], 1)).toBe(1.05);
  });

  it('returns undefined when empty', () => {
    expect(getRangeBoundaryTpPrice([])).toBeUndefined();
  });
});

describe('computeSlippagePointsForBoundaryTp', () => {
  const pip = 0.01;

  it('long: positive room from cp to boundary', () => {
    const r = computeSlippagePointsForBoundaryTp({
      signalType: 'long',
      currentPrice: 100,
      boundaryTp: 101,
      pipSize: pip
    });
    expect(r).toEqual({ slippageInPoints: 100 });
  });

  it('long: returns undefined when cp already above boundary', () => {
    expect(
      computeSlippagePointsForBoundaryTp({
        signalType: 'long',
        currentPrice: 102,
        boundaryTp: 101,
        pipSize: pip
      })
    ).toBeUndefined();
  });

  it('short: positive room when cp above boundary', () => {
    const r = computeSlippagePointsForBoundaryTp({
      signalType: 'short',
      currentPrice: 101,
      boundaryTp: 100,
      pipSize: pip
    });
    expect(r).toEqual({ slippageInPoints: 100 });
  });

  it('short: returns undefined when cp below boundary', () => {
    expect(
      computeSlippagePointsForBoundaryTp({
        signalType: 'short',
        currentPrice: 99,
        boundaryTp: 100,
        pipSize: pip
      })
    ).toBeUndefined();
  });

  it('returns at least 1 point when delta is tiny', () => {
    const r = computeSlippagePointsForBoundaryTp({
      signalType: 'long',
      currentPrice: 100,
      boundaryTp: 100.000005,
      pipSize: 0.01
    });
    expect(r).toEqual({ slippageInPoints: 1 });
  });

  it('returns undefined for invalid pipSize', () => {
    expect(
      computeSlippagePointsForBoundaryTp({
        signalType: 'long',
        currentPrice: 100,
        boundaryTp: 101,
        pipSize: 0
      })
    ).toBeUndefined();
  });
});

describe('hasNoRoomToBoundaryTpForMarketRange', () => {
  it('long: no room when cp at or above boundary', () => {
    expect(hasNoRoomToBoundaryTpForMarketRange('long', 101.1, 101)).toBe(true);
    expect(hasNoRoomToBoundaryTpForMarketRange('long', 101, 101)).toBe(true);
    expect(hasNoRoomToBoundaryTpForMarketRange('long', 100.9, 101)).toBe(false);
  });

  it('short: no room when cp at or below boundary', () => {
    expect(hasNoRoomToBoundaryTpForMarketRange('short', 99.9, 100)).toBe(true);
    expect(hasNoRoomToBoundaryTpForMarketRange('short', 100, 100)).toBe(true);
    expect(hasNoRoomToBoundaryTpForMarketRange('short', 100.1, 100)).toBe(false);
  });
});
