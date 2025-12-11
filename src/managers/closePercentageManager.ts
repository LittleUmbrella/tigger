import { ManagerContext, ManagerFunction } from './managerRegistry.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';
// @ts-ignore - bybit-api types may not be complete
import { RESTClient } from 'bybit-api';
import { extractReplyContext, findTradesByContext } from './replyContextExtractor.js';

/**
 * Manager to close a percentage of a position
 */
export const closePercentageManager: ManagerFunction = async (context: ManagerContext): Promise<void> => {
  const { channel, message, command, db, isSimulation, bybitClient } = context;

  if (!command.percentage || command.percentage <= 0 || command.percentage > 100) {
    logger.warn('closePercentageManager called with invalid percentage', {
      channel,
      percentage: command.percentage
    });
    return;
  }

  try {
    let tradesToProcess;

    // If trading pair is specified, use it
    if (command.tradingPair) {
      const activeTrades = await db.getActiveTrades();
      tradesToProcess = activeTrades.filter(
        trade => trade.channel === channel && 
                 trade.status === 'active' && 
                 trade.position_id &&
                 trade.trading_pair === command.tradingPair
      );
    } else {
      // If no trading pair specified, try to get from reply chain context
      const replyContext = await extractReplyContext(message, db);
      if (replyContext.symbol) {
        // Use context to find matching trades
        tradesToProcess = await findTradesByContext(replyContext, channel, db);
        logger.info('Using reply chain context for close percentage', {
          channel,
          symbol: replyContext.symbol,
          side: replyContext.side,
          count: tradesToProcess.length
        });
      } else {
        // No context available, get all active trades for channel
        const activeTrades = await db.getActiveTrades();
        tradesToProcess = activeTrades.filter(
          trade => trade.channel === channel && 
                   trade.status === 'active' && 
                   trade.position_id
        );
      }
    }

    if (tradesToProcess.length === 0) {
      logger.info('No active positions to partially close', {
        channel,
        tradingPair: command.tradingPair
      });
      return;
    }

    logger.info('Partially closing positions', {
      channel,
      percentage: command.percentage,
      tradingPair: command.tradingPair,
      count: tradesToProcess.length
    });

    for (const trade of tradesToProcess) {
      try {
        await closePercentageOfPosition(
          trade,
          command.percentage!,
          command.moveStopLossToEntry || false,
          db,
          isSimulation,
          bybitClient
        );
      } catch (error) {
        logger.error('Error partially closing position', {
          tradeId: trade.id,
          tradingPair: trade.trading_pair,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    logger.info('Positions partially closed', {
      channel,
      percentage: command.percentage,
      count: tradesToProcess.length
    });
  } catch (error) {
    logger.error('Error in closePercentageManager', {
      channel,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

/**
 * Helper function to close a percentage of a position
 */
async function closePercentageOfPosition(
  trade: any,
  percentage: number,
  moveStopLossToEntry: boolean,
  db: any,
  isSimulation: boolean,
  bybitClient?: RESTClient
): Promise<void> {
  if (isSimulation) {
    // In simulation, we can't actually reduce position size, so we'll just log it
    // In a real implementation, you might want to track partial closes differently
    logger.info('Simulated partial position close', {
      tradeId: trade.id,
      tradingPair: trade.trading_pair,
      percentage
    });

    // If moving stop loss to entry, update it
    if (moveStopLossToEntry) {
      await db.updateTrade(trade.id, {
        stop_loss: trade.entry_price,
        stop_loss_breakeven: true
      });
      logger.info('Stop loss moved to entry in simulation', {
        tradeId: trade.id,
        entryPrice: trade.entry_price
      });
    }
  } else if (trade.exchange === 'bybit' && bybitClient && trade.position_id) {
    const symbol = trade.trading_pair.replace('/', '');
    
    const positions = await bybitClient.getPositionInfo({
      category: 'linear',
      symbol: symbol
    });

    if (positions.retCode === 0 && positions.result?.list) {
      const position = positions.result.list.find((p: any) => 
        p.symbol === symbol && p.positionIdx?.toString() === trade.position_id
      );

      if (position && parseFloat(position.size || '0') !== 0) {
        const currentSize = parseFloat(position.size);
        const closeQty = (currentSize * percentage) / 100;
        const side = position.side === 'Buy' ? 'Sell' : 'Buy';

        // Close the percentage of the position
        const closeOrder = await bybitClient.submitOrder({
          category: 'linear',
          symbol: symbol,
          side: side,
          orderType: 'Market',
          qty: closeQty.toString(),
          reduceOnly: true,
          positionIdx: parseInt(trade.position_id)
        });

        if (closeOrder.retCode === 0) {
          logger.info('Partial position closed on exchange', {
            tradeId: trade.id,
            tradingPair: trade.trading_pair,
            percentage,
            orderId: closeOrder.result?.orderId
          });

          // If moving stop loss to entry, update it
          if (moveStopLossToEntry) {
            try {
              await bybitClient.setTradingStop({
                category: 'linear',
                symbol: symbol,
                stopLoss: trade.entry_price.toString(),
                positionIdx: parseInt(trade.position_id)
              });

              await db.updateTrade(trade.id, {
                stop_loss: trade.entry_price,
                stop_loss_breakeven: true
              });

              logger.info('Stop loss moved to entry', {
                tradeId: trade.id,
                entryPrice: trade.entry_price
              });
            } catch (error) {
              logger.error('Error moving stop loss to entry', {
                tradeId: trade.id,
                error: error instanceof Error ? error.message : String(error)
              });
            }
          }
        } else {
          throw new Error(`Failed to partially close position: ${JSON.stringify(closeOrder)}`);
        }
      }
    }
  }
}

