/**
 * cTrader management execution verification
 *
 * Queries cTrader deal history to confirm that management commands
 * (e.g. partial close, move SL to breakeven) actually executed on the exchange.
 */

import { logger } from '../../utils/logger.js';
import type { CTraderClient } from '../../clients/ctraderClient.js';

export interface CTraderClosingDeal {
  dealId: string;
  positionId: string;
  volume: number;
  executionTimestamp: number;
  executionPrice?: number;
  tradeSide?: string;  // "BUY" | "SELL" (mapped from protobuf enum)
  grossProfit?: number;
  /** SL price from the closing order (if STOP_LOSS_TAKE_PROFIT) */
  stopLoss?: number;
  /** TP price from the closing order (if STOP_LOSS_TAKE_PROFIT) */
  takeProfit?: number;
  /** How position was closed: SL hit, TP hit, or manual/management */
  closedBy?: 'SL' | 'TP' | 'manual';
  /** Order type: STOP_LOSS_TAKE_PROFIT, MARKET, etc. */
  orderType?: string;
  /** True when grossProfit was estimated (API did not provide closePositionDetail) */
  grossProfitEstimated?: boolean;
}

export interface CTraderManagementExecutionResult {
  closingDealsCount: number;
  closingDeals: CTraderClosingDeal[];
  error?: string;
}

/**
 * Query cTrader for closing deals in a time window.
 * Closing deals have closePositionDetail - they represent partial or full position closes.
 * Use this to verify that a management command (e.g. "secure half and hold with BE") executed.
 */
export async function queryCTraderClosingDeals(
  ctraderClient: CTraderClient,
  fromTimestamp: number,
  toTimestamp: number
): Promise<CTraderManagementExecutionResult> {
  const result: CTraderManagementExecutionResult = {
    closingDealsCount: 0,
    closingDeals: []
  };

  const ORDER_TYPE_NAMES: Record<number, string> = {
    1: 'MARKET', 2: 'LIMIT', 3: 'STOP', 4: 'STOP_LOSS_TAKE_PROFIT', 5: 'MARKET_RANGE', 6: 'STOP_LIMIT'
  };

  try {
    const [deals, closedOrders] = await Promise.all([
      ctraderClient.getDealList(fromTimestamp, toTimestamp),
      ctraderClient.getClosedOrders(fromTimestamp, toTimestamp)
    ]);
    const closingDeals = deals.filter((d: any) => {
      const detail = d.closePositionDetail ?? d.close_position_detail;
      return detail != null;
    });

    const orderById = new Map<string, any>();
    for (const o of closedOrders) {
      const id = String(o.orderId ?? o.id ?? '');
      if (id) orderById.set(id, o);
    }

    result.closingDealsCount = closingDeals.length;
    const { protobufLongToNumber } = await import('../../utils/protobufLong.js');
    const toNum = (v: any) => (typeof v === 'object' && v?.low != null ? protobufLongToNumber(v) : v);

    result.closingDeals = closingDeals.map((d: any) => {
      const posId = d.positionId ?? d.position_id;
      const vol = d.volume ?? d.filledVolume ?? d.filled_volume ?? 0;
      const ts = d.executionTimestamp ?? d.execution_timestamp ?? 0;
      const grossProfit = d.closePositionDetail?.grossProfit ?? d.close_position_detail?.grossProfit;
      const rawSide = d.tradeSide ?? d.trade_side;
      const tradeSide = rawSide === 1 || rawSide === 'BUY' ? 'BUY' : rawSide === 2 || rawSide === 'SELL' ? 'SELL' : rawSide != null ? String(rawSide) : undefined;
      const execPrice = d.executionPrice ?? d.execution_price;
      const orderId = String(d.orderId ?? d.order_id ?? '');
      const order = orderById.get(orderId);

      let stopLoss: number | undefined;
      let takeProfit: number | undefined;
      let closedBy: 'SL' | 'TP' | 'manual' | undefined;
      let orderType: string | undefined;

      if (order) {
        const rawType = order.orderType ?? order.order_type;
        orderType = typeof rawType === 'number' ? ORDER_TYPE_NAMES[rawType] : rawType != null ? String(rawType) : undefined;
        stopLoss = order.stopLoss ?? order.stop_loss;
        takeProfit = order.takeProfit ?? order.take_profit;

        if (orderType === 'STOP_LOSS_TAKE_PROFIT' && execPrice != null && (stopLoss != null || takeProfit != null)) {
          const sl = stopLoss != null ? Number(stopLoss) : NaN;
          const tp = takeProfit != null ? Number(takeProfit) : NaN;
          const eps = Math.max(1e-8, Math.abs(execPrice) * 0.0001);
          if (!isNaN(sl) && Math.abs(execPrice - sl) < eps) closedBy = 'SL';
          else if (!isNaN(tp) && Math.abs(execPrice - tp) < eps) closedBy = 'TP';
          else if (!isNaN(sl) && !isNaN(tp)) {
            closedBy = Math.abs(execPrice - sl) < Math.abs(execPrice - tp) ? 'SL' : 'TP';
          }
        } else if (orderType === 'MARKET') {
          closedBy = 'manual';
        }
      }

      return {
        dealId: String(d.dealId ?? d.deal_id ?? ''),
        positionId: posId != null ? String(toNum(posId) ?? posId) : '',
        volume: toNum(vol) ?? vol,
        executionTimestamp: toNum(ts) ?? ts,
        executionPrice: execPrice,
        tradeSide,
        grossProfit: grossProfit != null ? toNum(grossProfit) : undefined,
        stopLoss,
        takeProfit,
        closedBy,
        orderType
      };
    });

    if (closingDeals.length > 0) {
      logger.info('cTrader closing deals found', {
        count: closingDeals.length,
        window: `[${new Date(fromTimestamp).toISOString()}, ${new Date(toTimestamp).toISOString()}]`
      });
    }
  } catch (error) {
    logger.warn('Failed to query cTrader closing deals', {
      error: error instanceof Error ? error.message : String(error)
    });
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

/**
 * Get closing deals for a specific position.
 * Uses getDealListByPositionId — position-scoped, so we get all deals that closed this position
 * (50% partial, TP hit, SL hit, etc.). More reliable than filtering account-wide getDealList.
 * When grossProfit is missing from the API, estimates it from (execPrice - entryPrice) * volume if entryPrice provided.
 */
export async function queryCTraderPositionClosingDeals(
  ctraderClient: CTraderClient,
  positionId: string,
  fromTimestamp: number,
  toTimestamp: number,
  options?: { entryPrice?: number; isLong?: boolean }
): Promise<{ closingDeals: CTraderClosingDeal[]; error?: string }> {
  const result: { closingDeals: CTraderClosingDeal[]; error?: string } = { closingDeals: [] };
  const ORDER_TYPE_NAMES: Record<number, string> = {
    1: 'MARKET', 2: 'LIMIT', 3: 'STOP', 4: 'STOP_LOSS_TAKE_PROFIT', 5: 'MARKET_RANGE', 6: 'STOP_LIMIT'
  };

  try {
    const { protobufLongToNumber } = await import('../../utils/protobufLong.js');
    const toNum = (v: any) => (typeof v === 'object' && v?.low != null ? protobufLongToNumber(v) : v);

    const [positionDeals, closedOrders, accountDeals] = await Promise.all([
      ctraderClient.getDealListByPositionId(positionId, fromTimestamp, toTimestamp),
      ctraderClient.getClosedOrders(fromTimestamp, toTimestamp),
      ctraderClient.getDealList(fromTimestamp, toTimestamp, 5000)
    ]);

    const accountDealById = new Map<string, any>();
    for (const d of accountDeals) {
      const id = String(toNum(d.dealId ?? d.deal_id) ?? d.dealId ?? d.deal_id ?? '');
      if (id) accountDealById.set(id, d);
    }

    const orderById = new Map<string, any>();
    for (const o of closedOrders) {
      const rawId = o.orderId ?? o.id;
      const id = rawId != null ? String(toNum(rawId) ?? rawId) : '';
      if (id) {
        orderById.set(id, o);
        orderById.set(String(rawId), o);
      }
    }

    const closingDealsRaw = positionDeals.filter((d: any) => {
      const detail = d.closePositionDetail ?? d.close_position_detail;
      if (detail != null) return true;
      const rawOrderId = d.orderId ?? d.order_id;
      const orderId = rawOrderId != null ? String(toNum(rawOrderId) ?? rawOrderId) : '';
      const order = orderById.get(orderId) ?? orderById.get(String(rawOrderId));
      return order && (order.closingOrder === true || order.closing_order === true);
    });

    result.closingDeals = closingDealsRaw.map((d: any) => {
      const dealIdStr = String(toNum(d.dealId ?? d.deal_id) ?? d.dealId ?? d.deal_id ?? '');
      const accountDeal = accountDealById.get(dealIdStr);
      const posId = d.positionId ?? d.position_id;
      const vol = d.volume ?? d.filledVolume ?? d.filled_volume ?? 0;
      const ts = d.executionTimestamp ?? d.execution_timestamp ?? 0;
      let grossProfit = d.closePositionDetail?.grossProfit ?? d.close_position_detail?.grossProfit;
      if (grossProfit == null && accountDeal) {
        const ad = accountDeal.closePositionDetail ?? accountDeal.close_position_detail;
        grossProfit = ad?.grossProfit ?? ad?.gross_profit;
      }
      const rawSide = d.tradeSide ?? d.trade_side;
      const tradeSide = rawSide === 1 || rawSide === 'BUY' ? 'BUY' : rawSide === 2 || rawSide === 'SELL' ? 'SELL' : rawSide != null ? String(rawSide) : undefined;
      const execPrice = d.executionPrice ?? d.execution_price;
      const rawOrderId = d.orderId ?? d.order_id;
      const orderId = String(rawOrderId ?? '');
      const order = orderById.get(orderId) ?? orderById.get(String(rawOrderId));

      let stopLoss: number | undefined;
      let takeProfit: number | undefined;
      let closedBy: 'SL' | 'TP' | 'manual' | undefined;
      let orderType: string | undefined;

      let execPriceNum = execPrice != null ? (typeof execPrice === 'number' ? execPrice : Number(toNum(execPrice) ?? execPrice)) : undefined;
      if (execPriceNum == null || isNaN(execPriceNum)) {
        const orderExec = order?.executionPrice ?? order?.execution_price;
        execPriceNum = orderExec != null ? (typeof orderExec === 'number' ? orderExec : Number(toNum(orderExec) ?? orderExec)) : undefined;
      }

      let grossProfitEstimated = false;
      if (grossProfit == null && options?.entryPrice != null && execPriceNum != null) {
        const volNum = Number(toNum(vol)) || 0;
        const volLots = volNum > 0 ? volNum / 100 : 0;
        const pnlPerLot = options.isLong !== false
          ? execPriceNum - options.entryPrice
          : options.entryPrice - execPriceNum;
        grossProfit = Math.round(pnlPerLot * volLots * 100) as any;
        grossProfitEstimated = true;
      }

      if (order) {
        const rawType = order.orderType ?? order.order_type;
        orderType = typeof rawType === 'number' ? ORDER_TYPE_NAMES[rawType] : rawType != null ? String(rawType) : undefined;
        stopLoss = order.stopLoss ?? order.stop_loss;
        takeProfit = order.takeProfit ?? order.take_profit;

        if (orderType === 'STOP_LOSS_TAKE_PROFIT' && execPriceNum != null && (stopLoss != null || takeProfit != null)) {
          const sl = stopLoss != null ? Number(stopLoss) : NaN;
          const tp = takeProfit != null ? Number(takeProfit) : NaN;
          const eps = Math.max(1e-8, Math.abs(execPriceNum) * 0.0001);
          if (!isNaN(sl) && Math.abs(execPriceNum - sl) < eps) closedBy = 'SL';
          else if (!isNaN(tp) && Math.abs(execPriceNum - tp) < eps) closedBy = 'TP';
          else if (!isNaN(sl) && !isNaN(tp)) {
            closedBy = Math.abs(execPriceNum - sl) < Math.abs(execPriceNum - tp) ? 'SL' : 'TP';
          }
        } else if (orderType === 'MARKET') {
          closedBy = 'manual';
        }
      }

      return {
        dealId: String(toNum(d.dealId ?? d.deal_id) ?? d.dealId ?? d.deal_id ?? ''),
        positionId: posId != null ? String(toNum(posId) ?? posId) : '',
        volume: toNum(vol) ?? vol,
        executionTimestamp: toNum(ts) ?? ts,
        executionPrice: execPriceNum,
        tradeSide,
        grossProfit: grossProfit != null ? toNum(grossProfit) : undefined,
        grossProfitEstimated,
        stopLoss,
        takeProfit,
        closedBy,
        orderType
      };
    });

    result.closingDeals.sort((a, b) => (a.executionTimestamp ?? 0) - (b.executionTimestamp ?? 0));
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to query cTrader position closing deals', {
      positionId,
      error: result.error
    });
  }
  return result;
}

export interface CTraderPositionSlVerification {
  verified: boolean;
  stopLossAtEntry: boolean;
  ordersWithSl: Array<{ orderId: string; stopLoss: number; takeProfit?: number; orderType?: string }>;
  /** Narrative from closing orders: helps understand the position story */
  narrative?: {
    /** Position closed at TP — SL was never hit */
    closedAtTp?: boolean;
    /** Closing order had SL matching original (pre-BE) — suggests SL may not have been reset */
    slMatchesOriginal?: boolean;
    /** Closing order SL value when it differs from entry */
    closingOrderSl?: number;
  };
  error?: string;
}

/**
 * Verify that the position's stop loss was moved to breakeven.
 * 1. Primary: Check original position orders (opening deal, position-linked non-closing orders).
 * 2. Fallback: Check closing orders — any order in the position's history may have stopLoss.
 * 3. Narrative: Use closing orders to flesh out the story — closed at TP vs original SL, etc.
 */
export async function queryCTraderPositionSlLevel(
  ctraderClient: CTraderClient,
  positionId: string,
  entryPrice: number,
  fromTimestamp: number,
  toTimestamp: number,
  options?: {
    /** Original (pre-BE) stop loss from signal — if closing order matches this, SL likely wasn't reset */
    originalStopLoss?: number;
    /** TP prices from the trade — if execution matches, position closed at TP */
    tpPrices?: number[];
  }
): Promise<CTraderPositionSlVerification> {
  const result: CTraderPositionSlVerification = {
    verified: false,
    stopLossAtEntry: false,
    ordersWithSl: []
  };

  const tolerance = Math.max(0.01, entryPrice * 0.0001);
  const ORDER_TYPE_NAMES: Record<number, string> = {
    1: 'MARKET', 2: 'LIMIT', 3: 'STOP', 4: 'STOP_LOSS_TAKE_PROFIT', 5: 'MARKET_RANGE', 6: 'STOP_LIMIT'
  };

  try {
    const { protobufLongToNumber } = await import('../../utils/protobufLong.js');
    const toNum = (v: any) => (typeof v === 'object' && v?.low != null ? protobufLongToNumber(v) : v);

    const [positionDeals, closedOrders] = await Promise.all([
      ctraderClient.getDealListByPositionId(positionId, fromTimestamp, toTimestamp),
      ctraderClient.getClosedOrders(fromTimestamp, toTimestamp)
    ]);

    // Only the opening deal represents the original position; closing deals (50%, TP) don't have the position's SL
    const openingDeals = positionDeals.filter((d: any) => {
      const detail = d.closePositionDetail ?? d.close_position_detail;
      return detail == null;
    });

    const orderById = new Map<string, any>();
    for (const o of closedOrders) {
      const rawId = o.orderId ?? o.id;
      const id = rawId != null ? String(toNum(rawId) ?? rawId) : '';
      if (id) {
        orderById.set(id, o);
        orderById.set(String(rawId), o);
      }
    }

    const entryOrderIds = new Set<string>();
    for (const deal of openingDeals) {
      const rawOrderId = deal.orderId ?? deal.order_id;
      const orderId = rawOrderId != null ? String(toNum(rawOrderId) ?? rawOrderId) : '';
      if (orderId && orderId !== 'undefined') entryOrderIds.add(orderId);
    }

    // Also consider closed orders linked to this position that are NOT closing orders (50%, TP close)
    const posIdNum = positionId;
    for (const o of closedOrders) {
      const rawPosId = o.positionId ?? o.position_id;
      const oPosId = rawPosId != null ? String(toNum(rawPosId) ?? rawPosId) : '';
      if (oPosId !== posIdNum) continue;
      if (o.closingOrder === true || o.closing_order === true) continue; // skip 50% and TP close orders
      const rawOrderId = o.orderId ?? o.id;
      const orderId = rawOrderId != null ? String(toNum(rawOrderId) ?? rawOrderId) : '';
      if (orderId) entryOrderIds.add(orderId);
    }

    const checkOrderForSl = (order: any, orderId: string) => {
      const sl = order.stopLoss ?? order.stop_loss;
      if (sl == null || typeof sl !== 'number') return false;
      const orderType = typeof (order.orderType ?? order.order_type) === 'number'
        ? ORDER_TYPE_NAMES[order.orderType ?? order.order_type]
        : order.orderType ?? order.order_type;
      result.ordersWithSl.push({
        orderId,
        stopLoss: sl,
        takeProfit: order.takeProfit ?? order.take_profit,
        orderType
      });
      if (Math.abs(sl - entryPrice) < tolerance) {
        result.stopLossAtEntry = true;
        result.verified = true;
      }
      return true;
    };

    for (const orderId of entryOrderIds) {
      const order = orderById.get(orderId);
      if (!order) continue;
      checkOrderForSl(order, orderId);
    }

    // Fallback: if no SL found on original-position orders, check closing orders
    const closingDeals = positionDeals.filter((d: any) => {
      const detail = d.closePositionDetail ?? d.close_position_detail;
      return detail != null;
    });
    if (result.ordersWithSl.length === 0) {
      const seen = new Set(entryOrderIds);
      for (const deal of closingDeals) {
        const rawOrderId = deal.orderId ?? deal.order_id;
        const orderId = rawOrderId != null ? String(toNum(rawOrderId) ?? rawOrderId) : '';
        if (!orderId || seen.has(orderId)) continue;
        seen.add(orderId);
        const order = orderById.get(orderId);
        if (!order) continue;
        checkOrderForSl(order, orderId);
      }
    }

    // Narrative from closing orders — flesh out the position story
    const { originalStopLoss, tpPrices } = options ?? {};
    let narrative: CTraderPositionSlVerification['narrative'] = {};
    for (const deal of closingDeals) {
      const rawOrderId = deal.orderId ?? deal.order_id;
      const orderId = rawOrderId != null ? String(toNum(rawOrderId) ?? rawOrderId) : '';
      const order = orderById.get(orderId) ?? orderById.get(String(rawOrderId));
      const execPriceRaw = deal.executionPrice ?? deal.execution_price;
      const execPrice = execPriceRaw != null ? (typeof execPriceRaw === 'number' ? execPriceRaw : Number(execPriceRaw)) : undefined;
      const sl = order?.stopLoss ?? order?.stop_loss;

      if (tpPrices != null && tpPrices.length > 0 && execPrice != null && typeof execPrice === 'number') {
        const matchesTp = tpPrices.some((tp) => Math.abs(execPrice - tp) < tolerance);
        if (matchesTp) narrative = { ...narrative, closedAtTp: true };
      }
      if (sl != null && typeof sl === 'number') {
        if (originalStopLoss != null && Math.abs(sl - originalStopLoss) < tolerance && Math.abs(sl - entryPrice) >= tolerance) {
          narrative = { ...narrative, slMatchesOriginal: true, closingOrderSl: sl };
        } else if (Math.abs(sl - entryPrice) >= tolerance) {
          narrative = { ...narrative, closingOrderSl: sl };
        }
      }
    }
    if (Object.keys(narrative).length > 0) result.narrative = narrative;

  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to query cTrader position SL level', {
      positionId,
      error: result.error
    });
  }

  return result;
}
