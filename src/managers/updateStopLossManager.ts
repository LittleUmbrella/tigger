import { ManagerContext, ManagerFunction } from './managerRegistry.js';
import { logger } from '../utils/logger.js';
// @ts-ignore - bybit-api types may not be complete
import { RESTClient } from 'bybit-api';
import { ParsedOrder } from '../types/order.js';

/**
 * Manager to update stop loss of an existing trade
 */
export const updateStopLossManager: ManagerFunction = async (context: ManagerContext): Promise<void> => {
  const { channel, message, db, isSimulation, bybitClient } = context;
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
    } else if (trade.exchange === 'bybit' && bybitClient) {
      // Update stop loss on exchange
      if (trade.position_id) {
        // Position is open, update stop loss directly
        await bybitClient.setTradingStop({
          category: 'linear',
          symbol: symbol,
          stopLoss: newOrder.stopLoss.toString(),
          positionIdx: parseInt(trade.position_id)
        });
      }

      // Update database
      await db.updateTrade(trade.id, {
        stop_loss: newOrder.stopLoss,
        stop_loss_breakeven: false
      });

      logger.info('Stop loss updated', {
        tradeId: trade.id,
        oldStopLoss: trade.stop_loss,
        newStopLoss: newOrder.stopLoss,
        hasPosition: !!trade.position_id
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

