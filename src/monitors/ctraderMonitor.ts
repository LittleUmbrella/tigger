import pLimit from 'p-limit';
import { MonitorConfig } from '../types/config.js';
import { DatabaseManager, Trade, Order } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { serializeErrorForLog } from '../utils/errorUtils.js';
import dayjs from 'dayjs';
import {
  CTraderClient,
  extractPositionIdFromCtraderOrderDetails,
  getCtraderOrderExecutionPrice,
  isCtraderOrderStatusFilled
} from '../clients/ctraderClient.js';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { protobufLongToNumber } from '../utils/protobufLong.js';
import {
  getIsLong,
  checkTradeExpired,
  updateEntryOrderToFilled,
  checkStopLossHit,
  checkTPHitBeforeEntry,
  checkSLHitBeforeEntry,
  updateOrderToFilled,
  updateTradeOnPositionClosed,
  updateTradeOnStopLossHit,
  cancelTrade,
  sleep,
  MONITOR_TRADE_TIMEOUT_MS,
  CTRADER_RECONCILE_TIMEOUT_MS,
  CTRADER_DEAL_CLOSE_INFO_TIMEOUT_MS
} from './shared.js';
import { getEntryFillPrice } from '../utils/entryFillPrice.js';
import { normalizeCTraderSymbol } from '../utils/ctraderSymbolUtils.js';
import { resolveBreakevenAfterTPs } from '../utils/breakevenAfterTPs.js';

/** Max deal history window (7 days) - caps slow API scans when trade already closed */
const DEAL_HISTORY_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Min window for getDealList - cTrader API returns 0 deals for very narrow windows (e.g. 2h) */
const DEAL_HISTORY_MIN_WINDOW_MS = 24 * 60 * 60 * 1000;

const capDealHistoryWindow = (fromTs: number, toTs: number): [number, number] => {
  let from = fromTs;
  let to = toTs;
  if (to - from > DEAL_HISTORY_MAX_WINDOW_MS) from = to - DEAL_HISTORY_MAX_WINDOW_MS;
  if (to - from < DEAL_HISTORY_MIN_WINDOW_MS) from = to - DEAL_HISTORY_MIN_WINDOW_MS;
  return [from, to];
};

/** Statuses we may have written for either TP or SL exits; `stopped` is SL-only when we classified correctly. */
const CTRADER_TP_SL_CLASSIFY_STATUSES = new Set<Trade['status']>(['closed', 'completed']);

/**
 * Classify TP vs SL from exit price / PnL vs trade levels (no status check).
 * Used for reconcile closes and for persisted sibling rows.
 */
const classifyCtraderCloseFromExitAndPnl = (
  trade: Trade,
  exitPrice: number | undefined,
  pnl: number | undefined
): 'take_profit' | 'stop_loss' | null => {
  const merged: Trade =
    exitPrice != null && exitPrice > 0
      ? { ...trade, exit_price: exitPrice, ...(pnl !== undefined ? { pnl } : {}) }
      : { ...trade, ...(pnl !== undefined ? { pnl } : {}) };

  if (exitPrice != null && isFinite(exitPrice) && exitPrice > 0) {
    const r = classifyCtraderExitPriceVsLevels(merged, exitPrice);
    if (r != null) return r;
  }

  const p = pnl ?? merged.pnl;
  if (p != null && isFinite(p)) {
    if (p > 1e-8) return 'take_profit';
    if (p < -1e-8) return 'stop_loss';
  }

  return null;
};

/**
 * Classify a closed cTrader sibling as TP vs SL using DB fields.
 * Our monitor often sets `closed` for both exchange TP and SL exits; use exit_price vs TP/SL/entry when present.
 */
const classifyCtraderCloseFromDb = (sibling: Trade): 'take_profit' | 'stop_loss' | null => {
  if (sibling.status === 'stopped') return 'stop_loss';
  if (!CTRADER_TP_SL_CLASSIFY_STATUSES.has(sibling.status)) return null;
  return classifyCtraderCloseFromExitAndPnl(sibling, sibling.exit_price, sibling.pnl);
};

const classifyCtraderExitPriceVsLevels = (sibling: Trade, exitPx: number): 'take_profit' | 'stop_loss' | null => {
  let tps: number[];
  try {
    tps = JSON.parse(sibling.take_profits || '[]') as number[];
  } catch {
    tps = [];
  }
  const tpPrice = tps.length > 0 ? tps[0] : 0;
  const sl = sibling.stop_loss;
  const entry = sibling.entry_price;
  const isLong = getIsLong(sibling);

  const tol = Math.max(Math.abs(entry) * 1e-5, 1e-9);

  if (tpPrice > 0 && sl > 0) {
    if (isLong) {
      if (exitPx >= tpPrice - tol) return 'take_profit';
      if (exitPx <= sl + tol) return 'stop_loss';
      const distTp = Math.abs(exitPx - tpPrice);
      const distSl = Math.abs(exitPx - sl);
      if (distTp + tol < distSl) return 'take_profit';
      if (distSl + tol < distTp) return 'stop_loss';
    } else {
      if (exitPx <= tpPrice + tol) return 'take_profit';
      if (exitPx >= sl - tol) return 'stop_loss';
      const distTp = Math.abs(exitPx - tpPrice);
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

  if (sibling.pnl != null && isFinite(sibling.pnl)) {
    if (sibling.pnl > 1e-8) return 'take_profit';
    if (sibling.pnl < -1e-8) return 'stop_loss';
  }

  return null;
};

/**
 * When DB cannot classify, use closing deals' realized gross profit (cTrader ProtoOAClosePositionDetail).
 */
const classifyCtraderCloseFromDeals = async (
  sibling: Trade,
  ctraderClient: CTraderClient
): Promise<'take_profit' | 'stop_loss' | null> => {
  const positionId = sibling.position_id;
  if (!positionId) return null;

  const fromTs = sibling.entry_filled_at
    ? new Date(sibling.entry_filled_at).getTime()
    : new Date(sibling.created_at).getTime();
  const [from, to] = capDealHistoryWindow(fromTs, Date.now());

  let deals: any[];
  try {
    deals = await Promise.race([
      ctraderClient.getDealListByPositionId(positionId, from, to),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `getDealListByPositionId (BE sibling classify) timeout after ${CTRADER_DEAL_CLOSE_INFO_TIMEOUT_MS}ms`
              )
            ),
          CTRADER_DEAL_CLOSE_INFO_TIMEOUT_MS
        )
      )
    ]);
  } catch {
    return null;
  }

  const closingDeals = deals.filter((d: any) => (d.closePositionDetail ?? d.close_position_detail) != null);
  if (closingDeals.length === 0) return null;

  let totalGross = 0;
  for (const d of closingDeals) {
    const detail = d.closePositionDetail ?? d.close_position_detail;
    const grossProfit = detail?.grossProfit ?? detail?.gross_profit ?? 0;
    const moneyDigits = detail?.moneyDigits ?? detail?.money_digits ?? 2;
    const raw = protobufLongToNumber(grossProfit) ?? 0;
    totalGross += raw / Math.pow(10, moneyDigits);
  }
  if (totalGross > 1e-8) return 'take_profit';
  if (totalGross < -1e-8) return 'stop_loss';
  return null;
};

const countCtraderSiblingsClosedAtTakeProfit = async (
  siblings: Trade[],
  currentTradeId: number,
  accountName: string | undefined,
  ctraderClient: CTraderClient | undefined
): Promise<number> => {
  const relevant = siblings.filter(
    (t) => t.exchange === 'ctrader' && t.account_name === accountName && t.id !== currentTradeId
  );

  const tasks = relevant.map(async (sib) => {
    if (sib.status === 'stopped') return 0;
    if (sib.status !== 'closed' && sib.status !== 'completed') return 0;

    const fromDb = classifyCtraderCloseFromDb(sib);
    if (fromDb === 'take_profit') return 1;
    if (fromDb === 'stop_loss') return 0;

    if (!ctraderClient) return 0;
    const fromDeals = await classifyCtraderCloseFromDeals(sib, ctraderClient);
    return fromDeals === 'take_profit' ? 1 : 0;
  });

  const results = await Promise.all(tasks);
  return results.reduce<number>((a, b) => a + b, 0);
};

/**
 * Decide TP vs SL when reconciling an exchange closed position into our DB (`closed` vs `stopped`).
 */
const resolveCtraderReconciledCloseReason = async (
  trade: Trade,
  exitPrice: number | undefined,
  pnl: number | undefined,
  ctraderClient: CTraderClient | undefined
): Promise<'take_profit' | 'stop_loss'> => {
  let r = classifyCtraderCloseFromExitAndPnl(trade, exitPrice, pnl);
  if (r != null) return r;
  if (ctraderClient && trade.position_id) {
    const fromDeals = await classifyCtraderCloseFromDeals(trade, ctraderClient);
    if (fromDeals != null) return fromDeals;
  }
  if (exitPrice != null && isFinite(exitPrice) && exitPrice > 0) {
    const entry = trade.entry_price;
    const isLong = getIsLong(trade);
    const tol = Math.max(Math.abs(entry) * 1e-5, 1e-9);
    if (isLong) {
      if (exitPrice < entry - tol) return 'stop_loss';
      if (exitPrice > entry + tol) return 'take_profit';
    } else {
      if (exitPrice > entry + tol) return 'stop_loss';
      if (exitPrice < entry - tol) return 'take_profit';
    }
  }
  return 'take_profit';
};

const applyCtraderReconciledClose = async (
  trade: Trade,
  db: DatabaseManager,
  exitPrice: number | undefined,
  pnl: number | undefined,
  ctraderClient: CTraderClient | undefined
): Promise<void> => {
  const reason = await resolveCtraderReconciledCloseReason(trade, exitPrice, pnl, ctraderClient);
  if (reason === 'stop_loss') {
    await updateTradeOnStopLossHit(trade, db, exitPrice, pnl);
  } else {
    await updateTradeOnPositionClosed(trade, db, exitPrice, pnl);
  }
};

const withCtraderApiTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    )
  ]);
};

/**
 * Resolve positionId from orderId for trades that have order_id but no position_id.
 * One ProtoOADealListReq per account (paginated internally), then ProtoOAOrderDetailsReq for misses.
 */
const resolvePositionIdsBatch = async (
  trades: Trade[],
  getCTraderClient: ((accountName?: string) => Promise<CTraderClient | undefined>) | undefined,
  ctraderClient: CTraderClient | undefined
): Promise<Map<string, string>> => {
  const needsResolution = trades.filter((t) => t.order_id && !t.position_id);
  if (needsResolution.length === 0) return new Map();

  const result = new Map<string, string>();
  const byAccount = new Map<string, Trade[]>();
  for (const t of needsResolution) {
    const key = t.account_name ?? '';
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key)!.push(t);
  }

  for (const [accountKey, accountTrades] of byAccount) {
    const client = getCTraderClient ? await getCTraderClient(accountKey || undefined) : ctraderClient;
    if (!client) continue;

    const minCreated = Math.min(...accountTrades.map((t) => new Date(t.created_at).getTime()));
    const [from, to] = capDealHistoryWindow(minCreated, Date.now());
    let dealsSnapshot: any[] = [];
    try {
      dealsSnapshot = await client.getDealList(from, to);
    } catch (error) {
      logger.debug('Batch deal list for position-id resolution failed', {
        account: accountKey || '(default)',
        error: serializeErrorForLog(error),
        exchange: 'ctrader'
      });
    }

    const positionByOrderId = new Map<string, string>();
    for (const d of dealsSnapshot) {
      const oid = d.orderId != null ? String(d.orderId) : '';
      const pid = d.positionId != null ? String(d.positionId) : '';
      if (oid && pid && !positionByOrderId.has(oid)) positionByOrderId.set(oid, pid);
    }

    for (const t of accountTrades) {
      if (!t.order_id) continue;
      const orderIdStr = String(t.order_id);
      try {
        const fromDeals = positionByOrderId.get(orderIdStr);
        if (fromDeals) {
          result.set(orderIdStr, fromDeals);
          logger.debug('Resolved position from batch deal list', {
            tradeId: t.id,
            orderId: orderIdStr,
            positionId: fromDeals,
            exchange: 'ctrader'
          });
          continue;
        }
        const posId = await client.getPositionIdByEntryOrderId(orderIdStr, from, to, {
          allowDealListFallback: false
        });
        if (posId) {
          result.set(orderIdStr, posId);
          logger.debug('Resolved position from order details', {
            tradeId: t.id,
            orderId: orderIdStr,
            positionId: posId,
            exchange: 'ctrader'
          });
          continue;
        }
        if (dealsSnapshot.length === 0) {
          const posIdDeal = await client.getPositionIdByEntryOrderId(orderIdStr, from, to, {
            allowDealListFallback: true
          });
          if (posIdDeal) {
            result.set(orderIdStr, posIdDeal);
            logger.debug('Resolved position after empty batch deal list', {
              tradeId: t.id,
              orderId: orderIdStr,
              positionId: posIdDeal,
              exchange: 'ctrader'
            });
          }
        }
      } catch (error) {
        logger.debug('Order details lookup failed - will retry per-check', {
          tradeId: t.id,
          orderId: orderIdStr,
          error: serializeErrorForLog(error),
          exchange: 'ctrader'
        });
      }
    }
  }
  return result;
};

/**
 * Get current price from cTrader
 */
const getCurrentPrice = async (
  tradingPair: string,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider
): Promise<number | null> => {
  try {
    if (isSimulation && priceProvider) {
      const price = priceProvider.getCurrentPrice(tradingPair);
      if (price === null) {
        logger.warn('No historical price data available', {
          tradingPair,
          exchange: 'ctrader'
        });
      }
      return price;
    } else if (ctraderClient) {
      const symbol = normalizeCTraderSymbol(tradingPair);
      const price = await ctraderClient.getCurrentPrice(symbol);
      if (price !== null) {
        logger.debug('Got current price from cTrader', {
          tradingPair,
          symbol,
          price,
          exchange: 'ctrader'
        });
        return price;
      }
    }
    return null;
  } catch (error) {
    logger.error('Error getting current price from cTrader', {
      tradingPair,
      exchange: 'ctrader',
      error: serializeErrorForLog(error)
    });
    return null;
  }
};

/**
 * Extract exit price and PNL from cTrader closing deals (position history).
 * Used when getOpenPositions times out or position was already closed by the exchange.
 * Only returns closed: true when total closed volume >= opening volume (handles partial closes).
 */
const getClosedPositionInfoFromDeals = async (
  ctraderClient: CTraderClient,
  positionId: string,
  fromTimestamp: number,
  toTimestamp: number,
  assumeClosed?: boolean
): Promise<{ closed: boolean; exitPrice?: number; pnl?: number }> => {
  try {
    const toNum = (v: any) => (typeof v === 'object' && v?.low != null ? protobufLongToNumber(v) : v);
    const deals = await Promise.race([
      ctraderClient.getDealListByPositionId(positionId, fromTimestamp, toTimestamp),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `getDealListByPositionId timeout after ${CTRADER_DEAL_CLOSE_INFO_TIMEOUT_MS}ms`
              )
            ),
          CTRADER_DEAL_CLOSE_INFO_TIMEOUT_MS
        )
      )
    ]);
    const closingDeals = deals.filter((d: any) => {
      const detail = d.closePositionDetail ?? d.close_position_detail;
      return detail != null;
    });
    const openingDeals = deals.filter((d: any) => {
      const detail = d.closePositionDetail ?? d.close_position_detail;
      if (detail != null) return false;
      // Only count FILLED (2) - REJECTED/INTERNALLY_REJECTED etc. never opened position
      const status = d.dealStatus ?? d.deal_status;
      return status === 2 || status === 'FILLED';
    });
    if (closingDeals.length === 0) {
      if (assumeClosed) {
        return { closed: true, exitPrice: undefined, pnl: undefined };
      }
      return { closed: false };
    }

    if (assumeClosed) {
      // Position known closed from exchange (not in open list) - trust it, extract exit info from closing deals
    } else {
      // Use filledVolume for opening (actual executed); volume can over-report for partial fills
      const openingVolume = openingDeals.reduce((sum: number, d: any) => {
        const v = d.filledVolume ?? d.filled_volume ?? d.volume ?? 0;
        return sum + (Number(toNum(v)) || 0);
      }, 0);
      if (openingVolume === 0) return { closed: false };
      // Prefer closedVolume when present (authoritative per proto); else filledVolume (actual executed)
      const closingVolume = closingDeals.reduce((sum: number, d: any) => {
        const detail = d.closePositionDetail ?? d.close_position_detail;
        const v =
          detail?.closedVolume ?? detail?.closed_volume ?? d.filledVolume ?? d.filled_volume ?? d.volume ?? 0;
        return sum + (Number(toNum(v)) || 0);
      }, 0);
      const tolerance = Math.max(1, Math.floor(openingVolume * 0.001));
      if (closingVolume < openingVolume - tolerance) {
        return { closed: false };
      }
    }

    let totalPnl = 0;
    let totalClosedVol = 0;
    let weightedPriceSum = 0;
    for (const d of closingDeals) {
      const detail = d.closePositionDetail ?? d.close_position_detail;
      const vol = d.volume ?? d.filledVolume ?? d.filled_volume ?? detail?.closedVolume ?? 0;
      const volNum = Number(toNum(vol)) || 0;
      const grossProfit = detail?.grossProfit ?? detail?.gross_profit ?? 0;
      const moneyDigits = detail?.moneyDigits ?? detail?.money_digits ?? 2;
      const raw = protobufLongToNumber(grossProfit) ?? 0;
      totalPnl += raw / Math.pow(10, moneyDigits);
      const execPrice = d.executionPrice ?? d.execution_price ?? 0;
      const priceNum = typeof execPrice === 'number' ? execPrice : parseFloat(execPrice ?? '0');
      weightedPriceSum += priceNum * volNum;
      totalClosedVol += volNum;
    }
    const exitPrice = totalClosedVol > 0 ? weightedPriceSum / totalClosedVol : undefined;
    return {
      closed: true,
      exitPrice: exitPrice != null && exitPrice > 0 ? exitPrice : undefined,
      pnl: totalPnl !== 0 ? totalPnl : undefined,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const timedOut = msg.includes('timeout');
    logger[timedOut ? 'warn' : 'debug']('Error getting closed position info from deals', {
      positionId,
      assumeClosed,
      error: serializeErrorForLog(error),
      exchange: 'ctrader'
    });
    if (assumeClosed) {
      return { closed: true, exitPrice: undefined, pnl: undefined };
    }
    return { closed: false };
  }
};

/**
 * Entry order is gone from open orders and no matching open position — use order details + deals
 * (never assume FILLED without exchange confirmation; avoids stuck active trades with null position_id).
 */
const reconcileCtraderEntryWhenOrderMissingFromOpenList = async (
  trade: Trade,
  ctraderClient: CTraderClient,
  symbol: string,
  fromTs: number,
  toTs: number,
  options?: { prefetchedOrderDetails?: { order: any; deals: any[] } | null }
): Promise<{
  filled: boolean;
  positionId?: string;
  alreadyClosed?: boolean;
  exitPrice?: number;
  pnl?: number;
  filledAt?: string;
  filledPrice?: number;
}> => {
  const odEntry =
    options != null && 'prefetchedOrderDetails' in options
      ? options.prefetchedOrderDetails
      : await ctraderClient.getOrderDetails(trade.order_id!);
  if (!odEntry?.order || !isCtraderOrderStatusFilled(odEntry.order)) {
    logger.debug('Order not in open list; order details show not filled — wait for next poll', {
      tradeId: trade.id,
      symbol,
      orderId: trade.order_id,
      orderStatus: odEntry?.order?.orderStatus ?? odEntry?.order?.order_status,
      exchange: 'ctrader'
    });
    return { filled: false };
  }

  let positionIdForDeals =
    extractPositionIdFromCtraderOrderDetails(odEntry.order, odEntry.deals) ??
    (await ctraderClient.getPositionIdByEntryOrderId(trade.order_id!, fromTs, toTs, {
      prefetchedDetails: odEntry,
      allowDealListFallback: true
    }));

  const updTs = odEntry.order.utcLastUpdateTimestamp ?? odEntry.order.utc_last_update_timestamp;
  const tsMs = protobufLongToNumber(updTs);
  const filledAtFromOrder = tsMs != null && tsMs > 0 ? new Date(tsMs).toISOString() : undefined;
  const fillPx = getCtraderOrderExecutionPrice(odEntry.order);

  if (positionIdForDeals) {
    const closedInfo = await getClosedPositionInfoFromDeals(
      ctraderClient,
      positionIdForDeals,
      fromTs,
      toTs
    );
    if (closedInfo.closed) {
      logger.info('Order filled, position already closed (deal history)', {
        tradeId: trade.id,
        symbol,
        orderId: trade.order_id,
        positionId: positionIdForDeals,
        exitPrice: closedInfo.exitPrice,
        pnl: closedInfo.pnl,
        exchange: 'ctrader'
      });
      return {
        filled: true,
        positionId: positionIdForDeals,
        alreadyClosed: true,
        exitPrice: closedInfo.exitPrice,
        pnl: closedInfo.pnl
      };
    }
    logger.info('Entry order filled; activating trade with resolved position id', {
      tradeId: trade.id,
      symbol,
      orderId: trade.order_id,
      positionId: positionIdForDeals,
      exchange: 'ctrader'
    });
    return {
      filled: true,
      positionId: positionIdForDeals,
      filledAt: filledAtFromOrder,
      filledPrice: fillPx
    };
  }

  logger.info('cTrader entry FILLED but position id unknown — closing from order execution price only', {
    tradeId: trade.id,
    symbol,
    orderId: trade.order_id,
    executionPrice: fillPx,
    exchange: 'ctrader'
  });
  return {
    filled: true,
    alreadyClosed: true,
    exitPrice: fillPx,
    pnl: undefined
  };
};

/**
 * Check if entry order is filled for cTrader
 * Implements advanced order querying with multiple fallback strategies (Gap #5)
 * Uses position/deal history when open positions time out or exchange already closed the trade.
 */
const checkEntryFilled = async (
  trade: Trade,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider,
  preFetched?: { positions: any[]; orders: any[] },
  preResolvedPositionIds?: Map<string, string>
): Promise<{
  filled: boolean;
  positionId?: string;
  filledAt?: string;
  filledPrice?: number;
  alreadyClosed?: boolean;
  exitPrice?: number;
  pnl?: number;
}> => {
  try {
    if (isSimulation) {
      if (priceProvider) {
        const currentPrice = await priceProvider.getCurrentPrice(trade.trading_pair);
        if (currentPrice !== null) {
          const isLong = currentPrice >= trade.entry_price;
          const tolerance = trade.entry_price * 0.001;
          const filled = Math.abs(currentPrice - trade.entry_price) <= tolerance || 
                 (isLong && currentPrice > trade.entry_price) ||
                 (!isLong && currentPrice < trade.entry_price);
          if (filled) {
            return { filled: true, positionId: `SIM-${trade.id}` };
          }
        }
      }
      return { filled: false };
    } else if (ctraderClient) {
      const symbol = normalizeCTraderSymbol(trade.trading_pair);
      
      logger.info('Checking cTrader entry fill status', {
        tradeId: trade.id,
        symbol,
        orderId: trade.order_id,
        channel: trade.channel,
        exchange: 'ctrader'
      });
      
      // Strategy 1: Check positions first (most reliable indicator)
      let positions: any[] = [];
      if (preFetched) {
        positions = preFetched.positions;
        logger.info('cTrader positions (pre-fetched)', {
          tradeId: trade.id,
          symbol,
          positionsCount: positions.length,
          channel: trade.channel,
          exchange: 'ctrader'
        });
      } else {
        const maxRetries = 1;
        const retryDelay = 1000;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            positions = await withCtraderApiTimeout(
              ctraderClient.getOpenPositions(),
              CTRADER_RECONCILE_TIMEOUT_MS,
              'getOpenPositions (checkEntryFilled)'
            );
            logger.info('cTrader positions received', {
              tradeId: trade.id,
              symbol,
              positionsCount: positions.length,
              channel: trade.channel,
              exchange: 'ctrader'
            });
            break;
          } catch (error) {
            logger.debug('Error getting positions, retrying', {
              tradeId: trade.id,
              symbol,
              attempt,
              maxRetries,
              error: serializeErrorForLog(error)
            });
            if (attempt < maxRetries) await sleep(retryDelay);
          }
        }
      }
      
      // Order-based position resolution: use pre-resolved map to find the exact position for this order.
      // Prevents incorrect symbol-only matching when multiple orders exist for the same symbol (N-trades).
      const resolvedPosId = trade.order_id ? preResolvedPositionIds?.get(trade.order_id) : undefined;
      const position = resolvedPosId
        ? positions.find((p: any) => (p.positionId || p.id)?.toString() === resolvedPosId)
        : positions.find((p: any) => {
            const positionSymbol = p.symbolName || p.symbol;
            const volume = Math.abs(p.volume || p.quantity || 0);
            const matches = positionSymbol === symbol && volume > 0;
        
            logger.debug('Checking position match', {
              tradeId: trade.id,
              positionSymbol,
              expectedSymbol: symbol,
              volume,
              matches
            });
        
            return matches;
          });
      
      if (position) {
        const positionId = position.positionId || position.id;
        const openTs = position.tradeData?.openTimestamp ?? position.openTimestamp;
        const tsMs = protobufLongToNumber(openTs);
        const filledAt = tsMs != null && tsMs > 0 ? new Date(tsMs).toISOString() : undefined;
        const filledPrice = parseFloat(
          position.avgPrice || position.averagePrice || position.price || '0'
        );
        logger.info('Found open cTrader position for trade, entry likely filled', {
          tradeId: trade.id,
          symbol,
          positionId: positionId?.toString(),
          volume: position.volume || position.quantity,
          orderId: trade.order_id,
          filledPrice: filledPrice > 0 ? filledPrice : undefined,
          resolvedViaOrder: !!resolvedPosId,
          exchange: 'ctrader'
        });
        return {
          filled: true,
          positionId: positionId?.toString(),
          filledAt,
          filledPrice: filledPrice > 0 ? filledPrice : undefined,
        };
      }
      
      // Strategy 2: Check open orders by orderId
      if (trade.order_id) {
        logger.info('Checking cTrader open orders', {
          tradeId: trade.id,
          symbol,
          orderId: trade.order_id,
          channel: trade.channel,
          exchange: 'ctrader'
        });
        
        try {
          const openOrders = preFetched?.orders ?? (await ctraderClient.getOpenOrders());
          logger.info('cTrader open orders received', {
            tradeId: trade.id,
            symbol,
            openOrdersCount: openOrders.length,
            channel: trade.channel,
            exchange: 'ctrader'
          });
          
          const order = openOrders.find((o: any) => {
            const oId = o.orderId || o.id;
            const matches = oId?.toString() === trade.order_id;
            
            logger.debug('Checking order match', {
              tradeId: trade.id,
              orderId: oId?.toString(),
              expectedOrderId: trade.order_id,
              matches
            });
            
            return matches;
          });
          
          if (!order) {
            // Order not in open orders - might be filled
            logger.debug('cTrader order not found in open orders, checking positions again', {
              tradeId: trade.id,
              symbol,
              orderId: trade.order_id,
              exchange: 'ctrader'
            });
            
            // Strategy 3: Re-check positions (position might have been created after initial check)
            const positionsAgain = preFetched
              ? preFetched.positions
              : await withCtraderApiTimeout(
                  ctraderClient.getOpenPositions(),
                  CTRADER_RECONCILE_TIMEOUT_MS,
                  'getOpenPositions (checkEntryFilled re-check)'
                );
            const positionAgain = resolvedPosId
              ? positionsAgain.find((p: any) => (p.positionId || p.id)?.toString() === resolvedPosId)
              : positionsAgain.find((p: any) => {
                  const positionSymbol = p.symbolName || p.symbol;
                  const volume = Math.abs(p.volume || p.quantity || 0);
                  return positionSymbol === symbol && volume > 0;
                });
            
            if (positionAgain) {
              const posId = positionAgain.positionId || positionAgain.id;
              const openTs = positionAgain.tradeData?.openTimestamp ?? positionAgain.openTimestamp;
              const tsMs = protobufLongToNumber(openTs);
              const filledAt = tsMs != null && tsMs > 0 ? new Date(tsMs).toISOString() : undefined;
              const filledPrice = parseFloat(
                positionAgain.avgPrice ||
                  positionAgain.averagePrice ||
                  positionAgain.price ||
                  '0'
              );
              logger.info('Found position on re-check after order not found', {
                tradeId: trade.id,
                symbol,
                positionId: posId?.toString(),
                filledPrice: filledPrice > 0 ? filledPrice : undefined,
                exchange: 'ctrader'
              });
              return {
                filled: true,
                positionId: posId?.toString(),
                filledAt,
                filledPrice: filledPrice > 0 ? filledPrice : undefined,
              };
            }
            
            // Order filled but position closed already - verify via order details + deal history
            const [fromTs, toTs] = capDealHistoryWindow(
              new Date(trade.created_at).getTime(),
              Date.now()
            );
            const r = await reconcileCtraderEntryWhenOrderMissingFromOpenList(
              trade,
              ctraderClient,
              symbol,
              fromTs,
              toTs
            );
            if (!r.filled) return { filled: false };
            if (r.alreadyClosed) {
              return {
                filled: true,
                positionId: r.positionId,
                alreadyClosed: true,
                exitPrice: r.exitPrice,
                pnl: r.pnl
              };
            }
            return {
              filled: true,
              positionId: r.positionId,
              filledAt: r.filledAt,
              filledPrice: r.filledPrice
            };
          } else {
            // Order still open - check status
            const orderStatus = order.orderStatus || order.status;
            logger.debug('cTrader order found in open orders', {
              tradeId: trade.id,
              symbol,
              orderId: trade.order_id,
              orderStatus,
              exchange: 'ctrader'
            });
            
            if (orderStatus === 'FILLED' || orderStatus === 'PARTIALLY_FILLED') {
              const positionId = order.positionId || order.id;
              const updTs = order.utcLastUpdateTimestamp ?? order.tradeData?.openTimestamp;
              const tsMs = protobufLongToNumber(updTs);
              const filledAt = tsMs != null && tsMs > 0 ? new Date(tsMs).toISOString() : undefined;
              logger.info('Order status indicates filled', {
                tradeId: trade.id,
                symbol,
                orderId: trade.order_id,
                orderStatus,
                positionId: positionId?.toString(),
                exchange: 'ctrader'
              });
              return { filled: true, positionId: positionId?.toString(), filledAt };
            }
          }
        } catch (error) {
          logger.debug('Error checking cTrader orders, trying deal history fallback', {
            tradeId: trade.id,
            symbol,
            orderId: trade.order_id,
            error: serializeErrorForLog(error),
            exchange: 'ctrader'
          });
          // Fallback: when getOpenOrders times out/fails, use order details + deal history
          const [fromTs, toTs] = capDealHistoryWindow(
            new Date(trade.created_at).getTime(),
            Date.now()
          );
          const r = await reconcileCtraderEntryWhenOrderMissingFromOpenList(
            trade,
            ctraderClient,
            symbol,
            fromTs,
            toTs
          );
          if (!r.filled) return { filled: false };
          if (r.alreadyClosed) {
            return {
              filled: true,
              positionId: r.positionId,
              alreadyClosed: true,
              exitPrice: r.exitPrice,
              pnl: r.pnl
            };
          }
          return {
            filled: true,
            positionId: r.positionId,
            filledAt: r.filledAt,
            filledPrice: r.filledPrice
          };
        }
      } else {
        logger.debug('No order ID available, checking positions only', {
          tradeId: trade.id,
          symbol,
          exchange: 'ctrader'
        });
      }
    }
    return { filled: false };
  } catch (error) {
    logger.error('Error checking cTrader entry filled', {
      tradeId: trade.id,
      error: serializeErrorForLog(error),
      exchange: 'ctrader'
    });
    return { filled: false };
  }
};

/** What the live monitor would do on the next poll for a DB-pending cTrader trade (read-only; no DB writes). */
export type CTraderPendingBotPreview = {
  tradeId: number;
  /** First monitor step: matching open position on exchange for this symbol */
  wouldPromoteActiveViaOpenPosition: boolean;
  wouldCancelDueToExpiry: boolean;
  wouldMarkClosed: boolean;
  wouldMarkActive: boolean;
  wouldRemainPending: boolean;
  summary: string;
  entryFillCheck: {
    filled: boolean;
    alreadyClosed?: boolean;
    positionId?: string;
    exitPrice?: number;
    pnl?: number;
  };
};

/**
 * Read-only preview of live `monitorTrade` outcomes for a pending cTrader row (same order: open-position
 * promotion → expiry → checkEntryFilled). Live expiry also verifies order details before cancel.
 * Use from diagnostics scripts; does not mutate the database.
 */
export const previewCtraderPendingTradeBotOutcome = async (
  trade: Trade,
  ctraderClient: CTraderClient,
  options?: { preFetched?: { positions: any[]; orders: any[] } }
): Promise<CTraderPendingBotPreview> => {
  if (trade.exchange !== 'ctrader') {
    throw new Error(
      `previewCtraderPendingTradeBotOutcome: trade ${trade.id} is exchange=${trade.exchange}, expected ctrader`
    );
  }

  const positions = options?.preFetched?.positions ?? [];
  const symbol = normalizeCTraderSymbol(trade.trading_pair);
  if (trade.status === 'pending' && positions.length > 0) {
    const position = positions.find((p: any) => {
      const positionSymbol = p.symbolName || p.symbol;
      const volume = Math.abs(p.volume || p.quantity || 0);
      return positionSymbol === symbol && volume > 0;
    });
    if (position) {
      const positionId = (position.positionId || position.id)?.toString();
      return {
        tradeId: trade.id,
        wouldPromoteActiveViaOpenPosition: true,
        wouldCancelDueToExpiry: false,
        wouldMarkClosed: false,
        wouldMarkActive: true,
        wouldRemainPending: false,
        summary:
          'Live bot would promote to active from open position match (same as first pending block in monitor).',
        entryFillCheck: {
          filled: true,
          positionId,
        },
      };
    }
  }

  const tradeExpired = await checkTradeExpired(trade, false, undefined);
  if (tradeExpired) {
    return {
      tradeId: trade.id,
      wouldPromoteActiveViaOpenPosition: false,
      wouldCancelDueToExpiry: true,
      wouldMarkClosed: false,
      wouldMarkActive: false,
      wouldRemainPending: false,
      summary:
        'Live bot would cancel due to expiry (runs before entry fill reconciliation when still pending).',
      entryFillCheck: { filled: false },
    };
  }

  const entry = await checkEntryFilled(
    trade,
    ctraderClient,
    false,
    undefined,
    options?.preFetched
  );
  const entryFillCheck = {
    filled: entry.filled,
    alreadyClosed: entry.alreadyClosed,
    positionId: entry.positionId,
    exitPrice: entry.exitPrice,
    pnl: entry.pnl,
  };

  if (entry.filled && entry.alreadyClosed) {
    return {
      tradeId: trade.id,
      wouldPromoteActiveViaOpenPosition: false,
      wouldCancelDueToExpiry: false,
      wouldMarkClosed: true,
      wouldMarkActive: false,
      wouldRemainPending: false,
      summary:
        'Live bot would call updateTradeOnPositionClosed (entry filled + position already closed on exchange).',
      entryFillCheck,
    };
  }
  if (entry.filled && !entry.alreadyClosed) {
    return {
      tradeId: trade.id,
      wouldPromoteActiveViaOpenPosition: false,
      wouldCancelDueToExpiry: false,
      wouldMarkClosed: false,
      wouldMarkActive: true,
      wouldRemainPending: false,
      summary:
        'Live bot would set status active and fill entry order, then continue monitoring (spot + SL/TP).',
      entryFillCheck,
    };
  }

  return {
    tradeId: trade.id,
    wouldPromoteActiveViaOpenPosition: false,
    wouldCancelDueToExpiry: false,
    wouldMarkClosed: false,
    wouldMarkActive: false,
    wouldRemainPending: true,
    summary:
      'Live bot would leave trade pending this poll (no fill detected yet; needs spot price for SL-before-entry on later lines).',
    entryFillCheck,
  };
};

/**
 * Check if position is closed for cTrader
 * Implements retry logic and detailed logging (Gaps #4, #6)
 */
const checkPositionClosed = async (
  trade: Trade,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider,
  preFetchedPositions?: any[],
  preResolvedPositionId?: string
): Promise<{ closed: boolean; exitPrice?: number; pnl?: number }> => {
  try {
    logger.debug('Checking if cTrader position is closed', {
      tradeId: trade.id,
      positionId: trade.position_id,
      symbol: trade.trading_pair,
      exchange: 'ctrader'
    });

    if (isSimulation && priceProvider && trade.entry_filled_at) {
      const currentPrice = await priceProvider.getCurrentPrice(trade.trading_pair);
      if (currentPrice === null) {
        logger.debug('No current price available in simulation', {
          tradeId: trade.id,
          exchange: 'ctrader'
        });
        return { closed: false };
      }

      const takeProfits = JSON.parse(trade.take_profits) as number[];
      const isLong = currentPrice > trade.entry_price;
      
      const stopLossHit = isLong
        ? currentPrice <= trade.stop_loss
        : currentPrice >= trade.stop_loss;
      
      let tpHit = false;
      let hitTP = 0;
      for (const tp of takeProfits) {
        const tpHitCheck = isLong ? currentPrice >= tp : currentPrice <= tp;
        if (tpHitCheck) {
          tpHit = true;
          hitTP = tp;
          break;
        }
      }

      logger.debug('Simulation position close check', {
        tradeId: trade.id,
        isLong,
        currentPrice,
        stopLoss: trade.stop_loss,
        stopLossHit,
        takeProfits,
        tpHit,
        hitTP,
        exchange: 'ctrader'
      });

      if (stopLossHit || tpHit) {
        const exitPrice = currentPrice;
        const priceDiff = exitPrice - trade.entry_price;
        const pnl = isLong ? priceDiff : -priceDiff;
        const positionSize = (trade.entry_price * (trade.risk_percentage / 100)) / Math.abs(priceDiff / trade.entry_price);
        const actualPnl = (pnl / trade.entry_price) * positionSize * trade.leverage;
        
        logger.info('Position closed in simulation', {
          tradeId: trade.id,
          exitPrice,
          pnl: actualPnl,
          stopLossHit,
          tpHit,
          hitTP,
          exchange: 'ctrader'
        });
        
        return {
          closed: true,
          exitPrice,
          pnl: actualPnl
        };
      }
      
      return { closed: false };
    } else if (ctraderClient && trade.order_id && !trade.position_id) {
      // Active trade with order_id but no position_id - order may have filled and position closed on exchange
      const [fromTs, toTs] = capDealHistoryWindow(
        trade.entry_filled_at
          ? new Date(trade.entry_filled_at).getTime()
          : new Date(trade.created_at).getTime(),
        Date.now()
      );
      let resolvedPositionId =
        preResolvedPositionId ??
        (await ctraderClient.getPositionIdByEntryOrderId(trade.order_id, fromTs, toTs));
      if (!resolvedPositionId) {
        const od = await ctraderClient.getOrderDetails(trade.order_id);
        if (od?.order && isCtraderOrderStatusFilled(od.order)) {
          const posRetry = extractPositionIdFromCtraderOrderDetails(od.order, od.deals);
          if (posRetry) {
            resolvedPositionId = posRetry;
          } else if (preFetchedPositions != null) {
            const symbol = normalizeCTraderSymbol(trade.trading_pair);
            const stillOpen = preFetchedPositions.some((p: any) => {
              const positionSymbol = p.symbolName || p.symbol;
              const volume = Math.abs(p.volume || p.quantity || 0);
              return positionSymbol === symbol && volume > 0;
            });
            if (!stillOpen) {
              const exitPx = getCtraderOrderExecutionPrice(od.order);
              logger.info('cTrader entry FILLED, no open position on symbol — marking closed (order execution price)', {
                tradeId: trade.id,
                orderId: trade.order_id,
                exitPrice: exitPx,
                exchange: 'ctrader'
              });
              return { closed: true, exitPrice: exitPx, pnl: undefined };
            }
          }
        }
        if (!resolvedPositionId) {
          logger.info('Cannot resolve position from order_id for close check', {
            tradeId: trade.id,
            orderId: trade.order_id,
            exchange: 'ctrader',
            note: 'Deal list may not contain this order - check time window or orderId'
          });
          return { closed: false };
        }
      }
      // If position is not in open list, exchange says it's closed - trust that over deal volume math
      const positionInOpenList = preFetchedPositions?.some((p: any) => {
        const pid = p.positionId ?? p.id;
        return pid != null && String(pid) === resolvedPositionId;
      });
      const assumeClosed = preFetchedPositions && !positionInOpenList;
      const closedInfo = await getClosedPositionInfoFromDeals(
        ctraderClient,
        resolvedPositionId,
        fromTs,
        toTs,
        assumeClosed
      );
      if (closedInfo.closed) {
        logger.info('cTrader position closed (resolved via order_id, position_id was null)', {
          tradeId: trade.id,
          symbol: trade.trading_pair,
          orderId: trade.order_id,
          positionId: resolvedPositionId,
          exitPrice: closedInfo.exitPrice,
          pnl: closedInfo.pnl,
          exchange: 'ctrader'
        });
        return {
          closed: true,
          exitPrice: closedInfo.exitPrice,
          pnl: closedInfo.pnl,
        };
      }
      return { closed: false };
    } else if (ctraderClient && trade.position_id) {
      const symbol = normalizeCTraderSymbol(trade.trading_pair);
      
      logger.info('Checking if cTrader position closed', {
        tradeId: trade.id,
        symbol,
        positionId: trade.position_id,
        channel: trade.channel,
        exchange: 'ctrader'
      });
      
      // Get positions - use pre-fetched when available to avoid duplicate reconcile
      let positions: any[] = [];
      if (preFetchedPositions) {
        positions = preFetchedPositions;
        logger.info('cTrader positions for close check (pre-fetched)', {
          tradeId: trade.id,
          symbol,
          positionId: trade.position_id,
          positionsCount: positions.length,
          exchange: 'ctrader'
        });
      } else {
        const maxRetries = 1;
        const retryDelay = 1000;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            positions = await ctraderClient.getOpenPositions();
            logger.info('cTrader positions received for close check', {
              tradeId: trade.id,
              symbol,
              positionId: trade.position_id,
              positionsCount: positions.length,
              channel: trade.channel,
              exchange: 'ctrader'
            });
            break;
          } catch (error) {
            logger.debug('Error getting positions for close check, retrying', {
              tradeId: trade.id,
              symbol,
              attempt,
              maxRetries,
              error: serializeErrorForLog(error),
              exchange: 'ctrader'
            });
            if (attempt < maxRetries) await sleep(retryDelay);
          }
        }
      }
      
      const position = positions.find((p: any) => {
        const positionId = p.positionId || p.id;
        const positionSymbol = p.symbolName || p.symbol;
        const matches = positionSymbol === symbol && positionId?.toString() === trade.position_id;
        
        logger.debug('Checking position match for close check', {
          tradeId: trade.id,
          positionId: positionId?.toString(),
          expectedPositionId: trade.position_id,
          positionSymbol,
          expectedSymbol: symbol,
          matches,
          volume: p.volume || p.quantity,
          exchange: 'ctrader'
        });
        
        return matches;
      });
      
      // If position doesn't exist or volume is 0, it's closed (exchange confirms)
      if (!position || Math.abs(position.volume || position.quantity || 0) === 0) {
        logger.info('cTrader position closed', {
          tradeId: trade.id,
          symbol,
          positionId: trade.position_id,
          foundPosition: !!position,
          positionVolume: position ? (position.volume || position.quantity) : 0,
          exchange: 'ctrader',
          note: 'Position not found or volume is zero - position is closed'
        });
        // Get exit price/PNL from position deal history (assumeClosed: exchange already confirmed)
        const [fromTs, toTs] = capDealHistoryWindow(
          trade.entry_filled_at
            ? new Date(trade.entry_filled_at).getTime()
            : new Date(trade.created_at).getTime(),
          Date.now()
        );
        const closedInfo = await getClosedPositionInfoFromDeals(
          ctraderClient,
          trade.position_id!,
          fromTs,
          toTs,
          true
        );
        return {
          closed: true,
          exitPrice: closedInfo.exitPrice,
          pnl: closedInfo.pnl,
        };
      } else {
        logger.debug('Position still open', {
          tradeId: trade.id,
          symbol,
          positionId: trade.position_id,
          volume: position.volume || position.quantity,
          exchange: 'ctrader'
        });
      }
    } else {
      logger.debug('Cannot check position close - missing client or position ID', {
        tradeId: trade.id,
        hasClient: !!ctraderClient,
        hasPositionId: !!trade.position_id,
        exchange: 'ctrader'
      });
    }
    return { closed: false };
  } catch (error) {
    logger.error('Error checking cTrader position closed', {
      tradeId: trade.id,
      positionId: trade.position_id,
      error: serializeErrorForLog(error),
      stack: error instanceof Error ? error.stack : undefined,
      exchange: 'ctrader'
    });
    return { closed: false };
  }
};

/**
 * Cancel order(s) for cTrader.
 */
const cancelOrder = async (
  trade: Trade,
  ctraderClient?: CTraderClient
): Promise<void> => {
  try {
    if (!ctraderClient) return;
    if (trade.order_id) {
      await ctraderClient.cancelOrder(trade.order_id);
      logger.info('cTrader order cancelled', {
        tradeId: trade.id,
        orderId: trade.order_id,
        channel: trade.channel,
        messageId: trade.message_id,
        symbol: trade.trading_pair,
        exchange: 'ctrader'
      });
    }
  } catch (error) {
    logger.error('Error cancelling cTrader order', {
      tradeId: trade.id,
      exchange: 'ctrader',
      orderId: trade.order_id,
      error: serializeErrorForLog(error)
    });
  }
};

/**
 * Check if order is filled for cTrader
 * Implements advanced order querying with detailed logging (Gaps #5, #6)
 * @param openOrders - Optional pre-fetched open orders to avoid repeated reconcile calls (each getOpenOrders = full ProtoOAReconcileReq)
 */
const checkOrderFilled = async (
  order: Order,
  trade: Trade,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider,
  openOrders?: any[]
): Promise<{ filled: boolean; filledPrice?: number }> => {
  try {
    // Position TP marker is on the position, not a separate order - fill is detected when position closes
    if (order.order_id === 'ctrader_position_tp') {
      return { filled: false };
    }

    logger.debug('Checking if cTrader order is filled', {
      orderId: order.id,
      orderType: order.order_type,
      orderPrice: order.price,
      tradeId: trade.id,
      symbol: trade.trading_pair,
      exchange: 'ctrader'
    });

    if (isSimulation && priceProvider) {
      const currentPrice = await priceProvider.getCurrentPrice(trade.trading_pair);
      if (currentPrice === null) {
        logger.debug('No current price available in simulation', {
          orderId: order.id,
          tradeId: trade.id,
          exchange: 'ctrader'
        });
        return { filled: false };
      }

      const isLong = currentPrice > trade.entry_price;
      let filled = false;

      if (order.order_type === 'stop_loss') {
        filled = isLong
          ? currentPrice <= order.price
          : currentPrice >= order.price;
        logger.debug('Simulation SL fill check', {
          orderId: order.id,
          tradeId: trade.id,
          isLong,
          currentPrice,
          slPrice: order.price,
          filled,
          exchange: 'ctrader'
        });
      } else if (order.order_type === 'take_profit' || order.order_type === 'breakeven_limit') {
        filled = isLong
          ? currentPrice >= order.price
          : currentPrice <= order.price;
        logger.debug('Simulation TP/BE fill check', {
          orderId: order.id,
          tradeId: trade.id,
          isLong,
          currentPrice,
          orderPrice: order.price,
          filled,
          exchange: 'ctrader'
        });
      }

      if (filled) {
        logger.info('Order filled in simulation', {
          orderId: order.id,
          orderType: order.order_type,
          tradeId: trade.id,
          filledPrice: currentPrice,
          exchange: 'ctrader'
        });
        return { filled: true, filledPrice: currentPrice };
      }
      return { filled: false };
    } else if (ctraderClient && order.order_id) {
      const symbol = normalizeCTraderSymbol(trade.trading_pair);
      
      // Use pre-fetched open orders when provided to avoid N reconcile calls per trade
      let ordersToCheck = openOrders;
      if (ordersToCheck === undefined) {
        logger.debug('Querying cTrader open orders', {
          orderId: order.id,
          orderType: order.order_type,
          storedOrderId: order.order_id,
          tradeId: trade.id,
          symbol,
          exchange: 'ctrader'
        });
        ordersToCheck = await ctraderClient.getOpenOrders();
      }
      
      logger.debug('Open orders retrieved', {
        orderId: order.id,
        tradeId: trade.id,
        symbol,
        openOrdersCount: ordersToCheck.length,
        exchange: 'ctrader'
      });
      
      const foundOrder = ordersToCheck.find((o: any) => {
        const oId = o.orderId || o.id;
        const matches = oId?.toString() === order.order_id;
        
        logger.debug('Checking order match', {
          orderId: order.id,
          storedOrderId: order.order_id,
          foundOrderId: oId?.toString(),
          matches,
          exchange: 'ctrader'
        });
        
        return matches;
      });
      
      if (!foundOrder) {
        // Order not in open orders, likely filled
        logger.info('Order not found in open orders - likely filled', {
          orderId: order.id,
          orderType: order.order_type,
          storedOrderId: order.order_id,
          tradeId: trade.id,
          symbol,
          exchange: 'ctrader'
        });
        return { filled: true, filledPrice: order.price };
      } else {
        const orderStatus = foundOrder.orderStatus || foundOrder.status;
        logger.debug('Order found in open orders', {
          orderId: order.id,
          orderType: order.order_type,
          storedOrderId: order.order_id,
          orderStatus,
          tradeId: trade.id,
          symbol,
          exchange: 'ctrader'
        });
        
        if (orderStatus === 'FILLED') {
          const filledPrice = foundOrder.filledPrice || foundOrder.executionPrice || order.price;
          const finalPrice = typeof filledPrice === 'number' ? filledPrice : parseFloat(filledPrice || order.price.toString());
          
          logger.info('Order status indicates filled', {
            orderId: order.id,
            orderType: order.order_type,
            storedOrderId: order.order_id,
            orderStatus,
            filledPrice: finalPrice,
            tradeId: trade.id,
            symbol,
            exchange: 'ctrader'
          });
          
          return { filled: true, filledPrice: finalPrice };
        } else {
          logger.debug('Order still pending', {
            orderId: order.id,
            orderType: order.order_type,
            storedOrderId: order.order_id,
            orderStatus,
            tradeId: trade.id,
            exchange: 'ctrader'
          });
        }
      }
    } else {
      logger.debug('Cannot check order fill - missing client or order ID', {
        orderId: order.id,
        tradeId: trade.id,
        hasClient: !!ctraderClient,
        hasOrderId: !!order.order_id,
        exchange: 'ctrader'
      });
    }
    return { filled: false };
  } catch (error) {
    logger.error('Error checking cTrader order filled', {
      orderId: order.id,
      orderType: order.order_type,
      tradeId: trade.id,
      exchange: 'ctrader',
      error: serializeErrorForLog(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return { filled: false };
  }
};

type CTraderEntryFillResult = {
  filled: boolean;
  positionId?: string;
  filledAt?: string;
  filledPrice?: number;
  alreadyClosed?: boolean;
  exitPrice?: number;
  pnl?: number;
};

/** Single getOpenPositions cap when reconcile failed — pending entry fast-path only */
const PENDING_FAST_PATH_GET_POSITIONS_MS = 15_000;

/** Order-details probe when deciding expiry — keep short so expiry runs before MONITOR_TRADE_TIMEOUT_MS */
const PENDING_ENTRY_EXPIRY_ORDER_DETAILS_MS = 20_000;

/**
 * Promote pending→active when an open position is already visible (cached reconcile or bounded fetch).
 */
const promotePendingIfOpenPositionVisible = async (
  trade: Trade,
  db: DatabaseManager,
  ctraderClient: CTraderClient,
  cachedPositions: any[] | undefined,
  preResolvedPositionIds?: Map<string, string>
): Promise<void> => {
  if (trade.status !== 'pending') return;
  let positions: any[] | undefined = cachedPositions;
  if (positions === undefined) {
    try {
      positions = await withCtraderApiTimeout(
        ctraderClient.getOpenPositions(),
        PENDING_FAST_PATH_GET_POSITIONS_MS,
        'getOpenPositions (pending promotion)'
      );
    } catch (error) {
      logger.debug('Pending promotion: could not fetch positions', {
        tradeId: trade.id,
        error: serializeErrorForLog(error),
        exchange: 'ctrader'
      });
      return;
    }
  }
  const symbol = normalizeCTraderSymbol(trade.trading_pair);
  const resolvedPosId = trade.order_id ? preResolvedPositionIds?.get(trade.order_id) : undefined;
  const position = resolvedPosId
    ? positions.find((p: any) => (p.positionId || p.id)?.toString() === resolvedPosId)
    : positions.find((p: any) => {
        const positionSymbol = p.symbolName || p.symbol;
        const volume = Math.abs(p.volume || p.quantity || 0);
        return positionSymbol === symbol && volume > 0;
      });
  if (!position) return;

  const positionId = position.positionId || position.id;
  const fillTime = trade.entry_filled_at || dayjs().toISOString();
  const fillPrice = parseFloat(position.avgPrice || position.averagePrice || position.price || '0');

  logger.info('cTrader entry order filled', {
    tradeId: trade.id,
    tradingPair: trade.trading_pair,
    entryPrice: trade.entry_price,
    fillPrice: fillPrice > 0 ? fillPrice : undefined,
    positionId: positionId?.toString(),
    channel: trade.channel,
    exchange: 'ctrader',
    note: 'Detected via position check - entry was filled but status not updated'
  });

  const updates: { status: 'active'; entry_filled_at: string; position_id?: string; entry_price?: number } = {
    status: 'active',
    entry_filled_at: fillTime,
    position_id: positionId?.toString()
  };
  if (fillPrice > 0) {
    updates.entry_price = fillPrice;
  }
  await db.updateTrade(trade.id, updates);
  trade.status = 'active';
  trade.entry_filled_at = fillTime;
  if (fillPrice > 0) {
    trade.entry_price = fillPrice;
  }
  trade.position_id = positionId?.toString();

  await updateEntryOrderToFilled(trade, db, fillTime, fillPrice > 0 ? fillPrice : undefined);
};

/**
 * Expired pending entry: verify exchange (filled vs still open) before cancel — runs before heavy checkEntryFilled
 * so slow reconcile cannot block expiry for the whole 120s monitor budget.
 */
const handlePendingEntryExpiry = async (
  trade: Trade,
  db: DatabaseManager,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider: HistoricalPriceProvider | undefined
): Promise<'return' | 'noop'> => {
  if (trade.status !== 'pending') return 'noop';
  if (!(await checkTradeExpired(trade, isSimulation, priceProvider))) return 'noop';

  if (isSimulation) {
    logger.info('cTrader trade expired (simulation) — cancelling in DB', {
      tradeId: trade.id,
      orderId: trade.order_id,
      channel: trade.channel,
      messageId: trade.message_id,
      symbol: trade.trading_pair,
      expiresAt: trade.expires_at,
      exchange: 'ctrader'
    });
    await cancelTrade(trade, db);
    const siblings = (await db.getTradesByMessageId(trade.message_id, trade.channel)).filter(
      (t) => t.exchange === 'ctrader' && t.status === 'pending' && t.id !== trade.id
    );
    for (const sibling of siblings) {
      await cancelTrade(sibling, db);
      logger.info('cTrader sibling trade cancelled on expiry (simulation)', {
        siblingTradeId: sibling.id,
        messageId: trade.message_id,
        channel: trade.channel,
        exchange: 'ctrader'
      });
    }
    return 'return';
  }

  const symbol = normalizeCTraderSymbol(trade.trading_pair);
  logger.info('cTrader trade expired - verifying exchange before cancel', {
    tradeId: trade.id,
    orderId: trade.order_id,
    channel: trade.channel,
    messageId: trade.message_id,
    symbol,
    expiresAt: trade.expires_at,
    cancelReason: 'expired',
    exchange: 'ctrader'
  });

  if (!ctraderClient || !trade.order_id) {
    await cancelTrade(trade, db);
    const siblings = (await db.getTradesByMessageId(trade.message_id, trade.channel)).filter(
      (t) => t.exchange === 'ctrader' && t.status === 'pending' && t.id !== trade.id
    );
    for (const sibling of siblings) {
      await cancelTrade(sibling, db);
      logger.info('cTrader sibling trade cancelled on expiry (no client/order id)', {
        siblingTradeId: sibling.id,
        messageId: trade.message_id,
        channel: trade.channel,
        exchange: 'ctrader'
      });
    }
    return 'return';
  }

  let od: Awaited<ReturnType<CTraderClient['getOrderDetails']>> | null | undefined;
  try {
    od = await withCtraderApiTimeout(
      ctraderClient.getOrderDetails(trade.order_id),
      PENDING_ENTRY_EXPIRY_ORDER_DETAILS_MS,
      'getOrderDetails (entry expiry)'
    );
  } catch (error) {
    logger.warn('Expiry: order details timed out or failed — attempting cancel', {
      tradeId: trade.id,
      orderId: trade.order_id,
      error: serializeErrorForLog(error),
      exchange: 'ctrader'
    });
    od = undefined;
  }

  const tryApplyReconcileResult = async (
    r: Awaited<ReturnType<typeof reconcileCtraderEntryWhenOrderMissingFromOpenList>>
  ): Promise<'return' | 'noop'> => {
    if (!r.filled) return 'noop';
    const entry: CTraderEntryFillResult = r.alreadyClosed
      ? {
          filled: true,
          positionId: r.positionId,
          alreadyClosed: true,
          exitPrice: r.exitPrice,
          pnl: r.pnl
        }
      : {
          filled: true,
          positionId: r.positionId,
          filledAt: r.filledAt,
          filledPrice: r.filledPrice
        };
    const outcome = await applyCtraderPendingEntryFillResult(trade, db, entry, 'standard', ctraderClient);
    return outcome === 'return' || outcome === 'continue' ? 'return' : 'noop';
  };

  if (od?.order && isCtraderOrderStatusFilled(od.order)) {
    const [fromTs, toTs] = capDealHistoryWindow(new Date(trade.created_at).getTime(), Date.now());
    const r = await reconcileCtraderEntryWhenOrderMissingFromOpenList(trade, ctraderClient, symbol, fromTs, toTs, {
      prefetchedOrderDetails: od
    });
    const applied = await tryApplyReconcileResult(r);
    if (applied === 'return') return 'return';
  } else if (od === null) {
    const [fromTs, toTs] = capDealHistoryWindow(new Date(trade.created_at).getTime(), Date.now());
    try {
      const r = await reconcileCtraderEntryWhenOrderMissingFromOpenList(trade, ctraderClient, symbol, fromTs, toTs);
      const applied = await tryApplyReconcileResult(r);
      if (applied === 'return') return 'return';
    } catch (error) {
      logger.debug('Expiry: order not found; reconcile fallback failed', {
        tradeId: trade.id,
        error: serializeErrorForLog(error),
        exchange: 'ctrader'
      });
    }
  }

  try {
    await cancelOrder(trade, ctraderClient);
  } catch (error) {
    logger.warn('Expiry: cancel order failed (may already be filled); will retry next poll', {
      tradeId: trade.id,
      orderId: trade.order_id,
      error: serializeErrorForLog(error),
      exchange: 'ctrader'
    });
    return 'noop';
  }
  await cancelTrade(trade, db);
  const siblings = (await db.getTradesByMessageId(trade.message_id, trade.channel)).filter(
    (t) => t.exchange === 'ctrader' && t.status === 'pending' && t.id !== trade.id
  );
  for (const sibling of siblings) {
    try {
      if (sibling.order_id) await cancelOrder(sibling, ctraderClient);
    } catch (error) {
      logger.warn('Expiry: sibling cancel failed', {
        siblingTradeId: sibling.id,
        error: serializeErrorForLog(error),
        exchange: 'ctrader'
      });
    }
    await cancelTrade(sibling, db);
    logger.info('cTrader sibling trade cancelled on expiry', {
      siblingTradeId: sibling.id,
      messageId: trade.message_id,
      channel: trade.channel,
      exchange: 'ctrader'
    });
  }
  return 'return';
};

/**
 * Apply `checkEntryFilled` result for a pending cTrader trade (mutates `trade` in memory).
 * @returns `return` — done (already closed); `continue` — promoted to active; `noop` — not filled
 */
const applyCtraderPendingEntryFillResult = async (
  trade: Trade,
  db: DatabaseManager,
  entryResult: CTraderEntryFillResult,
  source: 'fast_path' | 'standard',
  ctraderClient?: CTraderClient
): Promise<'return' | 'continue' | 'noop'> => {
  if (!entryResult.filled) return 'noop';
  const fillPrice = entryResult.filledPrice;
  if (entryResult.alreadyClosed) {
    logger.info('cTrader entry filled but position already closed by exchange (from deal history)', {
      tradeId: trade.id,
      tradingPair: trade.trading_pair,
      positionId: entryResult.positionId,
      exitPrice: entryResult.exitPrice,
      pnl: entryResult.pnl,
      channel: trade.channel,
      exchange: 'ctrader',
      entryFillSource: source
    });
    const fillTime = entryResult.filledAt ?? dayjs().toISOString();
    const resolvedEntryPrice = fillPrice ?? trade.entry_price;
    await db.updateTrade(trade.id, {
      entry_filled_at: fillTime,
      position_id: entryResult.positionId,
      entry_price: resolvedEntryPrice
    });
    trade.entry_filled_at = fillTime;
    trade.position_id = entryResult.positionId;
    trade.entry_price = resolvedEntryPrice;
    await updateEntryOrderToFilled(trade, db, fillTime, fillPrice);
    await applyCtraderReconciledClose(trade, db, entryResult.exitPrice, entryResult.pnl, ctraderClient);
    return 'return';
  }
  logger.info('cTrader entry order filled', {
    tradeId: trade.id,
    tradingPair: trade.trading_pair,
    entryPrice: trade.entry_price,
    fillPrice,
    positionId: entryResult.positionId,
    channel: trade.channel,
    exchange: 'ctrader',
    entryFillSource: source
  });
  const fillTime = entryResult.filledAt ?? dayjs().toISOString();
  const updates: { status: 'active'; entry_filled_at: string; position_id?: string; entry_price?: number } = {
    status: 'active',
    entry_filled_at: fillTime,
    position_id: entryResult.positionId
  };
  if (fillPrice != null && fillPrice > 0) {
    updates.entry_price = fillPrice;
  }
  await db.updateTrade(trade.id, updates);
  trade.status = 'active';
  trade.entry_filled_at = fillTime;
  trade.position_id = entryResult.positionId;
  if (fillPrice != null && fillPrice > 0) {
    trade.entry_price = fillPrice;
  }
  await updateEntryOrderToFilled(trade, db, fillTime, fillPrice);
  return 'continue';
};

/**
 * Monitor a single cTrader trade
 */
const monitorTrade = async (
  channel: string,
  entryTimeoutMinutes: number,
  trade: Trade,
  db: DatabaseManager,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider: HistoricalPriceProvider | undefined,
  breakevenAfterTPs: number,
  preResolvedPositionIds?: Map<string, string>,
  dynamicBreakevenAfterTPs: boolean = false
): Promise<void> => {
  const timings: Record<string, number> = {};
  let t0 = Date.now();
  const monitorStart = Date.now();
  let pendingEntryFillAttempted = false;

  try {
    // Single reconcile fetch - do early for active trades to detect closed-on-exchange before logging
    let cachedPositions: any[] | undefined;
    let cachedOrders: any[] | undefined;
    if (!isSimulation && ctraderClient) {
      t0 = Date.now();
      try {
        const reconciled = await Promise.race([
          ctraderClient.getOpenPositionsAndOrders(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(`cTrader reconcile timeout after ${CTRADER_RECONCILE_TIMEOUT_MS}ms`)
                ),
              CTRADER_RECONCILE_TIMEOUT_MS
            )
          )
        ]);
        cachedPositions = reconciled.positions;
        cachedOrders = reconciled.orders;
        timings.reconcile = Date.now() - t0;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const isReconcileTimeout = msg.includes('reconcile timeout');
        logger[isReconcileTimeout ? 'warn' : 'debug']('Failed to fetch reconcile, will fetch per-check', {
          tradeId: trade.id,
          error: serializeErrorForLog(error),
          exchange: 'ctrader'
        });
      }

      // Closed-on-exchange check must run even when reconcile failed (otherwise we never detect TP/SL close)
      if (trade.status === 'active' || trade.status === 'filled') {
        t0 = Date.now();
        const positionResultEarly = await checkPositionClosed(
          trade,
          ctraderClient,
          isSimulation,
          priceProvider,
          cachedPositions,
          trade.order_id ? preResolvedPositionIds?.get(trade.order_id) : undefined
        );
        timings.checkPositionClosedEarly = Date.now() - t0;
        if (positionResultEarly.closed) {
          logger.info('cTrader trade closed on exchange - updated (skipping monitor)', {
            tradeId: trade.id,
            symbol: trade.trading_pair,
            orderId: trade.order_id,
            exitPrice: positionResultEarly.exitPrice,
            pnl: positionResultEarly.pnl,
            exchange: 'ctrader'
          });
          await applyCtraderReconciledClose(trade, db, positionResultEarly.exitPrice, positionResultEarly.pnl, ctraderClient);
          return;
        }
      }

      if (trade.status === 'pending' && !isSimulation && ctraderClient) {
        t0 = Date.now();
        await promotePendingIfOpenPositionVisible(trade, db, ctraderClient, cachedPositions, preResolvedPositionIds);
        timings.pendingPositionCheck = Date.now() - t0;
      }
    }

    // Entry expiry before heavy checkEntryFilled / fast-path so API slowness cannot block cancellation for the full monitor budget
    if (trade.status === 'pending') {
      t0 = Date.now();
      const expiryOutcome = await handlePendingEntryExpiry(trade, db, ctraderClient, isSimulation, priceProvider);
      timings.checkTradeExpired = Date.now() - t0;
      if (expiryOutcome === 'return') return;
    }

    if (!isSimulation && ctraderClient) {
      // Pending fast-path: no open position for this symbol → entry may be filled or already closed; run
      // checkEntryFilled after promotion and expiry (still before spot price).
      if (trade.status === 'pending' && trade.order_id) {
        let positionsForFast: any[] | undefined = cachedPositions;
        if (positionsForFast === undefined) {
          t0 = Date.now();
          try {
            positionsForFast = await Promise.race([
              ctraderClient.getOpenPositions(),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () =>
                    reject(
                      new Error(
                        `getOpenPositions timeout after ${PENDING_FAST_PATH_GET_POSITIONS_MS}ms (pending fast-path)`
                      )
                    ),
                  PENDING_FAST_PATH_GET_POSITIONS_MS
                )
              )
            ]);
            timings.pendingFastPathFetchPositions = Date.now() - t0;
          } catch (e) {
            logger.debug('Pending fast-path: could not fetch positions', {
              tradeId: trade.id,
              error: serializeErrorForLog(e),
              exchange: 'ctrader'
            });
            positionsForFast = undefined;
          }
        }
        if (positionsForFast !== undefined) {
          const symbolFast = normalizeCTraderSymbol(trade.trading_pair);
          const hasOpenPositionForSymbol = positionsForFast.some((p: any) => {
            const positionSymbol = p.symbolName || p.symbol;
            const volume = Math.abs(p.volume || p.quantity || 0);
            return positionSymbol === symbolFast && volume > 0;
          });
          if (!hasOpenPositionForSymbol) {
            t0 = Date.now();
            logger.debug('cTrader pending entry fill fast-path (no open position for symbol)', {
              tradeId: trade.id,
              symbol: symbolFast,
              orderId: trade.order_id,
              exchange: 'ctrader'
            });
            const entryResultFast = await checkEntryFilled(
              trade,
              ctraderClient,
              isSimulation,
              priceProvider,
              cachedPositions && cachedOrders ? { positions: cachedPositions, orders: cachedOrders } : undefined,
              preResolvedPositionIds
            );
            timings.checkEntryFilledFast = Date.now() - t0;
            pendingEntryFillAttempted = true;
            const outcome = await applyCtraderPendingEntryFillResult(trade, db, entryResultFast, 'fast_path', ctraderClient);
            if (outcome === 'return') return;
          }
        }
      }
    }

    logger.info('Monitoring cTrader trade', {
      tradeId: trade.id,
      status: trade.status,
      symbol: trade.trading_pair,
      orderId: trade.order_id,
      positionId: trade.position_id,
      channel: trade.channel,
      exchange: 'ctrader'
    });

    // Entry fill / deal-history reconciliation does not use spot price. If getCurrentPrice ran first and
    // returned null (spot timeout, subscribe_failed), we never reached checkEntryFilled — trades stayed
    // pending even after the exchange opened and closed the position (e.g. SL).
    if (trade.status === 'pending' && !pendingEntryFillAttempted) {
      t0 = Date.now();
      logger.debug('Checking if cTrader entry order is filled (before spot price)', {
        tradeId: trade.id,
        symbol: trade.trading_pair,
        orderId: trade.order_id,
        status: trade.status,
        entryPrice: trade.entry_price,
        exchange: 'ctrader'
      });
      const entryResult = await checkEntryFilled(
        trade,
        ctraderClient,
        isSimulation,
        priceProvider,
        cachedPositions && cachedOrders ? { positions: cachedPositions, orders: cachedOrders } : undefined,
        preResolvedPositionIds
      );
      timings.checkEntryFilled = Date.now() - t0;
      logger.debug('cTrader entry fill check result', {
        tradeId: trade.id,
        filled: entryResult.filled,
        positionId: entryResult.positionId,
        exchange: 'ctrader'
      });

      const outcome = await applyCtraderPendingEntryFillResult(trade, db, entryResult, 'standard', ctraderClient);
      if (outcome === 'return') return;
    }

    // Pending only: spot for SL/TP-before-entry. Active trades resolve closure before spot so slow spot cannot block TP close-out.
    if (trade.status === 'pending') {
      t0 = Date.now();
      const currentPricePending = await getCurrentPrice(trade.trading_pair, ctraderClient, isSimulation, priceProvider);
      if (!currentPricePending) {
        logger.warn('Could not get current price for cTrader trade (check prior logs for reason: timeout, subscribe_failed, empty_spot_event)', {
          tradeId: trade.id,
          tradingPair: trade.trading_pair,
          exchange: 'ctrader'
        });
        return;
      }
      timings.getCurrentPrice = Date.now() - t0;

      if (checkSLHitBeforeEntry(trade, currentPricePending)) {
        logger.info('Price hit SL before entry - cancelling cTrader order and sibling trades', {
          tradeId: trade.id,
          currentPrice: currentPricePending,
          stopLoss: trade.stop_loss,
          entryPrice: trade.entry_price,
          exchange: 'ctrader'
        });
        await cancelOrder(trade, ctraderClient);
        await cancelTrade(trade, db);
        const siblings = (await db.getTradesByMessageId(trade.message_id, trade.channel))
          .filter((t) => t.exchange === 'ctrader' && t.status === 'pending' && t.id !== trade.id);
        for (const sibling of siblings) {
          await cancelOrder(sibling, ctraderClient);
          await cancelTrade(sibling, db);
        }
        return;
      }

      if (checkTPHitBeforeEntry(trade, currentPricePending)) {
        logger.info('Price hit TP before entry - TP orders will fill and book profit', {
          tradeId: trade.id,
          currentPrice: currentPricePending,
          entryPrice: trade.entry_price,
          exchange: 'ctrader',
          note: 'Relevant TP Orders will fill at current price and profit will be booked immediately'
        });
      }
    }

    // Monitor active trades
    if (trade.status === 'active' || trade.status === 'filled') {
      const orders = await db.getOrdersByTradeId(trade.id);

      // Check SL/TP orders for fills - use pre-fetched orders when available
      const pendingOrders = orders.filter(o => o.status === 'pending');
      let cachedOpenOrders: any[] | undefined = cachedOrders;
      if (cachedOpenOrders === undefined && pendingOrders.length > 0 && ctraderClient) {
        t0 = Date.now();
        try {
          cachedOpenOrders = await ctraderClient.getOpenOrders();
        } catch (err) {
          logger.warn('Failed to fetch open orders for fill check, will fetch per-order', {
            tradeId: trade.id,
            error: serializeErrorForLog(err),
            exchange: 'ctrader'
          });
        }
        timings.fetchOpenOrders = Date.now() - t0;
      }

      t0 = Date.now();
      for (const order of pendingOrders) {
        const orderResult = await checkOrderFilled(order, trade, ctraderClient, isSimulation, priceProvider, cachedOpenOrders);
        if (orderResult.filled) {
          if (order.order_type === 'take_profit') {
            logger.info('cTrader take profit order filled', {
              tradeId: trade.id,
              tradingPair: trade.trading_pair,
              orderId: order.id,
              tpIndex: order.tp_index,
              tpPrice: order.price,
              filledPrice: orderResult.filledPrice,
              channel: trade.channel,
              exchange: 'ctrader'
            });
          } else if (order.order_type === 'stop_loss') {
            logger.info('cTrader stop loss order filled', {
              tradeId: trade.id,
              tradingPair: trade.trading_pair,
              orderId: order.id,
              slPrice: order.price,
              filledPrice: orderResult.filledPrice,
              channel: trade.channel,
              exchange: 'ctrader'
            });
          } else {
            logger.info('cTrader order filled', {
              tradeId: trade.id,
              orderId: order.id,
              orderType: order.order_type,
              filledPrice: orderResult.filledPrice,
              exchange: 'ctrader'
            });
          }

          await updateOrderToFilled(order, db, orderResult.filledPrice);

          if (order.order_type === 'stop_loss') {
            await updateTradeOnStopLossHit(trade, db, orderResult.filledPrice);
          }
        }
      }
      timings.checkOrderFillsLoop = Date.now() - t0;

      // Check if enough TPs filled to move SL to breakeven.
      // cTrader splits signals into N trades (one per TP), each with its own position.
      // We often persist `closed` for both TP and SL exits — classify via exit_price vs TP/SL/entry, else deals grossProfit.
      if (!trade.stop_loss_breakeven) {
        const allSiblings = await db.getTradesByMessageId(trade.message_id, trade.channel);
        const totalTpLevels = allSiblings.filter(
          (t) => t.exchange === 'ctrader' && t.account_name === trade.account_name
        ).length;
        const effectiveBreakevenAfterTPs = resolveBreakevenAfterTPs(totalTpLevels, {
          breakevenAfterTPs,
          dynamicBreakevenAfterTPs
        });
        const siblingsHitTp = await countCtraderSiblingsClosedAtTakeProfit(
          allSiblings,
          trade.id,
          trade.account_name,
          ctraderClient
        );

        if (siblingsHitTp >= effectiveBreakevenAfterTPs) {
          try {
            const bePrice = await getEntryFillPrice(trade, db, { ctraderClient });
            const symbol = normalizeCTraderSymbol(trade.trading_pair);
            const symbolInfo = ctraderClient ? await ctraderClient.getSymbolInfo(symbol) : undefined;

            const rawDigits = symbolInfo?.digits;
            const digits = typeof rawDigits === 'number' ? rawDigits : (typeof rawDigits === 'object' && rawDigits?.low != null ? rawDigits.low : 2);
            const tickSize = Math.pow(10, -digits);

            const rawSl = symbolInfo?.slDistance;
            const slDistance = typeof rawSl === 'number' ? rawSl : (typeof rawSl === 'object' && rawSl != null ? (protobufLongToNumber(rawSl) ?? 0) : 0);
            let minNudge = tickSize;
            if (slDistance > 0) {
              const rawDistType = symbolInfo?.distanceSetIn ?? (symbolInfo as any)?.distance_set_in;
              const distType = typeof rawDistType === 'number' ? rawDistType : (typeof rawDistType === 'object' && rawDistType?.low != null ? rawDistType.low : 1);
              if (distType === 2) {
                minNudge = Math.max(tickSize, bePrice * (slDistance / 10000));
              } else {
                minNudge = Math.max(tickSize, slDistance * Math.pow(10, -digits));
              }
            }

            const isLong = getIsLong(trade);
            const rawSlPrice = isLong ? bePrice - minNudge : bePrice + minNudge;
            const slPrice = Math.round(rawSlPrice * Math.pow(10, digits)) / Math.pow(10, digits);

            if (ctraderClient && trade.position_id) {
              await ctraderClient.modifyPosition({
                positionId: trade.position_id,
                stopLoss: slPrice
              });
            }

            await db.updateTrade(trade.id, {
              stop_loss: slPrice,
              stop_loss_breakeven: true
            });
            trade.stop_loss = slPrice;
            trade.stop_loss_breakeven = true;

            logger.info('Required take profits hit - moved cTrader stop loss to breakeven', {
              tradeId: trade.id,
              siblingsHitTp,
              breakevenAfterTPs: effectiveBreakevenAfterTPs,
              totalTpLevels,
              dynamicBreakevenAfterTPs,
              bePrice,
              slPrice,
              exchange: 'ctrader'
            });
          } catch (beError) {
            logger.error('Error moving stop loss to breakeven on cTrader', {
              tradeId: trade.id,
              siblingsHitTp,
              breakevenAfterTPs: effectiveBreakevenAfterTPs,
              totalTpLevels,
              dynamicBreakevenAfterTPs,
              channel: trade.channel,
              exchange: 'ctrader',
              error: serializeErrorForLog(beError)
            });
          }
        }
      }

      // Check if position is closed (use pre-fetched positions when available)
      t0 = Date.now();
      const positionResult = await checkPositionClosed(
        trade,
        ctraderClient,
        isSimulation,
        priceProvider,
        cachedPositions,
        trade.order_id ? preResolvedPositionIds?.get(trade.order_id) : undefined
      );
      timings.checkPositionClosed = Date.now() - t0;
      if (positionResult.closed) {
        logger.info('cTrader position closed', {
          tradeId: trade.id,
          exitPrice: positionResult.exitPrice,
          pnl: positionResult.pnl,
          exchange: 'ctrader'
        });
        await applyCtraderReconciledClose(trade, db, positionResult.exitPrice, positionResult.pnl, ctraderClient);
        return;
      }

      t0 = Date.now();
      const currentPriceActive = await getCurrentPrice(trade.trading_pair, ctraderClient, isSimulation, priceProvider);
      if (!currentPriceActive) {
        logger.warn('Could not get current price for cTrader trade (check prior logs for reason: timeout, subscribe_failed, empty_spot_event)', {
          tradeId: trade.id,
          tradingPair: trade.trading_pair,
          exchange: 'ctrader'
        });
        return;
      }
      timings.getCurrentPrice = Date.now() - t0;

      // Check if stop loss is hit
      if (checkStopLossHit(trade, currentPriceActive)) {
        logger.info('cTrader stop loss hit', {
          tradeId: trade.id,
          currentPrice: currentPriceActive,
          stopLoss: trade.stop_loss,
          exchange: 'ctrader'
        });
        
        const stopLossResult = await checkPositionClosed(
          trade,
          ctraderClient,
          isSimulation,
          priceProvider,
          cachedPositions,
          trade.order_id ? preResolvedPositionIds?.get(trade.order_id) : undefined
        );
        if (stopLossResult.closed) {
          await applyCtraderReconciledClose(trade, db, stopLossResult.exitPrice, stopLossResult.pnl, ctraderClient);
        } else {
          await db.updateTrade(trade.id, { status: 'stopped' });
        }
      }
    }
  } catch (error) {
    logger.error('Error monitoring cTrader trade', {
      tradeId: trade.id,
      exchange: 'ctrader',
      error: serializeErrorForLog(error)
    });
  } finally {
    const totalElapsedMs = Date.now() - monitorStart;
    const sumOfPhasesMs = Object.values(timings).reduce((a, b) => a + b, 0);
    logger.log('trace', 'cTrader monitor trade timings', {
      tradeId: trade.id,
      channel,
      exchange: 'ctrader',
      totalElapsedMs,
      sumOfPhasesMs,
      timings
    });
  }
};

/**
 * Start cTrader trade monitor
 */
export const startCTraderMonitor = async (
  monitorConfig: MonitorConfig,
  channel: string,
  db: DatabaseManager,
  isSimulation: boolean = false,
  priceProvider?: HistoricalPriceProvider,
  speedMultiplier?: number,
  getCTraderClient?: (accountName?: string) => Promise<CTraderClient | undefined>
): Promise<() => Promise<void>> => {
  logger.info('Starting cTrader trade monitor', { type: monitorConfig.type, channel });

  // Legacy support: create a single cTrader client if getCTraderClient not provided
  let ctraderClient: CTraderClient | undefined;
  if (!getCTraderClient) {
    const accessToken = process.env.CTRADER_ACCESS_TOKEN;
    const accountId = process.env.CTRADER_ACCOUNT_ID;
    const clientId = process.env.CTRADER_CLIENT_ID;
    const clientSecret = process.env.CTRADER_CLIENT_SECRET;

    if (!accessToken || !accountId) {
      logger.error('cTrader credentials not found in environment variables', {
        channel,
        missing: !accessToken ? 'CTRADER_ACCESS_TOKEN' : 'CTRADER_ACCOUNT_ID'
      });
      throw new Error('cTrader credentials required for ctrader monitor');
    }

    const clientConfig = {
      clientId: clientId || '',
      clientSecret: clientSecret || '',
      accessToken,
      accountId,
      environment: 'demo' as 'demo' | 'live',
      ...(monitorConfig.ctraderSymbolMap && Object.keys(monitorConfig.ctraderSymbolMap).length > 0 && { symbolMap: monitorConfig.ctraderSymbolMap }),
      ...(monitorConfig.ctraderSpotPriceTimeoutMs != null && { spotPriceTimeoutMs: monitorConfig.ctraderSpotPriceTimeoutMs }),
      ...(monitorConfig.ctraderSpotPriceMaxRetries != null && { spotPriceMaxRetries: monitorConfig.ctraderSpotPriceMaxRetries })
    };

    ctraderClient = new CTraderClient(clientConfig);
    try {
      await ctraderClient.connect();
      await ctraderClient.authenticate();
      logger.info('cTrader monitor client initialized', {
        channel,
        type: monitorConfig.type,
        exchange: 'ctrader'
      });
    } catch (error) {
      logger.error('Failed to initialize cTrader client', {
        channel,
        exchange: 'ctrader',
        error: serializeErrorForLog(error)
      });
      throw error;
    }
  }

  let running = true;
  const pollInterval = monitorConfig.pollInterval || 10000;
  const entryTimeoutMinutes = monitorConfig.entryTimeoutMinutes || 2880;
  const breakevenAfterTPs = monitorConfig.breakevenAfterTPs ?? 1;
  const dynamicBreakevenAfterTPs = monitorConfig.dynamicBreakevenAfterTPs ?? false;
  const concurrency = monitorConfig.ctraderMonitorConcurrency ?? 2;
  const limit = pLimit(concurrency);

  const monitorLoop = async (): Promise<void> => {
    const isMaxSpeed = speedMultiplier !== undefined && (speedMultiplier === 0 || speedMultiplier === Infinity || !isFinite(speedMultiplier));
    
    while (running) {
      try {
        const trades = (await db.getActiveTrades()).filter(t => t.channel === channel && t.exchange === 'ctrader');

        // Batch-resolve positionIds for trades with order_id but no position_id - one getDealList per account
        // instead of per-trade, to stay under cTrader historical rate limit (5 req/sec)
        const preResolvedPositionIds = !isSimulation
          ? await resolvePositionIdsBatch(trades, getCTraderClient, ctraderClient)
          : new Map<string, string>();

        // Process trades with limited concurrency - avoids bursting cTrader historical API (5 req/sec limit)
        const tradeTasks = trades.map((trade) =>
          limit(async () => {
            const accountCTraderClient = getCTraderClient
              ? await getCTraderClient(trade.account_name)
              : ctraderClient;
            if (!accountCTraderClient) {
              logger.warn('No cTrader client for trade - cannot check position or cancel orders', {
                tradeId: trade.id,
                channel,
                accountName: trade.account_name ?? '(none)',
                exchange: 'ctrader'
              });
            }
            return Promise.race([
              monitorTrade(
                channel,
                entryTimeoutMinutes,
                trade,
                db,
                accountCTraderClient,
                isSimulation,
                priceProvider,
                breakevenAfterTPs,
                preResolvedPositionIds,
                dynamicBreakevenAfterTPs
              ),
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error(`Trade ${trade.id} monitor timeout after ${MONITOR_TRADE_TIMEOUT_MS}ms`)), MONITOR_TRADE_TIMEOUT_MS)
              )
            ]);
          })
        );

        const results = await Promise.allSettled(tradeTasks);
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result.status === 'rejected') {
            const trade = trades[i];
            const isTimeout = result.reason instanceof Error && result.reason.message.includes('timeout');
            logger.warn(isTimeout ? 'Monitor trade timed out - will retry next poll' : 'Monitor trade failed', {
              tradeId: trade.id,
              channel,
              exchange: 'ctrader',
              error: serializeErrorForLog(result.reason)
            });
          }
        }

        if (!isMaxSpeed) {
          await sleep(pollInterval);
        } else {
          await new Promise(resolve => setImmediate(resolve));
        }
      } catch (error) {
        logger.error('Error in cTrader monitor loop', {
          channel,
          exchange: 'ctrader',
          error: serializeErrorForLog(error)
        });
        if (!isMaxSpeed) {
          await sleep(pollInterval * 2);
        }
      }
    }
  };

  monitorLoop().catch(error => {
    logger.error('Fatal error in cTrader monitor loop', {
      channel,
      exchange: 'ctrader',
      error: serializeErrorForLog(error)
    });
  });

  return async (): Promise<void> => {
    logger.info('Stopping cTrader trade monitor', { type: monitorConfig.type, channel, exchange: 'ctrader' });
    running = false;
  };
};

