import type { ParsedOrder } from '../types/order.js';
import type { TradeObfuscationConfig } from '../types/config.js';

/**
 * Returns a random number in [min, max] (inclusive)
 */
const randomInRange = (min: number, max: number): number => {
  return min + Math.random() * (max - min);
};

/**
 * Applies a random percent adjustment to a price value.
 * @param value - The original price
 * @param minPercent - Min percent adjustment (e.g. -0.5 for -0.5%)
 * @param maxPercent - Max percent adjustment (e.g. 0.5 for +0.5%)
 */
const applyPercentAdjustment = (
  value: number,
  minPercent: number,
  maxPercent: number
): number => {
  const factor = 1 + randomInRange(minPercent / 100, maxPercent / 100);
  return value * factor;
};

/**
 * Applies trade obfuscation to a parsed order.
 * Modifies sl, entry, and tp by a random percent within their configured ranges.
 * Returns a new ParsedOrder; does not mutate the input.
 *
 * IMPORTANT: Obfuscation must run before any rounding or manipulation for exchange
 * symbol constraints (tick size, price precision). The initiators apply roundPrice()
 * after receiving the obfuscated order. Call this immediately after parsing.
 */
export const applyTradeObfuscation = (
  order: ParsedOrder,
  config: TradeObfuscationConfig
): ParsedOrder => {
  if (!config.sl && !config.entry && !config.tp) {
    return order;
  }

  const result: ParsedOrder = { ...order };

  if (config.sl) {
    const { minPercent, maxPercent } = config.sl;
    result.stopLoss = applyPercentAdjustment(order.stopLoss, minPercent, maxPercent);
  }

  if (config.entry && order.entryPrice != null) {
    const { minPercent, maxPercent } = config.entry;
    result.entryPrice = applyPercentAdjustment(order.entryPrice, minPercent, maxPercent);
  }

  if (config.entry && order.entryTargets?.length) {
    const { minPercent, maxPercent } = config.entry;
    result.entryTargets = order.entryTargets.map((v) =>
      applyPercentAdjustment(v, minPercent, maxPercent)
    );
  }

  if (config.tp && order.takeProfits.length) {
    const { minPercent, maxPercent } = config.tp;
    result.takeProfits = order.takeProfits.map((v) =>
      applyPercentAdjustment(v, minPercent, maxPercent)
    );
  }

  return result;
};
