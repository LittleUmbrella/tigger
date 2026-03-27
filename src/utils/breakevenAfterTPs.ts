import type { Trade } from '../db/schema.js';

/**
 * Dynamic breakeven threshold from total TP levels on the trade/signal:
 * - Fewer than 5 TPs → move SL to breakeven after 1 TP fills
 * - 5+ TPs → after 2 TPs, plus 1 more required TP per additional block of 5 TPs
 *   (e.g. 5–9 → 2, 10–14 → 3, 15–19 → 4)
 */
export function computeDynamicBreakevenAfterTPs(totalTakeProfitLevels: number): number {
  if (totalTakeProfitLevels < 1) {
    return 1;
  }
  if (totalTakeProfitLevels < 5) {
    return 1;
  }
  return 2 + Math.floor((totalTakeProfitLevels - 5) / 5);
}

export function resolveBreakevenAfterTPs(
  totalTakeProfitLevels: number,
  options: { breakevenAfterTPs?: number; dynamicBreakevenAfterTPs?: boolean }
): number {
  if (options.dynamicBreakevenAfterTPs) {
    return computeDynamicBreakevenAfterTPs(totalTakeProfitLevels);
  }
  return options.breakevenAfterTPs ?? 1;
}

/** Number of take-profit prices on the trade (from `take_profits` JSON). */
export function getTakeProfitLevelCount(trade: Trade): number {
  try {
    const arr = JSON.parse(trade.take_profits) as unknown;
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}
