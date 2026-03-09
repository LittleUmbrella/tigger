import { ManagerContext, ManagerFunction } from './managerRegistry.js';
import { logger } from '../utils/logger.js';
import { ParsedOrder } from '../types/order.js';

/**
 * Manager to update stop loss of an existing trade
 */
export const updateStopLossManager: ManagerFunction = async (context: ManagerContext): Promise<void> => {
  const { channel, message, db, isSimulation, getBybitClient, getCtraderClient } = context;
  const newOrder = (context.command as any).newOrder as ParsedOrder;
  const trade = (context.command as any).trade;

  if (!newOrder || !trade) {
    logger.warn('updateStopLossManager called without newOrder or trade', { channel });
    return;
  }

  try {
    // Only update if trade is active or pending
    if (trade.status === 'closed' || trade.status === 'stopped' || trade.status === 'cancelled') {
      logger.info('Stop loss cannot be updated - trade already closed', {
        tradeId: trade.id,
        status: trade.status
      });
      return;
    }

    const symbol = trade.trading_pair.replace('/', '');

    if (isSimulation) {
      // In simulation, just update the database
      await db.updateTrade(trade.id, {
        stop_loss: newOrder.stopLoss,
        stop_loss_breakeven: false // Reset breakeven flag if SL changed
      });
      logger.info('Stop loss updated in simulation', {
        tradeId: trade.id,
        oldStopLoss: trade.stop_loss,
        newStopLoss: newOrder.stopLoss
      });
    } else if (trade.exchange === 'bybit') {
      const bybitClient = getBybitClient?.(trade.account_name);
      if (!bybitClient) {
        logger.warn('Stop loss update skipped - no Bybit client', { tradeId: trade.id });
        return;
      }
      // Update stop loss on exchange - only for open positions
      if (trade.position_id) {
        await bybitClient.setTradingStop({
          category: 'linear',
          symbol: symbol,
          stopLoss: newOrder.stopLoss.toString(),
          positionIdx: parseInt(trade.position_id || '0') as 0 | 1 | 2,
          tpslMode: 'Full' // Apply stop loss to 100% of position automatically
        });
      }

      // Update database
      await db.updateTrade(trade.id, {
        stop_loss: newOrder.stopLoss,
        stop_loss_breakeven: false
      });
      
      // Update stop loss order quantity in database for tracking
      // Bybit API automatically covers 100% of position, but we track quantity for consistency
      try {
        const orders = await db.getOrdersByTradeId(trade.id);
        const stopLossOrder = orders.find(o => o.order_type === 'stop_loss');
        if (stopLossOrder && trade.quantity) {
          await db.updateOrder(stopLossOrder.id, {
            quantity: trade.quantity
          });
          logger.debug('Updated stop loss order quantity in database', {
            tradeId: trade.id,
            orderId: stopLossOrder.id,
            quantity: trade.quantity
          });
        }
      } catch (error) {
        logger.warn('Failed to update stop loss order quantity', {
          tradeId: trade.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      logger.info('Stop loss updated', {
        tradeId: trade.id,
        oldStopLoss: trade.stop_loss,
        newStopLoss: newOrder.stopLoss,
        hasPosition: !!trade.position_id
      });
    } else if (trade.exchange === 'ctrader') {
      const ctraderClient = await getCtraderClient?.(trade.account_name);
      if (!ctraderClient) {
        logger.warn('Stop loss update skipped - no cTrader client', { tradeId: trade.id });
        return;
      }
      if (!trade.position_id) {
        logger.warn('Stop loss update skipped - no position_id for cTrader trade', {
          tradeId: trade.id,
          status: trade.status
        });
        return;
      }
      await ctraderClient.modifyPosition({
        positionId: trade.position_id,
        stopLoss: newOrder.stopLoss
      });
      await db.updateTrade(trade.id, {
        stop_loss: newOrder.stopLoss,
        stop_loss_breakeven: false
      });
      logger.info('Stop loss updated', {
        tradeId: trade.id,
        oldStopLoss: trade.stop_loss,
        newStopLoss: newOrder.stopLoss,
        exchange: 'ctrader',
        hasPosition: true
      });
    }
  } catch (error) {
    logger.error('Error in updateStopLossManager', {
      channel,
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

