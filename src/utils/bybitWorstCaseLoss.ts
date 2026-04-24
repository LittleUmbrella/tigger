/**
 * Worst-case loss in quote currency (USDT/USDC) if price reaches stop-loss.
 * Aligns with prop firm `additionalWorstCaseLoss` + `calculatePotentialLoss` shape:
 * loss = (adverse price move per unit) × quantity, with SL on the position (Bybit `setTradingStop`).
 *
 * @see calculatePotentialLoss in risk.ts (pre-trade single-leg)
 * @see calculateWorstCaseLossForOpenPositions previously in bybitInitiator.ts (open legs only)
 */

import { getBybitField } from './bybitFieldHelper.js';

function num(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Downside-only loss to SL from a reference price.
 * @param markPrice - If set, loss from current mark to SL (use with MTM balance / prop sim). If unset, from avg/entry
 *   to SL (e.g. orphan order or pro forma blended entry after adds fill).
 */
export function worstCaseLossQuoteForLeg(
  avgPrice: number,
  stopLoss: number,
  positionSide: string,
  quantity: number,
  markPrice?: number
): number {
  const side = positionSide.toLowerCase();
  if (!quantity || !isFinite(quantity) || quantity <= 0) return 0;
  if (!stopLoss || stopLoss <= 0 || !isFinite(stopLoss)) return Infinity;
  if (!avgPrice || avgPrice <= 0 || !isFinite(avgPrice)) return Infinity;

  const ref =
    markPrice !== undefined && markPrice > 0 && isFinite(markPrice) ? markPrice : avgPrice;
  if (!ref || !isFinite(ref) || ref <= 0) return Infinity;

  const perUnitLoss =
    side === 'buy' ? Math.max(0, ref - stopLoss) : Math.max(0, stopLoss - ref);

  return perUnitLoss * Math.abs(quantity);
}

/**
 * Same behavior as the former private helper in bybitInitiator:
 * sum worst-case loss for each open row; Infinity if any row lacks SL or invalid avg.
 */
export function calculateWorstCaseLossForOpenPositions(positions: unknown[]): {
  worstCaseLoss: number;
  missingStopLossSymbols: string[];
} {
  let worstCaseLoss = 0;
  const missingStopLossSymbols: string[] = [];

  for (const position of positions) {
    const p = position as Record<string, unknown>;
    const size = num(getBybitField<string>(p, 'size'));
    if (!isFinite(size) || size <= 0) continue;

    const symbol = getBybitField<string>(p, 'symbol') || 'UNKNOWN';
    const side = (getBybitField<string>(p, 'side') || '').toLowerCase();

    const avgPrice = num(
      getBybitField<string>(p, 'avgPrice', 'avg_price') ||
        getBybitField<string>(p, 'avgEntryPrice', 'avg_entry_price')
    );
    const stopLoss = num(getBybitField<string>(p, 'stopLoss', 'stop_loss'));
    const markPrice = num(getBybitField<string>(p, 'markPrice', 'mark_price'));

    if (!isFinite(avgPrice) || avgPrice <= 0) {
      return { worstCaseLoss: Infinity, missingStopLossSymbols: [symbol] };
    }

    if (!isFinite(stopLoss) || stopLoss <= 0) {
      missingStopLossSymbols.push(symbol);
      continue;
    }

    const leg = worstCaseLossQuoteForLeg(avgPrice, stopLoss, side, size, markPrice);
    if (!isFinite(leg)) {
      return { worstCaseLoss: Infinity, missingStopLossSymbols: [symbol] };
    }
    worstCaseLoss += leg;
  }

  if (missingStopLossSymbols.length > 0) {
    return { worstCaseLoss: Infinity, missingStopLossSymbols };
  }

  return { worstCaseLoss, missingStopLossSymbols };
}

function linearPositionKey(p: Record<string, unknown>): string {
  const sym = String(getBybitField<string>(p, 'symbol') ?? '');
  const idx = String(getBybitField<string | number>(p, 'positionIdx', 'position_idx') ?? '0');
  return `${sym}:${idx}`;
}

/** Remaining order size (base qty). */
function orderLeavesQty(o: Record<string, unknown>): number {
  const leaves = num(getBybitField<string>(o, 'leavesQty', 'leaves_qty'));
  if (leaves > 0) return leaves;
  const qty = num(getBybitField<string>(o, 'qty'));
  const cum = num(getBybitField<string>(o, 'cumExecQty', 'cum_exec_qty'));
  const fallback = qty - cum;
  return fallback > 0 ? fallback : 0;
}

/**
 * Conservative fill price for blending: limit price, else trigger, else position mark.
 */
function estimateOrderFillPrice(order: Record<string, unknown>, positionMarkPrice: number): number {
  const price = num(getBybitField<string>(order, 'price'));
  if (price > 0) return price;
  const trigger = num(getBybitField<string>(order, 'triggerPrice', 'trigger_price'));
  if (trigger > 0) return trigger;
  if (positionMarkPrice > 0) return positionMarkPrice;
  return 0;
}

function orderAddsToPositionSide(positionSide: string, orderSide: string): boolean {
  const ps = positionSide.toLowerCase();
  const os = orderSide.toLowerCase();
  if (ps === 'buy') return os === 'buy';
  if (ps === 'sell') return os === 'sell';
  return false;
}

export interface WorstCasePositionDetail {
  key: string;
  symbol: string;
  positionIdx: string;
  quoteCurrency: 'USDT' | 'USDC' | 'unknown';
  side: string;
  size: number;
  avgPrice: number;
  stopLoss: number;
  markPrice: number;
  /** Loss if current position hits SL (no pending adds) */
  lossPositionsOnlyQuote: number;
  additiveLeavesQty: number;
  blendedAvgPrice: number;
  blendedSize: number;
  /** Loss if pending same-side non-reduce orders fill, then SL hits */
  lossWithPendingAddsQuote: number;
}

export interface WorstCaseOrphanOrderDetail {
  symbol: string;
  orderId: string;
  side: string;
  leavesQty: number;
  assumedEntryPrice: number;
  stopLossOnOrder: number;
  lossIfSlHitsQuote: number;
  missingStopLoss: boolean;
}

export interface WorstCaseLossAnalysis {
  positionsOnlyWorstCaseQuote: number;
  withPendingAddsWorstCaseQuote: number;
  missingStopLossSymbols: string[];
  isUnbounded: boolean;
  unboundedReasons: string[];
  perPosition: WorstCasePositionDetail[];
  orphanOpeningOrders: WorstCaseOrphanOrderDetail[];
}

function quoteFromSymbol(symbol: string): 'USDT' | 'USDC' | 'unknown' {
  const s = symbol.toUpperCase();
  if (s.endsWith('USDT')) return 'USDT';
  if (s.endsWith('USDC')) return 'USDC';
  return 'unknown';
}

/**
 * Worst-case loss including:
 * - Open positions at current size → SL (same as prop firm `additionalWorstCaseLoss` source).
 * - Non-reduce-only orders on the same symbol/positionIdx that **add** to the position side:
 *   blended average entry, same position SL, loss on blended size.
 * - “Orphan” opening orders: no open position for that `symbol`+`positionIdx` (another market
 *   than any current leg, or opening before first fill). Uses order-row `stopLoss` if set;
 *   otherwise unbounded (Infinity contribution).
 */
export function analyzeWorstCaseLossWithPendingOrders(
  positions: Record<string, unknown>[],
  activeOrders: Record<string, unknown>[]
): WorstCaseLossAnalysis {
  const openPositions = positions.filter((p) => {
    const size = num(getBybitField<string>(p, 'size'));
    return isFinite(size) && size > 0;
  });

  const base = calculateWorstCaseLossForOpenPositions(openPositions);
  const missingStopLossSymbols = [...base.missingStopLossSymbols];
  const unboundedReasons: string[] = [];

  if (!isFinite(base.worstCaseLoss)) {
    unboundedReasons.push('One or more open positions lack a stop-loss on the position.');
  }

  const posByKey = new Map<string, Record<string, unknown>>();
  for (const p of openPositions) {
    posByKey.set(linearPositionKey(p), p);
  }

  const ordersByKey = new Map<string, Record<string, unknown>[]>();
  for (const o of activeOrders) {
    const sym = getBybitField<string>(o, 'symbol');
    if (!sym) continue;
    const key = `${sym}:${String(getBybitField<string | number>(o, 'positionIdx', 'position_idx') ?? '0')}`;
    const list = ordersByKey.get(key) || [];
    list.push(o);
    ordersByKey.set(key, list);
  }

  const perPosition: WorstCasePositionDetail[] = [];
  let sumWithAdds = 0;

  for (const p of openPositions) {
    const key = linearPositionKey(p);
    const symbol = getBybitField<string>(p, 'symbol') || '';
    const side = getBybitField<string>(p, 'side') || '';
    const positionIdx = String(getBybitField<string | number>(p, 'positionIdx', 'position_idx') ?? '0');
    const size = num(getBybitField<string>(p, 'size'));
    const avgPrice = num(
      getBybitField<string>(p, 'avgPrice', 'avg_price') ||
        getBybitField<string>(p, 'avgEntryPrice', 'avg_entry_price')
    );
    const stopLoss = num(getBybitField<string>(p, 'stopLoss', 'stop_loss'));
    const markPrice = num(getBybitField<string>(p, 'markPrice', 'mark_price'));

    const lossPosOnly = worstCaseLossQuoteForLeg(avgPrice, stopLoss, side, size, markPrice);
    const qc = quoteFromSymbol(symbol);

    const related = (ordersByKey.get(key) || []).filter((o) => {
      if (getBybitField<boolean>(o, 'reduceOnly', 'reduce_only') === true) return false;
      const os = getBybitField<string>(o, 'side') || '';
      return orderAddsToPositionSide(side, os);
    });

    let additiveLeavesQty = 0;
    let weightedExtra = 0;
    let additiveFillPriceUnknown = false;
    for (const o of related) {
      const l = orderLeavesQty(o);
      if (l <= 0) continue;
      const fp = estimateOrderFillPrice(o, markPrice);
      if (fp <= 0) {
        additiveFillPriceUnknown = true;
        unboundedReasons.push(
          `Cannot estimate fill price for additive order ${getBybitField<string>(o, 'orderId', 'order_id') || '?'} on ${symbol}`
        );
        continue;
      }
      additiveLeavesQty += l;
      weightedExtra += l * fp;
    }

    const blendedSize = size + additiveLeavesQty;
    const blendedAvg =
      blendedSize > 0 ? (size * avgPrice + weightedExtra) / blendedSize : avgPrice;
    const lossWithAdds = additiveFillPriceUnknown
      ? Infinity
      : additiveLeavesQty > 0
        ? worstCaseLossQuoteForLeg(blendedAvg, stopLoss, side, blendedSize)
        : lossPosOnly;

    if (additiveLeavesQty > 0 && (!isFinite(stopLoss) || stopLoss <= 0)) {
      unboundedReasons.push(`Additive orders on ${symbol} but position has no stop-loss.`);
    }

    perPosition.push({
      key,
      symbol,
      positionIdx,
      quoteCurrency: qc,
      side,
      size,
      avgPrice,
      stopLoss,
      markPrice,
      lossPositionsOnlyQuote: lossPosOnly,
      additiveLeavesQty,
      blendedAvgPrice: blendedAvg,
      blendedSize,
      lossWithPendingAddsQuote: lossWithAdds,
    });

    sumWithAdds += lossWithAdds;
  }

  const orphanOpeningOrders: WorstCaseOrphanOrderDetail[] = [];

  for (const [key, list] of ordersByKey) {
    if (posByKey.has(key)) continue;
    for (const o of list) {
      if (getBybitField<boolean>(o, 'reduceOnly', 'reduce_only') === true) continue;

      const leaves = orderLeavesQty(o);
      if (leaves <= 0) continue;

      const sym = getBybitField<string>(o, 'symbol') || '';
      const side = getBybitField<string>(o, 'side') || '';
      const id = getBybitField<string>(o, 'orderId', 'order_id') || '';
      const entry = estimateOrderFillPrice(o, 0);
      const osl = num(getBybitField<string>(o, 'stopLoss', 'stop_loss'));

      const missingSl = !isFinite(osl) || osl <= 0;
      const lossOrphan = missingSl
        ? Infinity
        : worstCaseLossQuoteForLeg(entry, osl, side, leaves);

      if (missingSl) {
        unboundedReasons.push(
          `Opening order ${id || '?'} on ${sym} has no SL on the order (no position yet).`
        );
      } else if (entry <= 0) {
        unboundedReasons.push(`Cannot estimate entry for orphan order ${id || '?'} on ${sym}`);
      }

      orphanOpeningOrders.push({
        symbol: sym,
        orderId: id,
        side,
        leavesQty: leaves,
        assumedEntryPrice: entry,
        stopLossOnOrder: osl,
        lossIfSlHitsQuote: lossOrphan,
        missingStopLoss: missingSl,
      });

      if (isFinite(lossOrphan)) sumWithAdds += lossOrphan;
      else sumWithAdds = Infinity;
    }
  }

  const positionsOnlyWorstCaseQuote = base.worstCaseLoss;
  const withPendingAddsWorstCaseQuote = Number.isFinite(sumWithAdds) ? sumWithAdds : Infinity;

  return {
    positionsOnlyWorstCaseQuote,
    withPendingAddsWorstCaseQuote,
    missingStopLossSymbols,
    isUnbounded: !Number.isFinite(withPendingAddsWorstCaseQuote),
    unboundedReasons,
    perPosition,
    orphanOpeningOrders,
  };
}
