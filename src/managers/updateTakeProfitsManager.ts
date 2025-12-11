import { ManagerContext, ManagerFunction } from './managerRegistry.js';
import { logger } from '../utils/logger.js';
import { ParsedOrder } from '../types/order.js';

/**
 * Manager to update take profits of an existing trade
 */
export const updateTakeProfitsManager: ManagerFunction = async (context: ManagerContext): Promise<void> => {
  const { channel, message, db, isSimulation } = context;
  const newOrder = (context.command as any).newOrder as ParsedOrder;
  const trade = (context.command as any).trade;

  if (!newOrder || !trade) {
    logger.warn('updateTakeProfitsManager called without newOrder or trade', { channel });
    return;
  }

  try {
    // Only update if trade is active or pending
    if (trade.status === 'closed' || trade.status === 'stopped' || trade.status === 'cancelled') {
      logger.info('Take profits cannot be updated - trade already closed', {
        tradeId: trade.id,
        status: trade.status
      });
      return;
    }

    // Update database with new take profits
    await db.updateTrade(trade.id, {
      take_profits: JSON.stringify(newOrder.takeProfits)
    });

    logger.info('Take profits updated', {
      tradeId: trade.id,
      oldTakeProfits: JSON.parse(trade.take_profits),
      newTakeProfits: newOrder.takeProfits
    });

    // Note: On Bybit, take profit orders are typically managed separately
    // This update affects the database record and monitoring logic
    // Actual TP orders on exchange would need to be cancelled/recreated if they exist
  } catch (error) {
    logger.error('Error in updateTakeProfitsManager', {
      channel,
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

