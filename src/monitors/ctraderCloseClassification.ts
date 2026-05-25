import type { Trade } from '../db/schema.js';
import { getIsLong } from './shared.js';

/** Statuses that may represent an exchange TP or SL exit before re-classification. */
export const CTRADER_TP_SL_CLASSIFY_STATUSES = new Set<Trade['status']>(['closed', 'completed']);

/** Minimum |PnL| to override an exit-price SL classification as take profit. */
export const CTRADER_PNL_TP_OVERRIDE_EPS = 1e-8;

/**
 * Union of take-profit prices across N-trade legs (same signal / account).
 * Each leg stores only its own TP; closes often occur at an earlier TP on the signal.
 */
export const collectSignalTakeProfitLevels = (trades: Trade[]): number[] => {
  const levels = new Set<number>();
  for (const t of trades) {
    try {
      const arr = JSON.parse(t.take_profits || '[]') as unknown;
      if (!Array.isArray(arr)) continue;
      for (const v of arr) {
        const n = typeof v === 'number' ? v : parseFloat(String(v));
        if (isFinite(n) && n > 0) levels.add(n);
      }
    } catch {
      /* ignore parse errors */
    }
  }
  return [...levels].sort((a, b) => a - b);
};

const legTakeProfitLevels = (trade: Trade): number[] => {
  try {
    const arr = JSON.parse(trade.take_profits || '[]') as unknown;
    return Array.isArray(arr)
      ? arr
          .map((v) => (typeof v === 'number' ? v : parseFloat(String(v))))
          .filter((n) => isFinite(n) && n > 0)
      : [];
  } catch {
    return [];
  }
};

const mergedTakeProfitLevels = (trade: Trade, signalTpLevels: number[]): number[] => {
  const merged = new Set<number>([...signalTpLevels, ...legTakeProfitLevels(trade)]);
  return [...merged].sort((a, b) => a - b);
};

/**
 * Classify exit price vs SL and one or more TP levels (signal-wide when provided).
 */
export const classifyCtraderExitPriceVsLevels = (
  trade: Trade,
  exitPx: number,
  signalTpLevels: number[] = []
): 'take_profit' | 'stop_loss' | null => {
  const tps = mergedTakeProfitLevels(trade, signalTpLevels);
  const sl = trade.stop_loss;
  const entry = trade.entry_price;
  const isLong = getIsLong(trade);

  const tol = Math.max(Math.abs(entry) * 1e-5, 1e-9);

  if (tps.length > 0 && sl > 0) {
    if (isLong) {
      if (tps.some((tp) => exitPx >= tp - tol)) return 'take_profit';
      if (exitPx <= sl + tol) return 'stop_loss';
      const distTp = Math.min(...tps.map((tp) => Math.abs(exitPx - tp)));
      const distSl = Math.abs(exitPx - sl);
      if (distTp + tol < distSl) return 'take_profit';
      if (distSl + tol < distTp) return 'stop_loss';
    } else {
      if (tps.some((tp) => exitPx <= tp + tol)) return 'take_profit';
      if (exitPx >= sl - tol) return 'stop_loss';
      const distTp = Math.min(...tps.map((tp) => Math.abs(exitPx - tp)));
      const distSl = Math.abs(exitPx - sl);
      if (distTp + tol < distSl) return 'take_profit';
      if (distSl + tol < distTp) return 'stop_loss';
    }
  } else {
    if (isLong) {
      if (exitPx > entry + tol) return 'take_profit';
      if (exitPx < entry - tol) return 'stop_loss';
    } else {
      if (exitPx < entry - tol) return 'take_profit';
      if (exitPx > entry + tol) return 'stop_loss';
    }
  }

  return null;
};

/**
 * Classify TP vs SL from exit price and PnL. Uses signal-wide TP levels when provided.
 * Positive PnL overrides an exit-price SL label (N-trade leg stored only a farther TP).
 */
export const classifyCtraderCloseFromExitAndPnl = (
  trade: Trade,
  exitPrice: number | undefined,
  pnl: number | undefined,
  signalTpLevels: number[] = []
): 'take_profit' | 'stop_loss' | null => {
  const merged: Trade =
    exitPrice != null && exitPrice > 0
      ? { ...trade, exit_price: exitPrice, ...(pnl !== undefined ? { pnl } : {}) }
      : { ...trade, ...(pnl !== undefined ? { pnl } : {}) };

  if (exitPrice != null && isFinite(exitPrice) && exitPrice > 0) {
    const r = classifyCtraderExitPriceVsLevels(merged, exitPrice, signalTpLevels);
    if (r === 'take_profit') return 'take_profit';
    if (r === 'stop_loss') {
      const p = pnl ?? merged.pnl;
      if (p != null && isFinite(p) && p > CTRADER_PNL_TP_OVERRIDE_EPS) return 'take_profit';
      return 'stop_loss';
    }
  }

  const p = pnl ?? merged.pnl;
  if (p != null && isFinite(p)) {
    if (p > CTRADER_PNL_TP_OVERRIDE_EPS) return 'take_profit';
    if (p < -CTRADER_PNL_TP_OVERRIDE_EPS) return 'stop_loss';
  }

  return null;
};

/**
 * Classify a persisted sibling row (re-evaluates `stopped` using signal-wide TPs).
 */
export const classifyCtraderCloseFromDb = (
  sibling: Trade,
  signalTpLevels: number[] = []
): 'take_profit' | 'stop_loss' | null => {
  if (
    !CTRADER_TP_SL_CLASSIFY_STATUSES.has(sibling.status) &&
    sibling.status !== 'stopped'
  ) {
    return null;
  }
  return classifyCtraderCloseFromExitAndPnl(
    sibling,
    sibling.exit_price,
    sibling.pnl,
    signalTpLevels
  );
};
