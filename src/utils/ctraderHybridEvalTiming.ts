import type { PriceDataPoint } from './historicalPriceProvider.js';

/** Default M1 bar width used by cTrader trendbars in evaluation. */
export const M1_BAR_PERIOD_MS = 60_000;

/** Delay after signal before walk-forward simulation begins (M1 hybrid mode). */
export const SIGNAL_EVAL_DELAY_MS = 12_000;

export const floorToM1BarOpen = (
  timestampMs: number,
  periodMs: number = M1_BAR_PERIOD_MS
): number => Math.floor(timestampMs / periodMs) * periodMs;

export const getEvalStartMs = (
  signalMs: number,
  delayMs: number = SIGNAL_EVAL_DELAY_MS
): number => signalMs + delayMs;

/** Minute bucket containing signal + delay; ticks for this minute drive the hybrid prefix. */
export const getTickMinuteBounds = (
  signalMs: number,
  delayMs: number = SIGNAL_EVAL_DELAY_MS
): { evalStartMs: number; minuteOpenMs: number; minuteEndMs: number } => {
  const evalStartMs = getEvalStartMs(signalMs, delayMs);
  const minuteOpenMs = floorToM1BarOpen(evalStartMs);
  return { evalStartMs, minuteOpenMs, minuteEndMs: minuteOpenMs + M1_BAR_PERIOD_MS };
};

/**
 * Merge tick data for the eval minute (from evalStart onward) with M1 bars from the next minute.
 */
export const mergeHybridEvalSeries = (
  minuteTicks: PriceDataPoint[],
  signalMs: number,
  m1Bars: PriceDataPoint[],
  delayMs: number = SIGNAL_EVAL_DELAY_MS
): PriceDataPoint[] => {
  const { evalStartMs, minuteOpenMs, minuteEndMs } = getTickMinuteBounds(signalMs, delayMs);
  const tickPoints = minuteTicks
    .filter((t) => t.timestamp >= evalStartMs && t.timestamp < minuteEndMs)
    .map((t) => ({
      ...t,
      pointKind: 'tick' as const,
      high: t.price,
      low: t.price,
    }));
  const m1StartMs = minuteOpenMs + M1_BAR_PERIOD_MS;
  const m1Points = m1Bars
    .filter((b) => b.timestamp >= m1StartMs)
    .map((b) => ({ ...b, pointKind: 'm1' as const }));
  return [...tickPoints, ...m1Points].sort((a, b) => a.timestamp - b.timestamp);
};
