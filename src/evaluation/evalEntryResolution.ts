/**
 * Evaluation entry resolution — mirrors live cTrader initiator entry modes (limit, market, MARKET_RANGE).
 */

import {
  computeSlippagePointsForBoundaryTp,
  getRangeBoundaryTpPrice,
  hasNoRoomToBoundaryTpForMarketRange,
} from '../utils/ctraderMarketRange.js';
import { ParsedOrder } from '../types/order.js';

export type EvalEntryOrderType = 'limit' | 'market';

export interface FilterPastTakeProfitsResult {
  activeTPs: number[];
  skippedTPs: number[];
}

/** Split TPs into still-valid vs past quote; throws when live initiator would reject. */
export const filterTakeProfitsAtMarketQuote = (
  signalType: 'long' | 'short',
  takeProfits: number[],
  currentPrice: number,
  maxSkippablePastTPs: number = 0
): FilterPastTakeProfitsResult => {
  const isLong = signalType === 'long';
  const activeTPs: number[] = [];
  const skippedTPs: number[] = [];

  for (const tp of takeProfits) {
    const valid = isLong ? tp > currentPrice : tp < currentPrice;
    if (valid) {
      activeTPs.push(tp);
    } else {
      skippedTPs.push(tp);
    }
  }

  if (skippedTPs.length > maxSkippablePastTPs) {
    throw new Error(
      `Cannot place market entry: ${skippedTPs.length} TP(s) already past current price ${currentPrice} ` +
        `(max skippable: ${maxSkippablePastTPs}). Past TPs: ${skippedTPs.join(', ')}`
    );
  }

  if (skippedTPs.length > 0 && activeTPs.length === 0) {
    throw new Error(
      `Cannot place market entry: all TPs already past current price ${currentPrice}`
    );
  }

  return { activeTPs: activeTPs.length > 0 ? activeTPs : [...takeProfits], skippedTPs };
};

export interface MarketRangeValidationParams {
  signalType: 'long' | 'short';
  currentPrice: number;
  takeProfits: number[];
  maxSkippablePastTPs?: number;
  pipSize: number;
}

/** Validates MARKET_RANGE preconditions; returns boundary TP price when valid. */
export const validateMarketRangeEntry = (
  params: MarketRangeValidationParams
): number => {
  const boundaryTp = getRangeBoundaryTpPrice(params.takeProfits, params.maxSkippablePastTPs);
  if (boundaryTp == null) {
    throw new Error('Cannot place MARKET_RANGE: need at least one take profit');
  }

  const slippage = computeSlippagePointsForBoundaryTp({
    signalType: params.signalType,
    currentPrice: params.currentPrice,
    boundaryTp,
    pipSize: params.pipSize,
  });

  if (slippage == null) {
    const past = hasNoRoomToBoundaryTpForMarketRange(
      params.signalType,
      params.currentPrice,
      boundaryTp
    );
    throw new Error(
      past
        ? `Cannot place MARKET_RANGE: current price ${params.currentPrice} already at or past boundary TP ${boundaryTp} for ${params.signalType}`
        : `Cannot place MARKET_RANGE: invalid pip size or boundary TP (boundaryTp=${boundaryTp}, currentPrice=${params.currentPrice})`
    );
  }

  return boundaryTp;
};

/** Clamp simulated MARKET_RANGE fill to the slippage band (quote → boundary TP). */
export const clampMarketRangeFillPrice = (
  signalType: 'long' | 'short',
  fillPrice: number,
  boundaryTp: number
): number => {
  if (signalType === 'long') {
    return Math.min(fillPrice, boundaryTp);
  }
  return Math.max(fillPrice, boundaryTp);
};

export interface ResolveEvalEntryModeParams {
  order: ParsedOrder;
  useLimitOrderForEntry?: boolean;
  useMarketRangeForEntry?: boolean;
  maxSkippablePastTPs?: number;
  currentPrice?: number;
  pipSize?: number;
}

export interface ResolvedEvalEntryMode {
  entryOrderType: EvalEntryOrderType;
  useMarketRange: boolean;
  quotePrice?: number;
  boundaryTp?: number;
}

/**
 * Decide how mock exchange should fill entry.
 * Limit: wait for M1 touch. Market / MARKET_RANGE: fill at first price after eval delay.
 * Market-entry quote for sizing uses the same decision time (see evalDecisionPricing).
 */
export const resolveEvalEntryMode = (
  params: ResolveEvalEntryModeParams
): ResolvedEvalEntryMode => {
  const { order, useLimitOrderForEntry, useMarketRangeForEntry, maxSkippablePastTPs, currentPrice, pipSize } =
    params;

  const useLimitAtTouch = useLimitOrderForEntry !== false && !order.marketExecution;

  if (useLimitAtTouch && order.entryPrice != null && order.entryPrice > 0) {
    return { entryOrderType: 'limit', useMarketRange: false };
  }

  if (currentPrice == null || currentPrice <= 0) {
    throw new Error('Market entry requires current price at signal time');
  }

  let boundaryTp: number | undefined;
  if (useMarketRangeForEntry) {
    if (pipSize == null || pipSize <= 0) {
      throw new Error('MARKET_RANGE entry requires symbol pip size');
    }
    boundaryTp = validateMarketRangeEntry({
      signalType: order.signalType,
      currentPrice,
      takeProfits: order.takeProfits,
      maxSkippablePastTPs,
      pipSize,
    });
  }

  return {
    entryOrderType: 'market',
    useMarketRange: Boolean(useMarketRangeForEntry && boundaryTp != null),
    quotePrice: currentPrice,
    boundaryTp,
  };
};
