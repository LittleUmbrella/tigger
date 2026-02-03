/**
 * Bybit Order Query Utilities
 * 
 * Functions to query Bybit orders for investigation purposes
 */

import { RestClientV5 } from 'bybit-api';
import { logger } from '../../utils/logger.js';
import { getBybitField } from '../../utils/bybitFieldHelper.js';

export interface OrderDetails {
  orderId: string;
  symbol: string;
  accountName: string;
  found: boolean;
  foundIn?: 'active_orders' | 'order_history' | 'not_found';
  orderStatus?: string;
  orderType?: string;
  side?: string;
  price?: string;
  qty?: string;
  cumExecQty?: string;
  avgPrice?: string;
  createdTime?: string;
  updatedTime?: string;
  error?: string;
}

/**
 * Normalize trading pair symbol for Bybit API calls
 */
const normalizeBybitSymbol = (tradingPair: string): string => {
  let normalized = tradingPair.replace('/', '').toUpperCase();
  if (!normalized.endsWith('USDT') && !normalized.endsWith('USDC')) {
    normalized = `${normalized}USDT`;
  }
  return normalized;
};

/**
 * Query Bybit for order details by order ID
 */
export async function queryBybitOrder(
  bybitClient: RestClientV5,
  orderId: string,
  symbol: string,
  accountName: string
): Promise<OrderDetails> {
  const normalizedSymbol = normalizeBybitSymbol(symbol);
  
  // Log which API endpoint is being used (for debugging)
  const baseUrl = (bybitClient as any).baseUrl || 'https://api.bybit.com';
  const isDemo = baseUrl.includes('api-demo');
  logger.info('Querying Bybit order', {
    orderId,
    symbol: normalizedSymbol,
    accountName,
    apiEndpoint: isDemo ? 'demo' : 'live',
    baseUrl
  });
  
  const result: OrderDetails = {
    orderId,
    symbol: normalizedSymbol,
    accountName,
    found: false
  };

  // First check active orders (try both orderId and orderLinkId)
  try {
    // Try as orderId first
    let activeOrders = await bybitClient.getActiveOrders({
      category: 'linear',
      symbol: normalizedSymbol,
      orderId: orderId
    });

    // If not found, try as orderLinkId
    if (activeOrders.retCode !== 0 || !activeOrders.result?.list || activeOrders.result.list.length === 0) {
      activeOrders = await bybitClient.getActiveOrders({
        category: 'linear',
        symbol: normalizedSymbol,
        orderLinkId: orderId
      });
    }

    if (activeOrders.retCode === 0 && activeOrders.result?.list && activeOrders.result.list.length > 0) {
      const order = activeOrders.result.list[0];
      result.found = true;
      result.foundIn = 'active_orders';
      result.orderStatus = getBybitField<string>(order, 'orderStatus', 'order_status');
      result.orderType = order.orderType;
      result.side = order.side;
      result.price = order.price;
      result.qty = order.qty;
      result.cumExecQty = getBybitField<string>(order, 'cumExecQty', 'cum_exec_qty');
      result.avgPrice = getBybitField<string>(order, 'avgPrice', 'avg_price');
      result.createdTime = getBybitField<string>(order, 'createdTime', 'created_time');
      result.updatedTime = getBybitField<string>(order, 'updatedTime', 'updated_time');
      return result;
    }
  } catch (error) {
    logger.warn('Error checking active orders', { 
      orderId, 
      symbol: normalizedSymbol, 
      error: error instanceof Error ? error.message : String(error) 
    });
  }

  // If not found in active orders, check order history (try both orderId and orderLinkId)
  try {
    // Try as orderId first
    let orderHistory = await bybitClient.getHistoricOrders({
      category: 'linear',
      symbol: normalizedSymbol,
      orderId: orderId,
      limit: 10
    });

    // If not found, try as orderLinkId
    if (orderHistory.retCode !== 0 || !orderHistory.result?.list || orderHistory.result.list.length === 0) {
      orderHistory = await bybitClient.getHistoricOrders({
        category: 'linear',
        symbol: normalizedSymbol,
        orderLinkId: orderId,
        limit: 10
      });
    }

    if (orderHistory.retCode === 0 && orderHistory.result?.list && orderHistory.result.list.length > 0) {
      const order = orderHistory.result.list[0];
      result.found = true;
      result.foundIn = 'order_history';
      result.orderStatus = getBybitField<string>(order, 'orderStatus', 'order_status');
      result.orderType = order.orderType;
      result.side = order.side;
      result.avgPrice = getBybitField<string>(order, 'avgPrice', 'avg_price');
      result.cumExecQty = getBybitField<string>(order, 'cumExecQty', 'cum_exec_qty');
      result.createdTime = getBybitField<string>(order, 'createdTime', 'created_time');
      result.updatedTime = getBybitField<string>(order, 'updatedTime', 'updated_time');
      return result;
    }
  } catch (error) {
    logger.warn('Error checking order history', { 
      orderId, 
      symbol: normalizedSymbol, 
      error: error instanceof Error ? error.message : String(error) 
    });
    result.error = error instanceof Error ? error.message : String(error);
  }

  // Order not found
  result.foundIn = 'not_found';
  return result;
}

/**
 * Search recent orders by symbol (useful when you only have transaction ID or want to find orders)
 */
export async function searchRecentOrdersBySymbol(
  bybitClient: RestClientV5,
  symbol: string,
  accountName: string,
  limit: number = 20
): Promise<OrderDetails[]> {
  const normalizedSymbol = normalizeBybitSymbol(symbol);
  
  const baseUrl = (bybitClient as any).baseUrl || 'https://api.bybit.com';
  const isDemo = baseUrl.includes('api-demo');
  logger.info('Searching recent orders by symbol', {
    symbol: normalizedSymbol,
    accountName,
    apiEndpoint: isDemo ? 'demo' : 'live',
    limit
  });

  const results: OrderDetails[] = [];

  try {
    // Get recent order history
    const orderHistory = await bybitClient.getHistoricOrders({
      category: 'linear',
      symbol: normalizedSymbol,
      limit: limit
    });

    if (orderHistory.retCode === 0 && orderHistory.result?.list) {
      for (const order of orderHistory.result.list) {
        const orderId = order.orderId || getBybitField<string>(order, 'orderId', 'order_id') || '';
        const orderLinkId = order.orderLinkId || getBybitField<string>(order, 'orderLinkId', 'order_link_id') || '';
        
        results.push({
          orderId: orderLinkId || orderId,
          symbol: normalizedSymbol,
          accountName,
          found: true,
          foundIn: 'order_history',
          orderStatus: getBybitField<string>(order, 'orderStatus', 'order_status'),
          orderType: order.orderType,
          side: order.side,
          price: order.price,
          qty: order.qty,
          cumExecQty: getBybitField<string>(order, 'cumExecQty', 'cum_exec_qty'),
          avgPrice: getBybitField<string>(order, 'avgPrice', 'avg_price'),
          createdTime: getBybitField<string>(order, 'createdTime', 'created_time'),
          updatedTime: getBybitField<string>(order, 'updatedTime', 'updated_time')
        });
      }
    }
  } catch (error) {
    logger.warn('Error searching order history', {
      symbol: normalizedSymbol,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return results;
}

/**
 * Query multiple orders for a message/trade
 */
export async function queryBybitOrdersForMessage(
  getBybitClient: (accountName?: string) => Promise<RestClientV5 | undefined>,
  trades: Array<{ order_id?: string; trading_pair: string; account_name?: string }>
): Promise<OrderDetails[]> {
  const orderDetails: OrderDetails[] = [];

  for (const trade of trades) {
    if (!trade.order_id || !trade.account_name) {
      continue;
    }

    const bybitClient = await getBybitClient(trade.account_name);
    if (!bybitClient) {
      orderDetails.push({
        orderId: trade.order_id,
        symbol: trade.trading_pair,
        accountName: trade.account_name || 'unknown',
        found: false,
        foundIn: 'not_found',
        error: 'Bybit client not available'
      });
      continue;
    }

    const details = await queryBybitOrder(
      bybitClient,
      trade.order_id,
      trade.trading_pair,
      trade.account_name
    );
    orderDetails.push(details);
  }

  return orderDetails;
}

