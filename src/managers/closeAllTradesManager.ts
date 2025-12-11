import { ManagerContext, ManagerFunction } from './managerRegistry.js';
import { logger } from '../utils/logger.js';
import { closePosition } from './positionUtils.js';

/**
 * Manager to close all active trades
 */
export const closeAllTradesManager: ManagerFunction = async (context: ManagerContext): Promise<void> => {
  const { channel, message, db, isSimulation, bybitClient } = context;

  try {
    // Get all active trades for this channel
    const activeTrades = await db.getActiveTrades();
    const tradesToClose = activeTrades.filter(
      trade => trade.channel === channel && 
               trade.status === 'active' && 
               trade.position_id // Only close trades that have been filled
    );

    if (tradesToClose.length === 0) {
      logger.info('No active positions to close', { channel });
      return;
    }

    logger.info('Closing all active positions', {
      channel,
      count: tradesToClose.length
    });

    for (const trade of tradesToClose) {
      try {
        await closePosition(trade, db, isSimulation, bybitClient);
      } catch (error) {
        logger.error('Error closing position', {
          tradeId: trade.id,
          tradingPair: trade.trading_pair,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    logger.info('All active positions closed', {
      channel,
      count: tradesToClose.length
    });
  } catch (error) {
    logger.error('Error in closeAllTradesManager', {
      channel,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

