import { describe, expect, it } from 'vitest';
import {
  canSimulatePricePointAtSignal,
  floorToM1BarOpen,
  getEvalStartMs,
  getTickMinuteBounds,
  isSignalMinuteBar,
  mergeHybridEvalSeries,
  M1_BAR_PERIOD_MS,
  SIGNAL_EVAL_DELAY_MS,
} from '../mockExchangeBarTiming.js';

describe('getEvalStartMs', () => {
  it('adds 12 seconds to signal time', () => {
    const signal = Date.parse('2026-04-01T04:02:07.000Z');
    expect(getEvalStartMs(signal)).toBe(signal + SIGNAL_EVAL_DELAY_MS);
  });
});

describe('getTickMinuteBounds', () => {
  it('uses the minute containing signal + 12s', () => {
    const signal = Date.parse('2026-04-01T04:02:07.000Z');
    const { evalStartMs, minuteOpenMs, minuteEndMs } = getTickMinuteBounds(signal);
    expect(evalStartMs).toBe(Date.parse('2026-04-01T04:02:19.000Z'));
    expect(minuteOpenMs).toBe(Date.parse('2026-04-01T04:02:00.000Z'));
    expect(minuteEndMs).toBe(Date.parse('2026-04-01T04:03:00.000Z'));
  });

  it('rolls to next minute when delay crosses boundary', () => {
    const signal = Date.parse('2026-04-01T04:02:55.000Z');
    const { evalStartMs, minuteOpenMs } = getTickMinuteBounds(signal);
    expect(evalStartMs).toBe(Date.parse('2026-04-01T04:03:07.000Z'));
    expect(minuteOpenMs).toBe(Date.parse('2026-04-01T04:03:00.000Z'));
  });
});

describe('mergeHybridEvalSeries', () => {
  const signal = Date.parse('2026-04-01T04:02:07.000Z');
  const barOpen = Date.parse('2026-04-01T04:02:00.000Z');

  it('includes ticks from evalStart only, then M1 from next minute', () => {
    const ticks = [
      { timestamp: barOpen + 5_000, price: 100 },
      { timestamp: barOpen + 19_000, price: 101 },
      { timestamp: barOpen + 45_000, price: 102 },
    ];
    const m1 = [
      { timestamp: barOpen, price: 99, high: 100, low: 98 },
      { timestamp: barOpen + M1_BAR_PERIOD_MS, price: 103, high: 104, low: 102 },
      { timestamp: barOpen + 2 * M1_BAR_PERIOD_MS, price: 105, high: 106, low: 104 },
    ];
    const merged = mergeHybridEvalSeries(ticks, signal, m1);
    expect(merged.map((p) => p.timestamp)).toEqual([
      barOpen + 19_000,
      barOpen + 45_000,
      barOpen + M1_BAR_PERIOD_MS,
      barOpen + 2 * M1_BAR_PERIOD_MS,
    ]);
    expect(merged[0].pointKind).toBe('tick');
    expect(merged[2].pointKind).toBe('m1');
    expect(merged[0].high).toBe(101);
    expect(merged[0].low).toBe(101);
  });
});

describe('floorToM1BarOpen', () => {
  it('floors to minute boundary', () => {
    expect(floorToM1BarOpen(Date.parse('2026-04-01T04:02:19.000Z'))).toBe(
      Date.parse('2026-04-01T04:02:00.000Z')
    );
  });
});

describe('isSignalMinuteBar', () => {
  const barOpen = Date.parse('2026-04-01T04:02:00.000Z');

  it('is true when signal is mid-bar', () => {
    const signal = Date.parse('2026-04-01T04:02:07.000Z');
    expect(isSignalMinuteBar(barOpen, signal, M1_BAR_PERIOD_MS)).toBe(true);
  });

  it('is true when signal is at bar open', () => {
    expect(isSignalMinuteBar(barOpen, barOpen, M1_BAR_PERIOD_MS)).toBe(true);
  });

  it('is false for the next bar', () => {
    const signal = Date.parse('2026-04-01T04:02:07.000Z');
    const nextBar = barOpen + M1_BAR_PERIOD_MS;
    expect(isSignalMinuteBar(nextBar, signal, M1_BAR_PERIOD_MS)).toBe(false);
  });
});

describe('canSimulatePricePointAtSignal', () => {
  const barOpen = Date.parse('2026-04-01T04:02:00.000Z');
  const signal = Date.parse('2026-04-01T04:02:07.000Z');

  it('excludes the M1 bar containing the signal', () => {
    expect(canSimulatePricePointAtSignal(barOpen, signal)).toBe(false);
  });

  it('allows the first full bar after the signal minute', () => {
    expect(canSimulatePricePointAtSignal(barOpen + M1_BAR_PERIOD_MS, signal)).toBe(true);
  });

  it('allows earlier bars when signal is later (history before signal)', () => {
    expect(canSimulatePricePointAtSignal(barOpen - M1_BAR_PERIOD_MS, signal)).toBe(true);
  });

  it('for tick data only allows points strictly after signal', () => {
    expect(canSimulatePricePointAtSignal(signal - 1, signal, 0)).toBe(false);
    expect(canSimulatePricePointAtSignal(signal, signal, 0)).toBe(false);
    expect(canSimulatePricePointAtSignal(signal + 1, signal, 0)).toBe(true);
  });
});
