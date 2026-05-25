import type { Trade } from '../db/schema.js';
import type { CTraderClient } from '../clients/ctraderClient.js';
import type { DatabaseManager } from '../db/schema.js';
import { getIsLong } from './shared.js';
import { getEntryFillPrice } from '../utils/entryFillPrice.js';
import { normalizeCTraderSymbol } from '../utils/ctraderSymbolUtils.js';
import { protobufLongToNumber } from '../utils/protobufLong.js';

export type CtraderBreakevenSlPlan = {
  bePrice: number;
  slPrice: number;
  digits: number;
  tickSize: number;
  isLong: boolean;
  knownTakeProfit?: number;
};

/** How many ticks of slack when comparing exchange SL to target BE SL. */
export const CTRADER_BE_SL_MATCH_TOLERANCE_TICKS = 2;

export const parseCtraderPositionStopLoss = (position: Record<string, unknown>): number | undefined => {
  const raw = position.stopLoss ?? position.stop_loss;
  if (raw == null) return undefined;
  const sl = typeof raw === 'number' ? raw : parseFloat(String(raw));
  return isFinite(sl) && sl > 0 ? sl : undefined;
};

export const stopLossMatchesTarget = (
  exchangeSl: number | undefined,
  targetSl: number,
  tickSize: number
): boolean => {
  if (exchangeSl == null || !isFinite(exchangeSl) || exchangeSl <= 0) return false;
  const tol = tickSize * CTRADER_BE_SL_MATCH_TOLERANCE_TICKS;
  return Math.abs(exchangeSl - targetSl) <= tol;
};

/** BE stop must sit on the protective side of entry (above entry for shorts). */
export const isValidBreakevenStopLoss = (
  isLong: boolean,
  bePrice: number,
  slPrice: number,
  tickSize: number
): boolean => {
  const tol = tickSize * 0.5;
  return isLong ? slPrice < bePrice - tol : slPrice > bePrice + tol;
};

export const readExchangePositionStopLoss = async (
  ctraderClient: CTraderClient,
  positionId: string
): Promise<number | undefined> => {
  const positions = await ctraderClient.getOpenPositions();
  const want = String(positionId);
  const match = positions.find((p: Record<string, unknown>) => {
    const raw = p.positionId ?? p.id;
    const pid =
      typeof raw === 'object' && raw != null && 'low' in (raw as object)
        ? String(protobufLongToNumber(raw as { low: number }) ?? (raw as { low: number }).low)
        : String(raw ?? '');
    return pid === want;
  });
  if (!match) return undefined;
  return parseCtraderPositionStopLoss(match as Record<string, unknown>);
};

/**
 * cTrader rejects SL that is on the wrong side of spot (e.g. long SL above BID).
 * When price has moved past entry before BE runs, clamp to the nearest valid protective level.
 */
export const clampBreakevenStopLossToMarket = (
  isLong: boolean,
  computedSl: number,
  marketPrice: number,
  tickSize: number,
  digits: number
): { slPrice: number; clamped: boolean } => {
  if (!isFinite(marketPrice) || marketPrice <= 0) {
    return { slPrice: computedSl, clamped: false };
  }
  const buffer = tickSize;
  if (isLong) {
    const maxSl = marketPrice - buffer;
    if (computedSl > maxSl + buffer * 0.5) {
      const sl = Math.round(maxSl * Math.pow(10, digits)) / Math.pow(10, digits);
      return { slPrice: sl, clamped: true };
    }
  } else {
    const minSl = marketPrice + buffer;
    if (computedSl < minSl - buffer * 0.5) {
      const sl = Math.round(minSl * Math.pow(10, digits)) / Math.pow(10, digits);
      return { slPrice: sl, clamped: true };
    }
  }
  return { slPrice: computedSl, clamped: false };
};

export const computeCtraderBreakevenSlPlan = async (
  trade: Trade,
  db: DatabaseManager,
  ctraderClient: CTraderClient
): Promise<CtraderBreakevenSlPlan> => {
  const bePrice = await getEntryFillPrice(trade, db, { ctraderClient });
  const symbol = normalizeCTraderSymbol(trade.trading_pair);
  const symbolInfo = await ctraderClient.getSymbolInfo(symbol);

  const rawDigits = symbolInfo?.digits;
  const digits =
    typeof rawDigits === 'number'
      ? rawDigits
      : typeof rawDigits === 'object' && rawDigits?.low != null
        ? rawDigits.low
        : 2;
  const tickSize = Math.pow(10, -digits);

  const rawSl = symbolInfo?.slDistance;
  const slDistance =
    typeof rawSl === 'number'
      ? rawSl
      : typeof rawSl === 'object' && rawSl != null
        ? (protobufLongToNumber(rawSl) ?? 0)
        : 0;
  let minNudge = tickSize;
  if (slDistance > 0) {
    const rawDistType = symbolInfo?.distanceSetIn ?? (symbolInfo as { distance_set_in?: unknown }).distance_set_in;
    const distType =
      typeof rawDistType === 'number'
        ? rawDistType
        : typeof rawDistType === 'object' && rawDistType != null && 'low' in (rawDistType as object)
          ? (rawDistType as { low: number }).low
          : 1;
    if (distType === 2) {
      minNudge = Math.max(tickSize, bePrice * (slDistance / 10000));
    } else {
      minNudge = Math.max(tickSize, slDistance * Math.pow(10, -digits));
    }
  }

  const isLong = getIsLong(trade);
  const rawSlPrice = isLong ? bePrice - minNudge : bePrice + minNudge;
  const slPrice = Math.round(rawSlPrice * Math.pow(10, digits)) / Math.pow(10, digits);

  let knownTakeProfit: number | undefined;
  try {
    const tps: number[] = JSON.parse(trade.take_profits || '[]');
    const last = tps[tps.length - 1];
    if (isFinite(last) && last > 0) knownTakeProfit = last;
  } catch {
    /* ignore */
  }

  return { bePrice, slPrice, digits, tickSize, isLong, knownTakeProfit };
};
