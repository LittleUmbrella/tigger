import { MonitorConfig } from '../types/config.js';
import { DatabaseManager, Trade, Order } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';
import { CTraderClient } from '../clients/ctraderClient.js';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { protobufLongToNumber } from '../utils/protobufLong.js';
import {
  getIsLong,
  checkTradeExpired,
  updateEntryOrderToFilled,
  checkStopLossHit,
  checkTPHitBeforeEntry,
  checkSLHitBeforeEntry,
  updateOrderToFilled,
  updateTradeOnPositionClosed,
  updateTradeOnStopLossHit,
  cancelTrade,
  sleep,
  MONITOR_TRADE_TIMEOUT_MS
} from './shared.js';
import { normalizeCTraderSymbol } from '../utils/ctraderSymbolUtils.js';

/**
 * Get current price from cTrader
 */
const getCurrentPrice = async (
  tradingPair: string,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider
): Promise<number | null> => {
  try {
    if (isSimulation && priceProvider) {
      const price = priceProvider.getCurrentPrice(tradingPair);
      if (price === null) {
        logger.warn('No historical price data available', {
          tradingPair,
          exchange: 'ctrader'
        });
      }
      return price;
    } else if (ctraderClient) {
      const symbol = normalizeCTraderSymbol(tradingPair);
      const price = await ctraderClient.getCurrentPrice(symbol);
      if (price !== null) {
        logger.debug('Got current price from cTrader', {
          tradingPair,
          symbol,
          price,
          exchange: 'ctrader'
        });
        return price;
      }
    }
    return null;
  } catch (error) {
    logger.error('Error getting current price from cTrader', {
      tradingPair,
      exchange: 'ctrader',
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
};

/**
 * Check if entry order is filled for cTrader
 * Implements advanced order querying with multiple fallback strategies (Gap #5)
 */
const checkEntryFilled = async (
  trade: Trade,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider
): Promise<{ filled: boolean; positionId?: string; filledAt?: string; filledPrice?: number }> => {
  try {
    if (isSimulation) {
      if (priceProvider) {
        const currentPrice = await priceProvider.getCurrentPrice(trade.trading_pair);
        if (currentPrice !== null) {
          const isLong = currentPrice >= trade.entry_price;
          const tolerance = trade.entry_price * 0.001;
          const filled = Math.abs(currentPrice - trade.entry_price) <= tolerance || 
                 (isLong && currentPrice > trade.entry_price) ||
                 (!isLong && currentPrice < trade.entry_price);
          if (filled) {
            return { filled: true, positionId: `SIM-${trade.id}` };
          }
        }
      }
      return { filled: false };
    } else if (ctraderClient) {
      const symbol = normalizeCTraderSymbol(trade.trading_pair);
      
      logger.info('Checking cTrader entry fill status', {
        tradeId: trade.id,
        symbol,
        orderId: trade.order_id,
        channel: trade.channel,
        exchange: 'ctrader'
      });
      
      // Strategy 1: Check positions first (most reliable indicator)
      let positions: any[] = [];
      const maxRetries = 3;
      const retryDelay = 1000;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          positions = await ctraderClient.getOpenPositions();
          logger.info('cTrader positions received', {
            tradeId: trade.id,
            symbol,
            positionsCount: positions.length,
            channel: trade.channel,
            exchange: 'ctrader'
          });
          
          if (positions.length >= 0) {
            break; // Got response, exit retry loop
          }
        } catch (error) {
          logger.debug('Error getting positions, retrying', {
            tradeId: trade.id,
            symbol,
            attempt,
            maxRetries,
            error: error instanceof Error ? error.message : String(error)
          });
          
          if (attempt < maxRetries) {
            await sleep(retryDelay);
          }
        }
      }
      
      const position = positions.find((p: any) => {
        const positionSymbol = p.symbolName || p.symbol;
        const volume = Math.abs(p.volume || p.quantity || 0);
        const matches = positionSymbol === symbol && volume > 0;
        
        logger.debug('Checking position match', {
          tradeId: trade.id,
          positionSymbol,
          expectedSymbol: symbol,
          volume,
          matches
        });
        
        return matches;
      });
      
      if (position) {
        const positionId = position.positionId || position.id;
        const openTs = position.tradeData?.openTimestamp ?? position.openTimestamp;
        const tsMs = protobufLongToNumber(openTs);
        const filledAt = tsMs != null && tsMs > 0 ? new Date(tsMs).toISOString() : undefined;
        const filledPrice = parseFloat(
          position.avgPrice || position.averagePrice || position.price || '0'
        );
        logger.info('Found open cTrader position for trade, entry likely filled', {
          tradeId: trade.id,
          symbol,
          positionId: positionId?.toString(),
          volume: position.volume || position.quantity,
          orderId: trade.order_id,
          filledPrice: filledPrice > 0 ? filledPrice : undefined,
          exchange: 'ctrader'
        });
        return {
          filled: true,
          positionId: positionId?.toString(),
          filledAt,
          filledPrice: filledPrice > 0 ? filledPrice : undefined,
        };
      }
      
      // Strategy 2: Check open orders by orderId
      if (trade.order_id) {
        logger.info('Checking cTrader open orders', {
          tradeId: trade.id,
          symbol,
          orderId: trade.order_id,
          channel: trade.channel,
          exchange: 'ctrader'
        });
        
        try {
          const openOrders = await ctraderClient.getOpenOrders();
          logger.info('cTrader open orders received', {
            tradeId: trade.id,
            symbol,
            openOrdersCount: openOrders.length,
            channel: trade.channel,
            exchange: 'ctrader'
          });
          
          const order = openOrders.find((o: any) => {
            const oId = o.orderId || o.id;
            const matches = oId?.toString() === trade.order_id;
            
            logger.debug('Checking order match', {
              tradeId: trade.id,
              orderId: oId?.toString(),
              expectedOrderId: trade.order_id,
              matches
            });
            
            return matches;
          });
          
          if (!order) {
            // Order not in open orders - might be filled
            logger.debug('cTrader order not found in open orders, checking positions again', {
              tradeId: trade.id,
              symbol,
              orderId: trade.order_id,
              exchange: 'ctrader'
            });
            
            // Strategy 3: Re-check positions (position might have been created after initial check)
            const positionsAgain = await ctraderClient.getOpenPositions();
            const positionAgain = positionsAgain.find((p: any) => {
              const positionSymbol = p.symbolName || p.symbol;
              const volume = Math.abs(p.volume || p.quantity || 0);
              return positionSymbol === symbol && volume > 0;
            });
            
            if (positionAgain) {
              const posId = positionAgain.positionId || positionAgain.id;
              const openTs = positionAgain.tradeData?.openTimestamp ?? positionAgain.openTimestamp;
              const tsMs = protobufLongToNumber(openTs);
              const filledAt = tsMs != null && tsMs > 0 ? new Date(tsMs).toISOString() : undefined;
              const filledPrice = parseFloat(
                positionAgain.avgPrice ||
                  positionAgain.averagePrice ||
                  positionAgain.price ||
                  '0'
              );
              logger.info('Found position on re-check after order not found', {
                tradeId: trade.id,
                symbol,
                positionId: posId?.toString(),
                filledPrice: filledPrice > 0 ? filledPrice : undefined,
                exchange: 'ctrader'
              });
              return {
                filled: true,
                positionId: posId?.toString(),
                filledAt,
                filledPrice: filledPrice > 0 ? filledPrice : undefined,
              };
            }
            
            // Order filled but position closed already (edge case)
            logger.debug('Order not found and no position - assuming filled but position closed', {
              tradeId: trade.id,
              symbol,
              orderId: trade.order_id,
              exchange: 'ctrader'
            });
            return { filled: true };
          } else {
            // Order still open - check status
            const orderStatus = order.orderStatus || order.status;
            logger.debug('cTrader order found in open orders', {
              tradeId: trade.id,
              symbol,
              orderId: trade.order_id,
              orderStatus,
              exchange: 'ctrader'
            });
            
            if (orderStatus === 'FILLED' || orderStatus === 'PARTIALLY_FILLED') {
              const positionId = order.positionId || order.id;
              const updTs = order.utcLastUpdateTimestamp ?? order.tradeData?.openTimestamp;
              const tsMs = protobufLongToNumber(updTs);
              const filledAt = tsMs != null && tsMs > 0 ? new Date(tsMs).toISOString() : undefined;
              logger.info('Order status indicates filled', {
                tradeId: trade.id,
                symbol,
                orderId: trade.order_id,
                orderStatus,
                positionId: positionId?.toString(),
                exchange: 'ctrader'
              });
              return { filled: true, positionId: positionId?.toString(), filledAt };
            }
          }
        } catch (error) {
          logger.debug('Error checking cTrader orders', {
            tradeId: trade.id,
            symbol,
            orderId: trade.order_id,
            error: error instanceof Error ? error.message : String(error),
            exchange: 'ctrader'
          });
        }
      } else {
        logger.debug('No order ID available, checking positions only', {
          tradeId: trade.id,
          symbol,
          exchange: 'ctrader'
        });
      }
    }
    return { filled: false };
  } catch (error) {
    logger.error('Error checking cTrader entry filled', {
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error),
      exchange: 'ctrader'
    });
    return { filled: false };
  }
};

/**
 * Check if position is closed for cTrader
 * Implements retry logic and detailed logging (Gaps #4, #6)
 */
const checkPositionClosed = async (
  trade: Trade,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider
): Promise<{ closed: boolean; exitPrice?: number; pnl?: number }> => {
  try {
    logger.debug('Checking if cTrader position is closed', {
      tradeId: trade.id,
      positionId: trade.position_id,
      symbol: trade.trading_pair,
      exchange: 'ctrader'
    });

    if (isSimulation && priceProvider && trade.entry_filled_at) {
      const currentPrice = await priceProvider.getCurrentPrice(trade.trading_pair);
      if (currentPrice === null) {
        logger.debug('No current price available in simulation', {
          tradeId: trade.id,
          exchange: 'ctrader'
        });
        return { closed: false };
      }

      const takeProfits = JSON.parse(trade.take_profits) as number[];
      const isLong = currentPrice > trade.entry_price;
      
      const stopLossHit = isLong
        ? currentPrice <= trade.stop_loss
        : currentPrice >= trade.stop_loss;
      
      let tpHit = false;
      let hitTP = 0;
      for (const tp of takeProfits) {
        const tpHitCheck = isLong ? currentPrice >= tp : currentPrice <= tp;
        if (tpHitCheck) {
          tpHit = true;
          hitTP = tp;
          break;
        }
      }

      logger.debug('Simulation position close check', {
        tradeId: trade.id,
        isLong,
        currentPrice,
        stopLoss: trade.stop_loss,
        stopLossHit,
        takeProfits,
        tpHit,
        hitTP,
        exchange: 'ctrader'
      });

      if (stopLossHit || tpHit) {
        const exitPrice = currentPrice;
        const priceDiff = exitPrice - trade.entry_price;
        const pnl = isLong ? priceDiff : -priceDiff;
        const positionSize = (trade.entry_price * (trade.risk_percentage / 100)) / Math.abs(priceDiff / trade.entry_price);
        const actualPnl = (pnl / trade.entry_price) * positionSize * trade.leverage;
        
        logger.info('Position closed in simulation', {
          tradeId: trade.id,
          exitPrice,
          pnl: actualPnl,
          stopLossHit,
          tpHit,
          hitTP,
          exchange: 'ctrader'
        });
        
        return {
          closed: true,
          exitPrice,
          pnl: actualPnl
        };
      }
      
      return { closed: false };
    } else if (ctraderClient && trade.position_id) {
      const symbol = normalizeCTraderSymbol(trade.trading_pair);
      
      logger.info('Checking if cTrader position closed', {
        tradeId: trade.id,
        symbol,
        positionId: trade.position_id,
        channel: trade.channel,
        exchange: 'ctrader'
      });
      
      // Get positions with retry logic (Gap #4)
      let positions: any[] = [];
      const maxRetries = 3;
      const retryDelay = 1000;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          positions = await ctraderClient.getOpenPositions();
          
          logger.info('cTrader positions received for close check', {
            tradeId: trade.id,
            symbol,
            positionId: trade.position_id,
            positionsCount: positions.length,
            channel: trade.channel,
            exchange: 'ctrader'
          });
          
          if (positions.length >= 0) {
            break; // Got response, exit retry loop
          }
        } catch (error) {
          logger.debug('Error getting positions for close check, retrying', {
            tradeId: trade.id,
            symbol,
            attempt,
            maxRetries,
            error: error instanceof Error ? error.message : String(error),
            exchange: 'ctrader'
          });
          
          if (attempt < maxRetries) {
            await sleep(retryDelay);
          }
        }
      }
      
      const position = positions.find((p: any) => {
        const positionId = p.positionId || p.id;
        const positionSymbol = p.symbolName || p.symbol;
        const matches = positionSymbol === symbol && positionId?.toString() === trade.position_id;
        
        logger.debug('Checking position match for close check', {
          tradeId: trade.id,
          positionId: positionId?.toString(),
          expectedPositionId: trade.position_id,
          positionSymbol,
          expectedSymbol: symbol,
          matches,
          volume: p.volume || p.quantity,
          exchange: 'ctrader'
        });
        
        return matches;
      });
      
      // If position doesn't exist or volume is 0, it's closed
      if (!position || Math.abs(position.volume || position.quantity || 0) === 0) {
        logger.info('cTrader position closed', {
          tradeId: trade.id,
          symbol,
          positionId: trade.position_id,
          foundPosition: !!position,
          positionVolume: position ? (position.volume || position.quantity) : 0,
          exchange: 'ctrader',
          note: 'Position not found or volume is zero - position is closed'
        });
        // Try to get closed position info from deal history or similar
        // cTrader API might have a way to get closed positions
        // For now, return closed without exit price/PNL
        return { closed: true };
      } else {
        logger.debug('Position still open', {
          tradeId: trade.id,
          symbol,
          positionId: trade.position_id,
          volume: position.volume || position.quantity,
          exchange: 'ctrader'
        });
      }
    } else {
      logger.debug('Cannot check position close - missing client or position ID', {
        tradeId: trade.id,
        hasClient: !!ctraderClient,
        hasPositionId: !!trade.position_id,
        exchange: 'ctrader'
      });
    }
    return { closed: false };
  } catch (error) {
    logger.error('Error checking cTrader position closed', {
      tradeId: trade.id,
      positionId: trade.position_id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      exchange: 'ctrader'
    });
    return { closed: false };
  }
};

/**
 * Cancel order(s) for cTrader.
 */
const cancelOrder = async (
  trade: Trade,
  ctraderClient?: CTraderClient
): Promise<void> => {
  try {
    if (!ctraderClient) return;
    if (trade.order_id) {
      await ctraderClient.cancelOrder(trade.order_id);
      logger.info('cTrader order cancelled', {
        tradeId: trade.id,
        orderId: trade.order_id,
        channel: trade.channel,
        messageId: trade.message_id,
        symbol: trade.trading_pair,
        exchange: 'ctrader'
      });
    }
  } catch (error) {
    logger.error('Error cancelling cTrader order', {
      tradeId: trade.id,
      exchange: 'ctrader',
      orderId: trade.order_id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

/**
 * Check if order is filled for cTrader
 * Implements advanced order querying with detailed logging (Gaps #5, #6)
 * @param openOrders - Optional pre-fetched open orders to avoid repeated reconcile calls (each getOpenOrders = full ProtoOAReconcileReq)
 */
const checkOrderFilled = async (
  order: Order,
  trade: Trade,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider,
  openOrders?: any[]
): Promise<{ filled: boolean; filledPrice?: number }> => {
  try {
    // Position TP marker is on the position, not a separate order - fill is detected when position closes
    if (order.order_id === 'ctrader_position_tp') {
      return { filled: false };
    }

    logger.debug('Checking if cTrader order is filled', {
      orderId: order.id,
      orderType: order.order_type,
      orderPrice: order.price,
      tradeId: trade.id,
      symbol: trade.trading_pair,
      exchange: 'ctrader'
    });

    if (isSimulation && priceProvider) {
      const currentPrice = await priceProvider.getCurrentPrice(trade.trading_pair);
      if (currentPrice === null) {
        logger.debug('No current price available in simulation', {
          orderId: order.id,
          tradeId: trade.id,
          exchange: 'ctrader'
        });
        return { filled: false };
      }

      const isLong = currentPrice > trade.entry_price;
      let filled = false;

      if (order.order_type === 'stop_loss') {
        filled = isLong
          ? currentPrice <= order.price
          : currentPrice >= order.price;
        logger.debug('Simulation SL fill check', {
          orderId: order.id,
          tradeId: trade.id,
          isLong,
          currentPrice,
          slPrice: order.price,
          filled,
          exchange: 'ctrader'
        });
      } else if (order.order_type === 'take_profit' || order.order_type === 'breakeven_limit') {
        filled = isLong
          ? currentPrice >= order.price
          : currentPrice <= order.price;
        logger.debug('Simulation TP/BE fill check', {
          orderId: order.id,
          tradeId: trade.id,
          isLong,
          currentPrice,
          orderPrice: order.price,
          filled,
          exchange: 'ctrader'
        });
      }

      if (filled) {
        logger.info('Order filled in simulation', {
          orderId: order.id,
          orderType: order.order_type,
          tradeId: trade.id,
          filledPrice: currentPrice,
          exchange: 'ctrader'
        });
        return { filled: true, filledPrice: currentPrice };
      }
      return { filled: false };
    } else if (ctraderClient && order.order_id) {
      const symbol = normalizeCTraderSymbol(trade.trading_pair);
      
      // Use pre-fetched open orders when provided to avoid N reconcile calls per trade
      let ordersToCheck = openOrders;
      if (ordersToCheck === undefined) {
        logger.debug('Querying cTrader open orders', {
          orderId: order.id,
          orderType: order.order_type,
          storedOrderId: order.order_id,
          tradeId: trade.id,
          symbol,
          exchange: 'ctrader'
        });
        ordersToCheck = await ctraderClient.getOpenOrders();
      }
      
      logger.debug('Open orders retrieved', {
        orderId: order.id,
        tradeId: trade.id,
        symbol,
        openOrdersCount: ordersToCheck.length,
        exchange: 'ctrader'
      });
      
      const foundOrder = ordersToCheck.find((o: any) => {
        const oId = o.orderId || o.id;
        const matches = oId?.toString() === order.order_id;
        
        logger.debug('Checking order match', {
          orderId: order.id,
          storedOrderId: order.order_id,
          foundOrderId: oId?.toString(),
          matches,
          exchange: 'ctrader'
        });
        
        return matches;
      });
      
      if (!foundOrder) {
        // Order not in open orders, likely filled
        logger.info('Order not found in open orders - likely filled', {
          orderId: order.id,
          orderType: order.order_type,
          storedOrderId: order.order_id,
          tradeId: trade.id,
          symbol,
          exchange: 'ctrader'
        });
        return { filled: true, filledPrice: order.price };
      } else {
        const orderStatus = foundOrder.orderStatus || foundOrder.status;
        logger.debug('Order found in open orders', {
          orderId: order.id,
          orderType: order.order_type,
          storedOrderId: order.order_id,
          orderStatus,
          tradeId: trade.id,
          symbol,
          exchange: 'ctrader'
        });
        
        if (orderStatus === 'FILLED') {
          const filledPrice = foundOrder.filledPrice || foundOrder.executionPrice || order.price;
          const finalPrice = typeof filledPrice === 'number' ? filledPrice : parseFloat(filledPrice || order.price.toString());
          
          logger.info('Order status indicates filled', {
            orderId: order.id,
            orderType: order.order_type,
            storedOrderId: order.order_id,
            orderStatus,
            filledPrice: finalPrice,
            tradeId: trade.id,
            symbol,
            exchange: 'ctrader'
          });
          
          return { filled: true, filledPrice: finalPrice };
        } else {
          logger.debug('Order still pending', {
            orderId: order.id,
            orderType: order.order_type,
            storedOrderId: order.order_id,
            orderStatus,
            tradeId: trade.id,
            exchange: 'ctrader'
          });
        }
      }
    } else {
      logger.debug('Cannot check order fill - missing client or order ID', {
        orderId: order.id,
        tradeId: trade.id,
        hasClient: !!ctraderClient,
        hasOrderId: !!order.order_id,
        exchange: 'ctrader'
      });
    }
    return { filled: false };
  } catch (error) {
    logger.error('Error checking cTrader order filled', {
      orderId: order.id,
      orderType: order.order_type,
      tradeId: trade.id,
      exchange: 'ctrader',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return { filled: false };
  }
};

/**
 * Monitor a single cTrader trade
 */
const monitorTrade = async (
  channel: string,
  entryTimeoutMinutes: number,
  trade: Trade,
  db: DatabaseManager,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider: HistoricalPriceProvider | undefined
): Promise<void> => {
  const timings: Record<string, number> = {};
  let t0 = Date.now();
  const monitorStart = Date.now();

  try {
    logger.info('Monitoring cTrader trade', {
      tradeId: trade.id,
      status: trade.status,
      symbol: trade.trading_pair,
      orderId: trade.order_id,
      positionId: trade.position_id,
      channel: trade.channel,
      exchange: 'ctrader'
    });

    // Check if trade has expired
    t0 = Date.now();
    if (await checkTradeExpired(trade, isSimulation, priceProvider)) {
      timings.checkTradeExpired = Date.now() - t0;
      logger.info('cTrader trade expired - cancelling order and sibling trades', {
        tradeId: trade.id,
        orderId: trade.order_id,
        channel: trade.channel,
        messageId: trade.message_id,
        symbol: trade.trading_pair,
        expiresAt: trade.expires_at,
        cancelReason: 'expired',
        exchange: 'ctrader'
      });
      await cancelOrder(trade, ctraderClient);
      await cancelTrade(trade, db);
      // Cancel sibling trades (N-trades from same message) - cancel their entry orders and mark cancelled
      const siblings = (await db.getTradesByMessageId(trade.message_id, trade.channel))
        .filter((t) => t.exchange === 'ctrader' && t.status === 'pending' && t.id !== trade.id);
      for (const sibling of siblings) {
        await cancelOrder(sibling, ctraderClient);
        await cancelTrade(sibling, db);
        logger.info('cTrader sibling trade cancelled on expiry', {
          siblingTradeId: sibling.id,
          messageId: trade.message_id,
          channel: trade.channel,
          exchange: 'ctrader'
        });
      }
      return;
    }
    timings.checkTradeExpired = Date.now() - t0;

    // For pending trades, check if position already exists
    t0 = Date.now();
    if (trade.status === 'pending' && !isSimulation && ctraderClient) {
      try {
        const positions = await ctraderClient.getOpenPositions();
        const symbol = normalizeCTraderSymbol(trade.trading_pair);
        const position = positions.find((p: any) => {
          const positionSymbol = p.symbolName || p.symbol;
          const volume = Math.abs(p.volume || p.quantity || 0);
          return positionSymbol === symbol && volume > 0;
        });
        
        if (position) {
          const positionId = position.positionId || position.id;
          const fillTime = trade.entry_filled_at || dayjs().toISOString();
          const fillPrice = parseFloat(
            position.avgPrice || position.averagePrice || position.price || '0'
          );
          
          logger.info('cTrader entry order filled', {
            tradeId: trade.id,
            tradingPair: trade.trading_pair,
            entryPrice: trade.entry_price,
            fillPrice: fillPrice > 0 ? fillPrice : undefined,
            positionId: positionId?.toString(),
            channel: trade.channel,
            exchange: 'ctrader',
            note: 'Detected via position check - entry was filled but status not updated'
          });
          
          const updates: { status: 'active'; entry_filled_at: string; position_id?: string; entry_price?: number } = {
            status: 'active',
            entry_filled_at: fillTime,
            position_id: positionId?.toString(),
          };
          if (fillPrice > 0) {
            updates.entry_price = fillPrice;
          }
          await db.updateTrade(trade.id, updates);
          trade.status = 'active';
          trade.entry_filled_at = fillTime;
          if (fillPrice > 0) {
            trade.entry_price = fillPrice;
          }
          trade.position_id = positionId?.toString();

          await updateEntryOrderToFilled(trade, db, fillTime, fillPrice > 0 ? fillPrice : undefined);
        }
      } catch (error) {
        logger.debug('Error checking cTrader positions for pending trade', {
          tradeId: trade.id,
          exchange: 'ctrader',
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    timings.pendingPositionCheck = Date.now() - t0;

    // Get current price
    t0 = Date.now();
    const currentPrice = await getCurrentPrice(trade.trading_pair, ctraderClient, isSimulation, priceProvider);
    if (!currentPrice) {
      logger.warn('Could not get current price for cTrader trade', {
        tradeId: trade.id,
        tradingPair: trade.trading_pair,
        exchange: 'ctrader'
      });
      return;
    }
    timings.getCurrentPrice = Date.now() - t0;

    // Check if entry price was hit before stop loss or take profit (for pending trades)
    if (trade.status === 'pending') {
      const isLong = getIsLong(trade);
      
      if (checkSLHitBeforeEntry(trade, currentPrice)) {
        logger.info('Price hit SL before entry - cancelling cTrader order and sibling trades', {
          tradeId: trade.id,
          currentPrice,
          stopLoss: trade.stop_loss,
          entryPrice: trade.entry_price,
          exchange: 'ctrader'
        });
        await cancelOrder(trade, ctraderClient);
        await cancelTrade(trade, db);
        const siblings = (await db.getTradesByMessageId(trade.message_id, trade.channel))
          .filter((t) => t.exchange === 'ctrader' && t.status === 'pending' && t.id !== trade.id);
        for (const sibling of siblings) {
          await cancelOrder(sibling, ctraderClient);
          await cancelTrade(sibling, db);
        }
        return;
      }

      if (checkTPHitBeforeEntry(trade, currentPrice)) {
        logger.info('Price hit TP before entry - TP orders will fill and book profit', {
          tradeId: trade.id,
          currentPrice,
          entryPrice: trade.entry_price,
          exchange: 'ctrader',
          note: 'Relevant TP Orders will fill at current price and profit will be booked immediately'
        });
      }

      // Check if entry is filled
      logger.debug('Checking if cTrader entry order is filled', {
        tradeId: trade.id,
        symbol: trade.trading_pair,
        orderId: trade.order_id,
        status: trade.status,
        entryPrice: trade.entry_price,
        currentPrice,
        exchange: 'ctrader'
      });
      
      const entryResult = await checkEntryFilled(trade, ctraderClient, isSimulation, priceProvider);
      logger.debug('cTrader entry fill check result', {
        tradeId: trade.id,
        filled: entryResult.filled,
        positionId: entryResult.positionId,
        exchange: 'ctrader'
      });
      
      if (entryResult.filled) {
        const fillPrice = entryResult.filledPrice;
        logger.info('cTrader entry order filled', {
          tradeId: trade.id,
          tradingPair: trade.trading_pair,
          entryPrice: trade.entry_price,
          fillPrice,
          positionId: entryResult.positionId,
          channel: trade.channel,
          exchange: 'ctrader'
        });
        // Use actual fill time from position when available; dayjs() is monitor poll time and can be delayed
        const fillTime = entryResult.filledAt ?? dayjs().toISOString();
        const updates: { status: 'active'; entry_filled_at: string; position_id?: string; entry_price?: number } = {
          status: 'active',
          entry_filled_at: fillTime,
          position_id: entryResult.positionId,
        };
        if (fillPrice != null && fillPrice > 0) {
          updates.entry_price = fillPrice;
        }
        await db.updateTrade(trade.id, updates);
        trade.status = 'active';
        trade.entry_filled_at = fillTime;
        trade.position_id = entryResult.positionId;
        if (fillPrice != null && fillPrice > 0) {
          trade.entry_price = fillPrice;
        }

        await updateEntryOrderToFilled(trade, db, fillTime, fillPrice);
      }
    }

    // Monitor active trades
    if (trade.status === 'active' || trade.status === 'filled') {
      const orders = await db.getOrdersByTradeId(trade.id);

      // Check SL/TP orders for fills
      const pendingOrders = orders.filter(o => o.status === 'pending');
      // Fetch open orders ONCE and reuse - avoid N reconcile calls (was causing 60s timeout for trades with multiple orders)
      let cachedOpenOrders: any[] | undefined;
      t0 = Date.now();
      if (pendingOrders.length > 0 && ctraderClient) {
        try {
          cachedOpenOrders = await ctraderClient.getOpenOrders();
        } catch (err) {
          logger.warn('Failed to fetch open orders for fill check, will fetch per-order', {
            tradeId: trade.id,
            error: err instanceof Error ? err.message : String(err),
            exchange: 'ctrader'
          });
        }
      }
      timings.fetchOpenOrders = Date.now() - t0;

      t0 = Date.now();
      for (const order of pendingOrders) {
        const orderResult = await checkOrderFilled(order, trade, ctraderClient, isSimulation, priceProvider, cachedOpenOrders);
        if (orderResult.filled) {
          if (order.order_type === 'take_profit') {
            logger.info('cTrader take profit order filled', {
              tradeId: trade.id,
              tradingPair: trade.trading_pair,
              orderId: order.id,
              tpIndex: order.tp_index,
              tpPrice: order.price,
              filledPrice: orderResult.filledPrice,
              channel: trade.channel,
              exchange: 'ctrader'
            });
          } else if (order.order_type === 'stop_loss') {
            logger.info('cTrader stop loss order filled', {
              tradeId: trade.id,
              tradingPair: trade.trading_pair,
              orderId: order.id,
              slPrice: order.price,
              filledPrice: orderResult.filledPrice,
              channel: trade.channel,
              exchange: 'ctrader'
            });
          } else {
            logger.info('cTrader order filled', {
              tradeId: trade.id,
              orderId: order.id,
              orderType: order.order_type,
              filledPrice: orderResult.filledPrice,
              exchange: 'ctrader'
            });
          }

          await updateOrderToFilled(order, db, orderResult.filledPrice);

          if (order.order_type === 'stop_loss') {
            await updateTradeOnStopLossHit(trade, db, orderResult.filledPrice);
          }
        }
      }
      timings.checkOrderFillsLoop = Date.now() - t0;

      // Check if position is closed (pass db for fallback when position_id missing - detects orphans)
      t0 = Date.now();
      const positionResult = await checkPositionClosed(trade, ctraderClient, isSimulation, priceProvider);
      timings.checkPositionClosed = Date.now() - t0;
        if (positionResult.closed) {
        logger.info('cTrader position closed', {
          tradeId: trade.id,
          exitPrice: positionResult.exitPrice,
          pnl: positionResult.pnl,
          exchange: 'ctrader'
        });
        await updateTradeOnPositionClosed(trade, db, positionResult.exitPrice, positionResult.pnl);
        return;
      }

      // Check if stop loss is hit
      if (checkStopLossHit(trade, currentPrice)) {
        logger.info('cTrader stop loss hit', {
          tradeId: trade.id,
          currentPrice,
          stopLoss: trade.stop_loss,
          exchange: 'ctrader'
        });
        
        const stopLossResult = await checkPositionClosed(trade, ctraderClient, isSimulation, priceProvider);
        if (stopLossResult.closed) {
          await updateTradeOnStopLossHit(trade, db, stopLossResult.exitPrice, stopLossResult.pnl);
        } else {
          await db.updateTrade(trade.id, { status: 'stopped' });
        }
      }
    }
  } catch (error) {
    logger.error('Error monitoring cTrader trade', {
      tradeId: trade.id,
      exchange: 'ctrader',
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    const totalElapsedMs = Date.now() - monitorStart;
    const sumOfPhasesMs = Object.values(timings).reduce((a, b) => a + b, 0);
    logger.log('trace', 'cTrader monitor trade timings', {
      tradeId: trade.id,
      channel,
      exchange: 'ctrader',
      totalElapsedMs,
      sumOfPhasesMs,
      timings
    });
  }
};

/**
 * Start cTrader trade monitor
 */
export const startCTraderMonitor = async (
  monitorConfig: MonitorConfig,
  channel: string,
  db: DatabaseManager,
  isSimulation: boolean = false,
  priceProvider?: HistoricalPriceProvider,
  speedMultiplier?: number,
  getCTraderClient?: (accountName?: string) => Promise<CTraderClient | undefined>
): Promise<() => Promise<void>> => {
  logger.info('Starting cTrader trade monitor', { type: monitorConfig.type, channel });

  // Legacy support: create a single cTrader client if getCTraderClient not provided
  let ctraderClient: CTraderClient | undefined;
  if (!getCTraderClient) {
    const accessToken = process.env.CTRADER_ACCESS_TOKEN;
    const accountId = process.env.CTRADER_ACCOUNT_ID;
    const clientId = process.env.CTRADER_CLIENT_ID;
    const clientSecret = process.env.CTRADER_CLIENT_SECRET;

    if (!accessToken || !accountId) {
      logger.error('cTrader credentials not found in environment variables', {
        channel,
        missing: !accessToken ? 'CTRADER_ACCESS_TOKEN' : 'CTRADER_ACCOUNT_ID'
      });
      throw new Error('cTrader credentials required for ctrader monitor');
    }

    const clientConfig = {
      clientId: clientId || '',
      clientSecret: clientSecret || '',
      accessToken,
      accountId,
      environment: 'demo' as 'demo' | 'live'
    };
    
    ctraderClient = new CTraderClient(clientConfig);
    try {
      await ctraderClient.connect();
      await ctraderClient.authenticate();
      logger.info('cTrader monitor client initialized', {
        channel,
        type: monitorConfig.type,
        exchange: 'ctrader'
      });
    } catch (error) {
      logger.error('Failed to initialize cTrader client', {
        channel,
        exchange: 'ctrader',
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  let running = true;
  const pollInterval = monitorConfig.pollInterval || 10000;
  const entryTimeoutMinutes = monitorConfig.entryTimeoutMinutes || 2880;

  const monitorLoop = async (): Promise<void> => {
    const isMaxSpeed = speedMultiplier !== undefined && (speedMultiplier === 0 || speedMultiplier === Infinity || !isFinite(speedMultiplier));
    
    while (running) {
      try {
        const trades = (await db.getActiveTrades()).filter(t => t.channel === channel && t.exchange === 'ctrader');
        
        // Process each trade in parallel with per-trade timeout - prevents one stuck trade from blocking others
        const tradeTasks = trades.map(async (trade) => {
          const accountCTraderClient = getCTraderClient
            ? await getCTraderClient(trade.account_name)
            : ctraderClient;
          if (!accountCTraderClient) {
            logger.warn('No cTrader client for trade - cannot check position or cancel orders', {
              tradeId: trade.id,
              channel,
              accountName: trade.account_name ?? '(none)',
              exchange: 'ctrader'
            });
          }
          return Promise.race([
            monitorTrade(
              channel,
              entryTimeoutMinutes,
              trade,
              db,
              accountCTraderClient,
              isSimulation,
              priceProvider
            ),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error(`Trade ${trade.id} monitor timeout after ${MONITOR_TRADE_TIMEOUT_MS}ms`)), MONITOR_TRADE_TIMEOUT_MS)
            )
          ]);
        });

        const results = await Promise.allSettled(tradeTasks);
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result.status === 'rejected') {
            const trade = trades[i];
            const isTimeout = result.reason instanceof Error && result.reason.message.includes('timeout');
            logger.warn(isTimeout ? 'Monitor trade timed out - will retry next poll' : 'Monitor trade failed', {
              tradeId: trade.id,
              channel,
              exchange: 'ctrader',
              error: result.reason instanceof Error ? result.reason.message : String(result.reason)
            });
          }
        }

        if (!isMaxSpeed) {
          await sleep(pollInterval);
        } else {
          await new Promise(resolve => setImmediate(resolve));
        }
      } catch (error) {
        logger.error('Error in cTrader monitor loop', {
          channel,
          exchange: 'ctrader',
          error: error instanceof Error ? error.message : String(error)
        });
        if (!isMaxSpeed) {
          await sleep(pollInterval * 2);
        }
      }
    }
  };

  monitorLoop().catch(error => {
    logger.error('Fatal error in cTrader monitor loop', {
      channel,
      exchange: 'ctrader',
      error: error instanceof Error ? error.message : String(error)
    });
  });

  return async (): Promise<void> => {
    logger.info('Stopping cTrader trade monitor', { type: monitorConfig.type, channel, exchange: 'ctrader' });
    running = false;
  };
};

