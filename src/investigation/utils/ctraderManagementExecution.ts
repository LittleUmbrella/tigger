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
