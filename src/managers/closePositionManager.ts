import { ManagerContext, ManagerFunction } from './managerRegistry.js';
import { logger } from '../utils/logger.js';
import { closePosition } from './positionUtils.js';
import { extractReplyContext, findTradesByContext } from './replyContextExtractor.js';

/**
 * Manager to close a specific position by trading pair
 */
export const closePositionManager: ManagerFunction = async (context: ManagerContext): Promise<void> => {
  const { channel, message, command, db, isSimulation, bybitClient, getBybitClient } = context;

  let tradingPair = command.tradingPair;

  // If trading pair not specified, try to get from reply chain context
  if (!tradingPair) {
    const replyContext = await extractReplyContext(message, db);
    if (replyContext.symbol) {
      tradingPair = replyContext.symbol.includes('/') 
        ? replyContext.symbol 
        : `${replyContext.symbol.replace('USDT', '')}/USDT`;
      logger.info('Using reply chain context for close position', {
        channel,
        symbol: replyContext.symbol,
        inferredTradingPair: tradingPair
      });
    } else {
      logger.warn('closePositionManager called without tradingPair and no reply context', { channel });
      return;
    }
  }

  try {
    // Get active trades for this trading pair and channel
    const activeTrades = await db.getActiveTrades();
    const tradesToClose = activeTrades.filter(
      trade => trade.channel === channel && 
               trade.trading_pair === tradingPair &&
               trade.status === 'active' && 
               trade.position_id
    );

    if (tradesToClose.length === 0) {
      logger.info('No active positions to close for trading pair', {
        channel,
        tradingPair: command.tradingPair
      });
      return;
    }

    logger.info('Closing position for trading pair', {
      channel,
      tradingPair: command.tradingPair,
      count: tradesToClose.length
    });

    for (const trade of tradesToClose) {
      try {
        // Get account-specific client
        const accountClient = getBybitClient 
          ? getBybitClient(trade.account_name)
          : bybitClient; // Fallback to deprecated bybitClient
        await closePosition(trade, db, isSimulation, accountClient);
      } catch (error) {
        logger.error('Error closing position', {
          tradeId: trade.id,
          tradingPair: trade.trading_pair,
          accountName: trade.account_name,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    logger.info('Position closed for trading pair', {
      channel,
      tradingPair: command.tradingPair,
      count: tradesToClose.length
    });
  } catch (error) {
    logger.error('Error in closePositionManager', {
      channel,
      tradingPair: command.tradingPair,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

