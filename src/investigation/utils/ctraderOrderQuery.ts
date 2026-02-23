/**
 * cTrader Order Query Utilities
 *
 * Functions to query cTrader orders and positions for investigation purposes.
 * cTrader uses ProtoOAReconcileReq which returns current open orders and positions.
 */

import { logger } from '../../utils/logger.js';
import type { CTraderClient } from '../../clients/ctraderClient.js';
import { normalizeCTraderSymbol } from '../../utils/ctraderSymbolUtils.js';

export interface CTraderOrderDetails {
  orderId: string;
  symbol: string;
  accountName: string;
  found: boolean;
  foundIn?: 'open_orders' | 'open_positions' | 'closed_orders' | 'not_found';
  orderStatus?: string;
  orderType?: string;
  side?: string;
  price?: string;
  qty?: string;
  quantity?: string;
  positionId?: string;
  avgPrice?: string;
  error?: string;
}

/**
 * Query cTrader for order/position by order ID.
 * Checks open orders first; if not found, open positions (order may have filled → position);
 * then closed orders (cancelled, expired, filled) if created_at provided.
 */
export async function queryCTraderOrder(
  ctraderClient: CTraderClient,
  orderId: string,
  symbol: string,
  accountName: string,
  positionId?: string | null,
  created_at?: string | null
): Promise<CTraderOrderDetails> {
  const normalizedSymbol = normalizeCTraderSymbol(symbol);

  logger.info('Querying cTrader order', {
    orderId,
    symbol: normalizedSymbol,
    accountName
  });

  const result: CTraderOrderDetails = {
    orderId,
    symbol: normalizedSymbol,
    accountName,
    found: false
  };

  try {
    // Check open orders
    const openOrders = await ctraderClient.getOpenOrders();
    const orderIdStr = String(orderId);
    const matchingOrder = openOrders.find((o: any) => {
      const id = o.orderId ?? o.id;
      return id != null && String(id) === orderIdStr;
    });

    if (matchingOrder) {
      result.found = true;
      result.foundIn = 'open_orders';
      result.orderStatus = 'open';
      result.price = matchingOrder.price != null ? String(matchingOrder.price) : undefined;
      result.qty = matchingOrder.volume != null ? String(matchingOrder.volume) : matchingOrder.quantity;
      return result;
    }

    // If we have position_id, check if position exists (order filled)
    if (positionId) {
      const positions = await ctraderClient.getOpenPositions();
      const posIdNum = parseInt(String(positionId), 10);
      const matchingPosition = positions.find((p: any) => {
        const id = p.positionId ?? p.id;
        const num = typeof id === 'object' && id?.low != null ? id.low : id;
        return num != null && (typeof num === 'number' ? num === posIdNum : parseInt(String(num), 10) === posIdNum);
      });

      if (matchingPosition) {
        result.found = true;
        result.foundIn = 'open_positions';
        result.orderStatus = 'filled';
        result.positionId = String(positionId);
        result.avgPrice = matchingPosition.avgPrice ?? matchingPosition.averagePrice ?? matchingPosition.price;
        result.quantity = matchingPosition.quantity ?? matchingPosition.volume;
        result.side = matchingPosition.side ?? matchingPosition.tradeSide;
        return result;
      }
    }

    // Not in open orders or positions - try matching by symbol (order filled, position may use broker symbol)
    const positions = await ctraderClient.getOpenPositions();
    const symbolUpper = normalizedSymbol.toUpperCase();
    const matchingBySymbol = positions.find((p: any) => {
      const sym = (p.symbolName ?? p.symbol ?? '').toUpperCase();
      return sym === symbolUpper || sym.includes('XAU') && symbolUpper.includes('XAU') || sym.includes('GOLD') && (symbolUpper.includes('XAU') || symbolUpper.includes('GOLD'));
    });

    if (matchingBySymbol) {
      result.found = true;
      result.foundIn = 'open_positions';
      result.orderStatus = 'filled';
      result.positionId = String(matchingBySymbol.positionId ?? matchingBySymbol.id ?? '');
      result.avgPrice = matchingBySymbol.avgPrice ?? matchingBySymbol.averagePrice ?? matchingBySymbol.price;
      result.quantity = matchingBySymbol.quantity ?? matchingBySymbol.volume;
      result.side = matchingBySymbol.side ?? matchingBySymbol.tradeSide;
      return result;
    }

    // Check closed orders (cancelled, expired, filled) if we have a time window
    if (created_at) {
      const created = new Date(created_at).getTime();
      const fromTs = Math.max(0, created - 3600000); // 1 hour before
      const toTs = created + 86400000; // 1 day after
      const closedOrders = await ctraderClient.getClosedOrders(fromTs, toTs);
      const orderIdStr = String(orderId);
      const matchingClosed = closedOrders.find((o: any) => {
        const id = o.orderId ?? o.id;
        return id != null && String(id) === orderIdStr;
      });
      if (matchingClosed) {
        result.found = true;
        result.foundIn = 'closed_orders';
        result.orderStatus = matchingClosed.orderStatus ?? 'closed';
        result.avgPrice = matchingClosed.executionPrice ?? matchingClosed.limitPrice;
        result.price = matchingClosed.limitPrice ?? matchingClosed.executionPrice;
        result.quantity = matchingClosed.executedVolume ?? matchingClosed.volume;
        return result;
      }
    }

    result.foundIn = 'not_found';
    return result;
  } catch (error) {
    logger.warn('Error querying cTrader order', {
      orderId,
      symbol: normalizedSymbol,
      error: error instanceof Error ? error.message : String(error)
    });
    result.error = error instanceof Error ? error.message : String(error);
    result.foundIn = 'not_found';
    return result;
  }
}

/**
 * Query multiple orders for a message/trade (cTrader)
 */
export async function queryCTraderOrdersForMessage(
  getCTraderClient: (accountName?: string) => Promise<CTraderClient | undefined>,
  trades: Array<{ order_id?: string; position_id?: string | null; trading_pair: string; account_name?: string; created_at?: string | null }>
): Promise<CTraderOrderDetails[]> {
  const orderDetails: CTraderOrderDetails[] = [];

  for (const trade of trades) {
    if (!trade.order_id || !trade.account_name) {
      continue;
    }

    const ctraderClient = await getCTraderClient(trade.account_name);
    if (!ctraderClient) {
      orderDetails.push({
        orderId: trade.order_id,
        symbol: trade.trading_pair,
        accountName: trade.account_name || 'unknown',
        found: false,
        foundIn: 'not_found',
        error: 'cTrader client not available'
      });
      continue;
    }

    const details = await queryCTraderOrder(
      ctraderClient,
      trade.order_id,
      trade.trading_pair,
      trade.account_name,
      trade.position_id,
      trade.created_at
    );
    orderDetails.push(details);
  }

  return orderDetails;
}
