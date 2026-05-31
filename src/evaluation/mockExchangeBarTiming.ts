import {
  M1_BAR_PERIOD_MS,
  SIGNAL_EVAL_DELAY_MS,
  floorToM1BarOpen,
  getEvalStartMs,
  getTickMinuteBounds,
  mergeHybridEvalSeries,
} from '../utils/ctraderHybridEvalTiming.js';

export {
  M1_BAR_PERIOD_MS,
  SIGNAL_EVAL_DELAY_MS,
  floorToM1BarOpen,
  getEvalStartMs,
  getTickMinuteBounds,
  mergeHybridEvalSeries,
};

/**
 * True when the signal timestamp falls inside candle [barOpen, barOpen + periodMs).
 * That candle includes price action before the signal — it must not drive fills.
 */
export const isSignalMinuteBar = (
  barOpenMs: number,
  signalMs: number,
  periodMs: number = M1_BAR_PERIOD_MS
): boolean => signalMs >= barOpenMs && signalMs < barOpenMs + periodMs;

/**
 * Whether a price point may be used for entry / SL / TP simulation.
 *
 * - M1 candles: skip the signal-minute bar entirely (no tick split available).
 * - Tick/point data (barPeriodMs <= 0): only points strictly after the signal.
 */
export const canSimulatePricePointAtSignal = (
  pointTimestampMs: number,
  signalMs: number,
  barPeriodMs: number = M1_BAR_PERIOD_MS
): boolean => {
  if (barPeriodMs <= 0) {
    return pointTimestampMs > signalMs;
  }
  return !isSignalMinuteBar(pointTimestampMs, signalMs, barPeriodMs);
};
