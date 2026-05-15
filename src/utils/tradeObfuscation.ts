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

/** Move a price by |offsetPercent| in the direction that is worse for the given side (same factor for SL and TP). */
const applyWorseDirectionPercentOffset = (
  value: number,
  offsetPercent: number,
  signalType: ParsedOrder['signalType']
): number => {
  const normalizedOffsetPercent = Math.abs(offsetPercent);
  const factor =
    signalType === 'long'
      ? 1 - normalizedOffsetPercent / 100
      : 1 + normalizedOffsetPercent / 100;
  return value * factor;
};

/**
 * Applies trade obfuscation to a parsed order.
 * Entry uses a random percent in range when configured; SL and TP shift by a single worse-direction percent.
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
  if (config.sl == null && !config.entry && config.tp == null) {
    return order;
  }

  const result: ParsedOrder = { ...order };

  const slOffsetPercent = config.sl;
  if (slOffsetPercent != null) {
    result.stopLoss = applyWorseDirectionPercentOffset(
      order.stopLoss,
      slOffsetPercent,
      order.signalType
    );
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

  const tpOffsetPercent = config.tp;
  if (tpOffsetPercent != null && order.takeProfits.length) {
    result.takeProfits = order.takeProfits.map((v) =>
      applyWorseDirectionPercentOffset(v, tpOffsetPercent, order.signalType)
    );
  }

  return result;
};
