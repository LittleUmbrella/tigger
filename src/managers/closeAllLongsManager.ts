import { ManagerContext, ManagerFunction } from './managerRegistry.js';
import { logger } from '../utils/logger.js';
import { closePosition } from './positionUtils.js';
import { extractReplyContext, findTradesByContext } from './replyContextExtractor.js';
import { getBybitField } from '../utils/bybitFieldHelper.js';

/**
 * Manager to close all long positions
 * If message is a reply, can filter by symbol from the original signal
 */
export const closeAllLongsManager: ManagerFunction = async (context: ManagerContext): Promise<void> => {
  const { channel, message, db, isSimulation, bybitClient } = context;

  try {
    // Get all active trades for this channel
    const activeTrades = await db.getActiveTrades();
    let tradesToClose = activeTrades.filter(
      trade => trade.channel === channel && 
               trade.status === 'active' && 
               trade.position_id // Only close trades that have been filled
    );

    // If message is a reply, try to filter by symbol from reply context
    if (message.reply_to_message_id) {
      const replyContext = await extractReplyContext(message, db);
      if (replyContext.symbol) {
        const normalizedSymbol = replyContext.symbol.replace('/', '').toUpperCase();
        tradesToClose = tradesToClose.filter(
          trade => trade.trading_pair.replace('/', '').toUpperCase() === normalizedSymbol
        );
        logger.info('Filtering close all longs by reply context symbol', {
          channel,
          symbol: replyContext.symbol,
          filteredCount: tradesToClose.length
        });
      }
    }

    // If we have a Bybit client, filter to only long positions by checking position side
    if (!isSimulation && bybitClient && tradesToClose.length > 0) {
      const longTrades: typeof tradesToClose = [];
      for (const trade of tradesToClose) {
        try {
          const symbol = trade.trading_pair.replace('/', '');
          const positions = await bybitClient.getPositionInfo({ category: 'linear', symbol });
          
          if (positions.retCode === 0 && positions.result && positions.result.list) {
            const position = positions.result.list.find((p: any) => {
              const positionIdx = getBybitField<string | number>(p, 'positionIdx', 'position_idx');
              const positionSize = getBybitField<string>(p, 'size');
              return p.symbol === symbol && 
                positionIdx?.toString() === trade.position_id &&
                parseFloat(positionSize || '0') !== 0;
            });
            
            // Only include if it's a long position (Buy side)
            if (position && position.side === 'Buy') {
              longTrades.push(trade);
            }
          }
        } catch (error) {
          logger.warn('Error checking position side, including trade', {
            tradeId: trade.id,
            error: error instanceof Error ? error.message : String(error)
          });
          // If we can't check, include it to be safe
          longTrades.push(trade);
        }
      }
      tradesToClose = longTrades;
    }

    if (tradesToClose.length === 0) {
      logger.info('No active long positions to close', { channel });
      return;
    }

    logger.info('Closing all long positions', {
      channel,
      count: tradesToClose.length
    });

    for (const trade of tradesToClose) {
      try {
        await closePosition(trade, db, isSimulation, bybitClient);
      } catch (error) {
        logger.error('Error closing long position', {
          tradeId: trade.id,
          tradingPair: trade.trading_pair,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    logger.info('All long positions closed', {
      channel,
      count: tradesToClose.length
    });
  } catch (error) {
    logger.error('Error in closeAllLongsManager', {
      channel,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

