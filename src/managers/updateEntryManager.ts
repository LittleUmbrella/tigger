import { ManagerContext, ManagerFunction } from './managerRegistry.js';
import { logger } from '../utils/logger.js';
// @ts-ignore - bybit-api types may not be complete
import { RESTClient } from 'bybit-api';
import { ParsedOrder } from '../types/order.js';

/**
 * Manager to update entry price of an existing trade
 */
export const updateEntryManager: ManagerFunction = async (context: ManagerContext): Promise<void> => {
  const { channel, message, db, isSimulation, bybitClient } = context;
  const newOrder = (context.command as any).newOrder as ParsedOrder;
  const trade = (context.command as any).trade;

  if (!newOrder || !trade) {
    logger.warn('updateEntryManager called without newOrder or trade', { channel });
    return;
  }

  try {
    // Only update if trade is still pending (order not filled yet)
    if (trade.status !== 'pending') {
      logger.info('Trade entry cannot be updated - order already filled', {
        tradeId: trade.id,
        status: trade.status
      });
      return;
    }

    const newEntryPrice = newOrder.entryTargets?.[0] || newOrder.entryPrice;
    const symbol = trade.trading_pair.replace('/', '');

    if (isSimulation) {
      // In simulation, just update the database
      await db.updateTrade(trade.id, {
        entry_price: newEntryPrice
      });
      logger.info('Entry price updated in simulation', {
        tradeId: trade.id,
        oldEntryPrice: trade.entry_price,
        newEntryPrice
      });
    } else if (trade.exchange === 'bybit' && bybitClient && trade.order_id) {
      // Cancel the old order
      try {
        await bybitClient.cancelOrder({
          category: 'linear',
          symbol: symbol,
          orderId: trade.order_id
        });
        logger.info('Old entry order cancelled', {
          tradeId: trade.id,
          orderId: trade.order_id
        });
      } catch (error) {
        logger.error('Error cancelling old order', {
          tradeId: trade.id,
          error: error instanceof Error ? error.message : String(error)
        });
        // Continue anyway - order might already be filled or cancelled
      }

      // Place new order at updated entry price
      const side = newOrder.signalType === 'long' ? 'Buy' : 'Sell';
      const riskAmount = (trade.entry_price * (trade.risk_percentage / 100)) / 
                        (Math.abs(trade.entry_price - trade.stop_loss) / trade.entry_price);
      const qty = Math.floor((riskAmount / newEntryPrice) * 100) / 100;

      const orderResponse = await bybitClient.submitOrder({
        category: 'linear',
        symbol: symbol,
        side: side,
        orderType: 'Limit',
        qty: qty.toString(),
        price: newEntryPrice.toString(),
        timeInForce: 'GTC',
        reduceOnly: false,
        closeOnTrigger: false,
        positionIdx: 0
      });

      if (orderResponse.retCode === 0 && orderResponse.result?.orderId) {
        await db.updateTrade(trade.id, {
          entry_price: newEntryPrice,
          order_id: orderResponse.result.orderId
        });
        logger.info('Entry price updated and new order placed', {
          tradeId: trade.id,
          oldEntryPrice: trade.entry_price,
          newEntryPrice,
          newOrderId: orderResponse.result.orderId
        });
      } else {
        throw new Error(`Failed to place new order: ${JSON.stringify(orderResponse)}`);
      }
    }
  } catch (error) {
    logger.error('Error in updateEntryManager', {
      channel,
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

