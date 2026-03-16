import { ManagerContext, ManagerFunction } from './managerRegistry.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';
import { RestClientV5 } from 'bybit-api';
import { extractReplyContext, findTradesByContext } from './replyContextExtractor.js';
import { getBybitField } from '../utils/bybitFieldHelper.js';
import { serializeErrorForLog } from '../utils/errorUtils.js';
import { Trade, DatabaseManager } from '../db/schema.js';
import type { CTraderClient } from '../clients/ctraderClient.js';
import { getEntryFillPrice } from '../utils/entryFillPrice.js';

/**
 * Manager to close a percentage of a position
 */
export const closePercentageManager: ManagerFunction = async (context: ManagerContext): Promise<void> => {
  const { channel, message, command, db, isSimulation, getBybitClient, getCtraderClient } = context;

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
        const bybitClient = getBybitClient?.(trade.account_name);
        const ctraderClient = trade.exchange === 'ctrader' ? await getCtraderClient?.(trade.account_name) : undefined;
        await closePercentageOfPosition(
          trade,
          command.percentage!,
          command.moveStopLossToEntry || false,
          db,
          isSimulation,
          bybitClient,
          ctraderClient
        );
      } catch (error) {
        logger.error('Error partially closing position', {
          tradeId: trade.id,
          tradingPair: trade.trading_pair,
          error: serializeErrorForLog(error)
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
      error: serializeErrorForLog(error)
    });
    throw error;
  }
};

/**
 * Helper function to close a percentage of a position
 */
async function closePercentageOfPosition(
  trade: Trade,
  percentage: number,
  moveStopLossToEntry: boolean,
  db: DatabaseManager,
  isSimulation: boolean,
  bybitClient?: RestClientV5,
  ctraderClient?: CTraderClient
): Promise<void> {
  if (isSimulation) {
    // In simulation, we can't actually reduce position size, so we'll just log it
    // In a real implementation, you might want to track partial closes differently
    logger.info('Simulated partial position close', {
      tradeId: trade.id,
      tradingPair: trade.trading_pair,
      percentage
    });

    // If moving stop loss to entry, use actual fill price (fallback to trade.entry_price in simulation)
    if (moveStopLossToEntry) {
      const bePrice = await getEntryFillPrice(trade, db);
      await db.updateTrade(trade.id, {
        stop_loss: bePrice,
        stop_loss_breakeven: true
      });
      logger.info('Stop loss moved to entry in simulation', {
        tradeId: trade.id,
        bePrice
      });
    }
  } else if (trade.exchange === 'bybit' && bybitClient && trade.position_id) {
    const symbol = trade.trading_pair.replace('/', '');
    
    const positions = await bybitClient.getPositionInfo({ category: 'linear', symbol });

    if (positions.retCode === 0 && positions.result && positions.result.list) {
      const position = positions.result.list.find((p: any) => {
        const positionIdx = getBybitField<string | number>(p, 'positionIdx', 'position_idx');
        return p.symbol === symbol && String(positionIdx || '0') === String(trade.position_id || '0');
      });

      const positionSize = getBybitField<string>(position, 'size');
      if (position && parseFloat(String(positionSize || '0')) !== 0) {
        const currentSize = parseFloat(String(positionSize || '0'));
        const closeQty = (currentSize * percentage) / 100;
        const side = position.side === 'Buy' ? 'Sell' : 'Buy';

        // Close the percentage of the position
        const closeOrder = await bybitClient.submitOrder({
          category: 'linear',
          symbol: symbol,
          side: side as 'Buy' | 'Sell',
          orderType: 'Market',
          qty: closeQty.toString(),
          timeInForce: 'IOC',
          reduceOnly: true,
          closeOnTrigger: false,
          positionIdx: parseInt(trade.position_id || '0') as 0 | 1 | 2
        });

        if (closeOrder.retCode === 0 && closeOrder.result) {
          logger.info('Partial position closed on exchange', {
            tradeId: trade.id,
            tradingPair: trade.trading_pair,
            percentage,
            orderId: getBybitField<string>(closeOrder.result, 'orderId', 'order_id') || 'unknown'
          });

          // If moving stop loss to entry, use actual fill price (often better than order price for entry ranges)
          if (moveStopLossToEntry) {
            try {
              const bePrice = await getEntryFillPrice(trade, db, { bybitClient });
              await bybitClient.setTradingStop({
                category: 'linear',
                symbol: symbol,
                stopLoss: bePrice.toString(),
                positionIdx: parseInt(trade.position_id || '0') as 0 | 1 | 2,
                tpslMode: 'Full' // Apply stop loss to 100% of position automatically
              });

              await db.updateTrade(trade.id, {
                stop_loss: bePrice,
                stop_loss_breakeven: true
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
                  logger.debug('Updated stop loss order quantity when moving to breakeven', {
                    tradeId: trade.id,
                    orderId: stopLossOrder.id,
                    quantity: trade.quantity
                  });
                }
              } catch (error) {
                logger.warn('Failed to update stop loss order quantity when moving to breakeven', {
                  tradeId: trade.id,
                  error: serializeErrorForLog(error)
                });
              }

              logger.info('Stop loss moved to entry', {
                tradeId: trade.id,
                bePrice
              });
            } catch (error) {
              logger.error('Error moving stop loss to entry', {
                tradeId: trade.id,
                error: serializeErrorForLog(error)
              });
            }
          }
        } else {
          throw new Error(`Failed to partially close position: ${JSON.stringify(closeOrder)}`);
        }
      }
    }
  } else if (trade.exchange === 'ctrader' && ctraderClient && trade.position_id) {
    // cTrader partial close: use ProtoOAClosePositionReq (proper close API, never opens new positions)
    try {
      const positions = await ctraderClient.getOpenPositions();
      const { protobufLongToNumber } = await import('../utils/protobufLong.js');
      const positionIdNum = parseInt(trade.position_id, 10);
      const position = positions.find((p: any) => {
        const pid = typeof p.positionId === 'object' && p.positionId?.low != null
          ? protobufLongToNumber(p.positionId)
          : p.positionId ?? p.id;
        return pid != null && (typeof pid === 'number' ? pid : parseInt(String(pid), 10)) === positionIdNum;
      });
      if (!position) {
        logger.warn('cTrader position not found for partial close', {
          tradeId: trade.id,
          positionId: trade.position_id
        });
        return;
      }
      const vol = position.volume ?? position.quantity;
      const positionVolume = typeof vol === 'object' && vol?.low != null
        ? protobufLongToNumber(vol) ?? 0
        : parseFloat(String(vol || '0'));
      if (positionVolume <= 0) return;

      const symbol = trade.trading_pair.replace('/', '');
      const symbolInfo = await ctraderClient.getSymbolInfo(symbol);
      const lotSize = typeof symbolInfo?.lotSize === 'object' && symbolInfo.lotSize?.low != null
        ? symbolInfo.lotSize.low
        : symbolInfo?.lotSize ?? 100;
      const positionLots = positionVolume / lotSize;
      const closeVolumeLots = Math.max(0.01, (positionLots * percentage) / 100);

      await ctraderClient.closePosition(trade.position_id, closeVolumeLots, symbol);

      logger.info('Partial position closed on cTrader', {
        tradeId: trade.id,
        tradingPair: trade.trading_pair,
        percentage,
        closeVolumeLots
      });

      if (moveStopLossToEntry) {
        try {
          const bePrice = await getEntryFillPrice(trade, db, { ctraderClient });
          await ctraderClient.modifyPosition({
            positionId: trade.position_id,
            stopLoss: bePrice
          });
          await db.updateTrade(trade.id, {
            stop_loss: bePrice,
            stop_loss_breakeven: true
          });
          logger.info('Stop loss moved to entry on cTrader', {
            tradeId: trade.id,
            bePrice
          });
        } catch (slError) {
          logger.error('Error moving stop loss to entry on cTrader', {
            tradeId: trade.id,
            error: serializeErrorForLog(slError)
          });
        }
      }
    } catch (error) {
      logger.error('Failed to partially close cTrader position', {
        tradeId: trade.id,
        tradingPair: trade.trading_pair,
        error: serializeErrorForLog(error)
      });
      throw error;
    }
  }
}

