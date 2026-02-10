import { Trade, Order, DatabaseManager } from '../db/schema.js';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';

/**
 * Get signal type (long/short) from trade's direction field
 * Falls back to inferring from price relationships if direction is not set (for backward compatibility)
 */
export const getIsLong = (trade: Trade): boolean => {
  if (trade.direction) {
    return trade.direction === 'long';
  }
  
  // Fallback: infer from price relationships for old trades without direction
  // For long: TP > entry > SL, for short: SL > entry > TP
  const takeProfits = JSON.parse(trade.take_profits) as number[];
  const firstTP = takeProfits[0];
  const tpHigherThanEntry = firstTP > trade.entry_price;
  const slLowerThanEntry = trade.stop_loss < trade.entry_price;
  return tpHigherThanEntry && slLowerThanEntry;
};

/**
 * Check if trade has expired (entry not filled in time)
 */
export const checkTradeExpired = async (
  trade: Trade,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider
): Promise<boolean> => {
  const currentSimTime = isSimulation && priceProvider 
    ? await priceProvider.getCurrentTime() 
    : dayjs();
  
  const expiresAt = dayjs(trade.expires_at);
  return currentSimTime.isAfter(expiresAt) && trade.status === 'pending';
};

/**
 * Update entry order to filled status in database
 */
export const updateEntryOrderToFilled = async (
  trade: Trade,
  db: DatabaseManager,
  fillTime: string,
  fillPrice?: number
): Promise<void> => {
  const orders = await db.getOrdersByTradeId(trade.id);
  const entryOrder = orders.find(o => o.order_type === 'entry');
  if (entryOrder && entryOrder.status !== 'filled') {
    await db.updateOrder(entryOrder.id, {
      status: 'filled',
      filled_at: fillTime,
      filled_price: fillPrice || trade.entry_price
    });
    logger.debug('Entry order updated to filled', {
      tradeId: trade.id,
      orderId: entryOrder.id,
      fillPrice: fillPrice || trade.entry_price,
      exchange: trade.exchange
    });
  }
};

/**
 * Check if stop loss is hit based on current price
 */
export const checkStopLossHit = (
  trade: Trade,
  currentPrice: number
): boolean => {
  const isLong = getIsLong(trade);
  return isLong
    ? currentPrice <= trade.stop_loss
    : currentPrice >= trade.stop_loss;
};

/**
 * Check if take profit is hit before entry (for pending trades)
 */
export const checkTPHitBeforeEntry = (
  trade: Trade,
  currentPrice: number
): boolean => {
  const takeProfits = JSON.parse(trade.take_profits) as number[];
  const firstTP = takeProfits[0];
  const isLong = getIsLong(trade);
  
  return isLong
    ? currentPrice >= firstTP
    : currentPrice <= firstTP;
};

/**
 * Check if stop loss is hit before entry (for pending trades)
 */
export const checkSLHitBeforeEntry = (
  trade: Trade,
  currentPrice: number
): boolean => {
  const isLong = getIsLong(trade);
  return isLong
    ? currentPrice <= trade.stop_loss
    : currentPrice >= trade.stop_loss;
};

/**
 * Calculate PNL percentage from exit price and entry price
 */
export const calculatePNLPercentage = (
  trade: Trade,
  exitPrice: number,
  pnl?: number
): number | undefined => {
  if (pnl === undefined || !trade.entry_price) {
    return undefined;
  }
  
  const priceDiff = exitPrice - trade.entry_price;
  const priceChangePercent = (priceDiff / trade.entry_price) * 100;
  const isLong = getIsLong(trade);
  
  return isLong 
    ? priceChangePercent * trade.leverage
    : -priceChangePercent * trade.leverage;
};

/**
 * Count filled take profit orders for a trade
 */
export const countFilledTakeProfits = async (
  trade: Trade,
  db: DatabaseManager
): Promise<number> => {
  const tradeOrders = await db.getOrdersByTradeId(trade.id);
  return tradeOrders.filter(
    o => o.order_type === 'take_profit' && o.status === 'filled'
  ).length;
};

/**
 * Check if breakeven limit order already exists for a trade
 * Returns the order if found, undefined otherwise
 */
export const getBreakevenLimitOrder = async (
  trade: Trade,
  db: DatabaseManager
): Promise<Order | undefined> => {
  const existingOrders = await db.getOrdersByTradeId(trade.id);
  return existingOrders.find(
    o => o.order_type === 'breakeven_limit'
  );
};

/**
 * Update order status to filled in database
 */
export const updateOrderToFilled = async (
  order: Order,
  db: DatabaseManager,
  filledPrice?: number
): Promise<void> => {
  await db.updateOrder(order.id, {
    status: 'filled',
    filled_at: dayjs().toISOString(),
    filled_price: filledPrice || order.price
  });
};

/**
 * Update trade status when position is closed
 */
export const updateTradeOnPositionClosed = async (
  trade: Trade,
  db: DatabaseManager,
  exitPrice?: number,
  pnl?: number
): Promise<void> => {
  const pnlPercentage = exitPrice ? calculatePNLPercentage(trade, exitPrice, pnl) : undefined;
  
  await db.updateTrade(trade.id, {
    status: 'closed',
    exit_price: exitPrice,
    exit_filled_at: dayjs().toISOString(),
    pnl,
    pnl_percentage: pnlPercentage
  });
};

/**
 * Update trade status when stop loss is hit
 */
export const updateTradeOnStopLossHit = async (
  trade: Trade,
  db: DatabaseManager,
  exitPrice?: number,
  pnl?: number
): Promise<void> => {
  const pnlPercentage = exitPrice ? calculatePNLPercentage(trade, exitPrice, pnl) : undefined;
  
  await db.updateTrade(trade.id, {
    status: 'stopped',
    exit_price: exitPrice,
    exit_filled_at: dayjs().toISOString(),
    pnl,
    pnl_percentage: pnlPercentage
  });
};

/**
 * Update trade status when breakeven limit order is filled
 */
export const updateTradeOnBreakevenFilled = async (
  trade: Trade,
  db: DatabaseManager,
  exitPrice: number
): Promise<void> => {
  await db.updateTrade(trade.id, {
    status: 'completed',
    exit_price: exitPrice,
    exit_filled_at: dayjs().toISOString()
  });
};

/**
 * Mark trade as cancelled
 */
export const cancelTrade = async (
  trade: Trade,
  db: DatabaseManager
): Promise<void> => {
  await db.updateTrade(trade.id, { status: 'cancelled' });
};

/**
 * Sleep utility function
 */
export const sleep = (ms: number): Promise<void> => {
  return new Promise(resolve => {
    if (typeof setTimeout !== 'undefined') {
      setTimeout(resolve, ms);
    } else {
      const start = Date.now();
      while (Date.now() - start < ms) {
        // Busy wait fallback
      }
      resolve();
    }
  });
};

