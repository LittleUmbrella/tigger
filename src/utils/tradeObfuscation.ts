import type { ParsedOrder } from '../types/order.js';
import type { TradeObfuscationConfig } from '../types/config.js';

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

/** Move entry by |offsetPercent| toward a worse fill (inverse of SL/TP worse direction). */
const applyWorseEntryPercentOffset = (
  value: number,
  offsetPercent: number,
  signalType: ParsedOrder['signalType']
): number => {
  const normalizedOffsetPercent = Math.abs(offsetPercent);
  const factor =
    signalType === 'long'
      ? 1 + normalizedOffsetPercent / 100
      : 1 - normalizedOffsetPercent / 100;
  return value * factor;
};

/**
 * Applies trade obfuscation to a parsed order.
 * Entry, SL, and TP shift by a single worse-direction percent.
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
  if (config.sl == null && config.entry == null && config.tp == null) {
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

  const entryOffsetPercent = config.entry;
  if (entryOffsetPercent != null && order.entryPrice != null) {
    result.entryPrice = applyWorseEntryPercentOffset(
      order.entryPrice,
      entryOffsetPercent,
      order.signalType
    );
  }

  if (entryOffsetPercent != null && order.entryTargets?.length) {
    result.entryTargets = order.entryTargets.map((v) =>
      applyWorseEntryPercentOffset(v, entryOffsetPercent, order.signalType)
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

/**
 * SL for absolute exchange amend (e.g. cTrader modifyPosition after market fill).
 * Applies SL obfuscation from the parser signal level, then optional rounding.
 * Uses signalStopLoss (pre-obfuscation), not order.stopLoss, so SL is not double-obfuscated
 * when the parsed order was already obfuscated upstream for sizing/TP.
 */
export const resolveObfuscatedStopLossAbsolute = (
  signalStopLoss: number,
  signalType: ParsedOrder['signalType'],
  tradeObfuscation?: TradeObfuscationConfig,
  roundPriceFn?: (price: number) => number
): number => {
  let sl = signalStopLoss;
  if (tradeObfuscation?.sl != null) {
    sl = applyTradeObfuscation(
      {
        tradingPair: '',
        leverage: 1,
        stopLoss: signalStopLoss,
        takeProfits: [],
        signalType,
      },
      { sl: tradeObfuscation.sl }
    ).stopLoss;
  }
  return roundPriceFn ? roundPriceFn(sl) : sl;
};
