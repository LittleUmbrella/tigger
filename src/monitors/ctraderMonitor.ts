import { MonitorConfig } from '../types/config.js';
import { DatabaseManager, Trade, Order } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';
import { CTraderClient } from '../clients/ctraderClient.js';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { roundPrice, roundQuantity, distributeQuantityAcrossTPs, validateAndRedistributeTPQuantities } from '../utils/positionSizing.js';
import {
  getIsLong,
  checkTradeExpired,
  updateEntryOrderToFilled,
  checkStopLossHit,
  checkTPHitBeforeEntry,
  checkSLHitBeforeEntry,
  calculatePNLPercentage,
  countFilledTakeProfits,
  getBreakevenLimitOrder,
  updateOrderToFilled,
  updateTradeOnPositionClosed,
  updateTradeOnStopLossHit,
  updateTradeOnBreakevenFilled,
  cancelTrade,
  sleep
} from './shared.js';

/**
 * Normalize trading pair symbol for cTrader
 * cTrader uses format like "BTCUSD" or "EURUSD"
 */
const normalizeCTraderSymbol = (tradingPair: string): string => {
  let normalized = tradingPair.replace('/', '').toUpperCase();
  
  // cTrader typically uses formats like BTCUSD, EURUSD, etc.
  // If it doesn't end with USD, add it
  if (!normalized.endsWith('USD')) {
    const commonQuotes = ['USDT', 'USDC', 'EUR', 'GBP', 'JPY'];
    const hasQuote = commonQuotes.some(quote => normalized.endsWith(quote));
    if (!hasQuote) {
      normalized = normalized + 'USD';
    }
  }
  
  return normalized;
};

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
        logger.warn('No historical price data available', { tradingPair });
      }
      return price;
    } else if (ctraderClient) {
      const symbol = normalizeCTraderSymbol(tradingPair);
      const price = await ctraderClient.getCurrentPrice(symbol);
      if (price !== null) {
        logger.debug('Got current price from cTrader', {
          tradingPair,
          symbol,
          price
        });
        return price;
      }
    }
    return null;
  } catch (error) {
    logger.error('Error getting current price from cTrader', {
      tradingPair,
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
): Promise<{ filled: boolean; positionId?: string }> => {
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
      
      logger.debug('Checking cTrader positions for entry fill', {
        tradeId: trade.id,
        symbol,
        orderId: trade.order_id,
        exchange: 'ctrader'
      });
      
      // Strategy 1: Check positions first (most reliable indicator)
      let positions: any[] = [];
      const maxRetries = 3;
      const retryDelay = 1000;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          positions = await ctraderClient.getOpenPositions();
          logger.debug('cTrader position API response', {
            tradeId: trade.id,
            symbol,
            positionsCount: positions.length,
            attempt,
            maxRetries
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
        logger.info('Found open cTrader position for trade, entry likely filled', {
          tradeId: trade.id,
          symbol,
          positionId: positionId?.toString(),
          volume: position.volume || position.quantity,
          orderId: trade.order_id,
          exchange: 'ctrader'
        });
        return { filled: true, positionId: positionId?.toString() };
      }
      
      // Strategy 2: Check open orders by orderId
      if (trade.order_id) {
        logger.debug('Order ID available, checking open orders', {
          tradeId: trade.id,
          symbol,
          orderId: trade.order_id,
          exchange: 'ctrader'
        });
        
        try {
          const openOrders = await ctraderClient.getOpenOrders();
          logger.debug('Open orders retrieved', {
            tradeId: trade.id,
            symbol,
            openOrdersCount: openOrders.length,
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
              const positionId = positionAgain.positionId || positionAgain.id;
              logger.info('Found position on re-check after order not found', {
                tradeId: trade.id,
                symbol,
                positionId: positionId?.toString(),
                exchange: 'ctrader'
              });
              return { filled: true, positionId: positionId?.toString() };
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
              logger.info('Order status indicates filled', {
                tradeId: trade.id,
                symbol,
                orderId: trade.order_id,
                orderStatus,
                positionId: positionId?.toString(),
                exchange: 'ctrader'
              });
              return { filled: true, positionId: positionId?.toString() };
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
      
      // Get positions with retry logic (Gap #4)
      let positions: any[] = [];
      const maxRetries = 3;
      const retryDelay = 1000;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          positions = await ctraderClient.getOpenPositions();
          
          logger.debug('Position API response received for close check', {
            tradeId: trade.id,
            symbol,
            positionId: trade.position_id,
            positionsCount: positions.length,
            attempt,
            maxRetries,
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
 * Cancel order for cTrader
 */
const cancelOrder = async (
  trade: Trade,
  ctraderClient?: CTraderClient
): Promise<void> => {
  try {
    if (ctraderClient && trade.order_id) {
      await ctraderClient.cancelOrder(trade.order_id);
      logger.info('cTrader order cancelled', {
        tradeId: trade.id,
        orderId: trade.order_id,
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
 */
const checkOrderFilled = async (
  order: Order,
  trade: Trade,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider
): Promise<{ filled: boolean; filledPrice?: number }> => {
  try {
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
      
      logger.debug('Querying cTrader open orders', {
        orderId: order.id,
        orderType: order.order_type,
        storedOrderId: order.order_id,
        tradeId: trade.id,
        symbol,
        exchange: 'ctrader'
      });
      
      const openOrders = await ctraderClient.getOpenOrders();
      
      logger.debug('Open orders retrieved', {
        orderId: order.id,
        tradeId: trade.id,
        symbol,
        openOrdersCount: openOrders.length,
        exchange: 'ctrader'
      });
      
      const foundOrder = openOrders.find((o: any) => {
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
 * Place take profit orders for cTrader
 * Implements position size validation and precision handling (Gaps #2, #3)
 */
const placeTakeProfitOrders = async (
  trade: Trade,
  ctraderClient: CTraderClient | undefined,
  db: DatabaseManager
): Promise<void> => {
  try {
    if (!trade.entry_filled_at) {
      logger.debug('Entry not filled yet, skipping TP order placement', {
        tradeId: trade.id,
        exchange: 'ctrader'
      });
      return;
    }

    // Check if TP orders already exist first (before checking ctraderClient)
    // This allows the function to work in simulation mode where orders are created by the initiator/mock exchange
    let existingOrders = await db.getOrdersByTradeId(trade.id);
    const existingTPOrders = existingOrders.filter(o => o.order_type === 'take_profit');
    if (existingTPOrders.length > 0) {
      logger.debug('Take profit orders already exist for cTrader trade, skipping placement', {
        tradeId: trade.id,
        existingTPCount: existingTPOrders.length,
        exchange: 'ctrader'
      });
      return;
    }

    // Only proceed if we have a cTrader client and exchange is cTrader (for real exchange orders)
    if (!ctraderClient || trade.exchange !== 'ctrader') {
      logger.debug('Skipping take profit order placement - no cTrader client or not cTrader exchange', {
        tradeId: trade.id,
        exchange: trade.exchange,
        hasCTraderClient: !!ctraderClient
      });
      return;
    }

    const takeProfits = JSON.parse(trade.take_profits) as number[];
    if (!takeProfits || takeProfits.length === 0) {
      logger.debug('No take profits configured', {
        tradeId: trade.id,
        exchange: 'ctrader'
      });
      return;
    }

    const symbol = normalizeCTraderSymbol(trade.trading_pair);
    
    // Get position info with retry logic (Gap #4)
    let position: any = null;
    let positionResponse: any[] = [];
    const maxRetries = 3;
    const retryDelay = 1000; // 1 second
    
    logger.debug('Getting position info for TP order placement', {
      tradeId: trade.id,
      symbol,
      maxRetries,
      exchange: 'ctrader'
    });
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        positionResponse = await ctraderClient.getOpenPositions();
        
        logger.debug('Position API response received', {
          tradeId: trade.id,
          symbol,
          positionsCount: positionResponse.length,
          attempt,
          maxRetries,
          exchange: 'ctrader'
        });

        // If we have a position_id, try to find the specific position
        if (trade.position_id) {
          position = positionResponse.find((p: any) => {
            const positionId = p.positionId || p.id;
            const positionSymbol = p.symbolName || p.symbol;
            return positionSymbol === symbol && positionId?.toString() === trade.position_id;
          });
        }
        
        // If not found by position_id, find any position with non-zero size
        if (!position) {
          const positions = positionResponse.filter((p: any) => {
            const positionSymbol = p.symbolName || p.symbol;
            const volume = Math.abs(p.volume || p.quantity || 0);
            return positionSymbol === symbol && volume > 0;
          });
          if (positions.length > 0) {
            position = positions[0];
          }
        }
        
        if (position) {
          logger.debug('Position found', {
            tradeId: trade.id,
            symbol,
            positionId: (position.positionId || position.id)?.toString(),
            volume: position.volume || position.quantity,
            attempt,
            exchange: 'ctrader'
          });
          break; // Found position, exit retry loop
        }
      } catch (error) {
        logger.debug('Error getting positions, retrying', {
          tradeId: trade.id,
          symbol,
          attempt,
          maxRetries,
          error: error instanceof Error ? error.message : String(error),
          exchange: 'ctrader'
        });
      }
      
      // If this wasn't the last attempt, wait before retrying
      if (attempt < maxRetries && !position) {
        logger.debug('Position not found yet, retrying', {
          tradeId: trade.id,
          symbol,
          attempt,
          maxRetries,
          exchange: 'ctrader'
        });
        await sleep(retryDelay);
      }
    }

    if (!position) {
      logger.warn('No cTrader position found for TP order placement after retries', {
        tradeId: trade.id,
        symbol,
        positionId: trade.position_id,
        attempts: maxRetries,
        exchange: 'ctrader'
      });
      return;
    }

    const positionId = position.positionId || position.id;
    const positionVolume = Math.abs(position.volume || position.quantity || 0);
    
    // Determine position side
    let positionSide: 'BUY' | 'SELL';
    if (position.tradeSide && (position.tradeSide === 'BUY' || position.tradeSide === 'SELL')) {
      positionSide = position.tradeSide as 'BUY' | 'SELL';
    } else if (position.side && (position.side === 'BUY' || position.side === 'SELL')) {
      positionSide = position.side as 'BUY' | 'SELL';
    } else {
      // Fallback: infer from volume (positive = long/BUY, negative = short/SELL)
      positionSide = positionVolume > 0 ? 'BUY' : 'SELL';
      logger.debug('Position side not available, inferred from volume', {
        tradeId: trade.id,
        inferredSide: positionSide,
        positionVolume,
        exchange: 'ctrader'
      });
    }
    
    // TP side is always opposite of position side
    // For Long (Buy) position, TP is Sell
    // For Short (Sell) position, TP is Buy
    const tpSide = positionSide === 'BUY' ? 'SELL' : 'BUY';

    // Get symbol info for precision (Gap #3)
    logger.debug('Getting symbol info for precision', {
      tradeId: trade.id,
      symbol,
      exchange: 'ctrader'
    });
    
    let symbolInfo: any;
    try {
      symbolInfo = await ctraderClient.getSymbolInfo(symbol);
      logger.debug('Symbol info retrieved', {
        tradeId: trade.id,
        symbol,
        symbolInfo: {
          symbolId: symbolInfo.symbolId,
          symbolName: symbolInfo.symbolName,
          digits: symbolInfo.digits,
          pipSize: symbolInfo.pipSize
        },
        exchange: 'ctrader'
      });
    } catch (error) {
      logger.warn('Failed to get symbol info, using defaults', {
        tradeId: trade.id,
        symbol,
        error: error instanceof Error ? error.message : String(error),
        exchange: 'ctrader'
      });
      symbolInfo = {};
    }

    // Extract precision from symbol info
    // cTrader uses 'digits' for price precision and 'volume' or 'lotSize' for quantity precision
    const pricePrecision = symbolInfo.digits !== undefined ? symbolInfo.digits : 5;
    const quantityPrecision = symbolInfo.volumePrecision !== undefined ? symbolInfo.volumePrecision : 2;
    const minOrderVolume = symbolInfo.minVolume || symbolInfo.minLotSize || 0;
    const maxOrderVolume = symbolInfo.maxVolume || symbolInfo.maxLotSize || undefined;
    const volumeStep = symbolInfo.volumeStep || symbolInfo.lotSize || Math.pow(10, -quantityPrecision);

    logger.debug('Precision and limits extracted', {
      tradeId: trade.id,
      symbol,
      pricePrecision,
      quantityPrecision,
      minOrderVolume,
      maxOrderVolume,
      volumeStep,
      exchange: 'ctrader'
    });

    // Round TP prices (Gap #3)
    const roundedTPPrices = takeProfits.map(tpPrice => 
      roundPrice(tpPrice, pricePrecision, undefined)
    );

    logger.debug('TP prices rounded', {
      tradeId: trade.id,
      symbol,
      originalTPs: takeProfits,
      roundedTPs: roundedTPPrices,
      exchange: 'ctrader'
    });

    // Distribute quantity across TPs (Gap #2)
    const tpQuantities = distributeQuantityAcrossTPs(
      positionVolume,
      takeProfits.length,
      quantityPrecision
    );

    logger.debug('TP quantities distributed', {
      tradeId: trade.id,
      symbol,
      positionVolume,
      numTPs: takeProfits.length,
      tpQuantities,
      exchange: 'ctrader'
    });

    // Validate and redistribute TP quantities (Gap #2)
    const validTPOrders = validateAndRedistributeTPQuantities(
      tpQuantities,
      roundedTPPrices,
      positionVolume,
      volumeStep,
      minOrderVolume,
      maxOrderVolume,
      quantityPrecision
    );
    
    logger.info('TP orders validated and redistributed', {
      tradeId: trade.id,
      symbol,
      originalTPCount: takeProfits.length,
      validTPCount: validTPOrders.length,
      skippedTPCount: takeProfits.length - validTPOrders.length,
      validTPOrders: validTPOrders.map(tp => ({
        index: tp.index,
        price: tp.price,
        quantity: tp.quantity
      })),
      exchange: 'ctrader'
    });

    // Log that last TP uses remaining quantity
    if (validTPOrders.length > 0) {
      const lastTP = validTPOrders[validTPOrders.length - 1];
      const allocatedQty = validTPOrders.slice(0, -1).reduce((sum, tp) => sum + tp.quantity, 0);
      const remainingQty = positionVolume - allocatedQty;
      logger.info('Last TP order uses remaining quantity to close entire position', {
        tradeId: trade.id,
        symbol,
        lastTPIndex: lastTP.index,
        lastTPQuantity: lastTP.quantity,
        remainingQuantity: remainingQty,
        totalPositionQty: positionVolume,
        allocatedQty,
        exchange: 'ctrader',
        note: 'cTrader will automatically adjust last TP quantity to match available position size when executing'
      });
    }

    // Log redistribution if fewer TPs than expected
    if (validTPOrders.length < takeProfits.length) {
      const skippedCount = takeProfits.length - validTPOrders.length;
      const skippedIndices: number[] = [];
      for (let i = 0; i < takeProfits.length; i++) {
        if (!validTPOrders.find(tp => tp.index === i + 1)) {
          skippedIndices.push(i + 1);
        }
      }
      logger.warn('Some TP orders were skipped due to quantity validation', {
        tradeId: trade.id,
        symbol,
        skippedCount,
        skippedIndices,
        reason: 'Quantity too small after rounding or below minimum order volume',
        exchange: 'ctrader'
      });
    }

    // Place TP orders via modifyPosition for each TP
    // Note: cTrader API supports setting TP on position, but for multiple TPs we may need limit orders
    for (const tpOrder of validTPOrders) {
      const tpPrice = tpOrder.price;
      const tpVolume = tpOrder.quantity;
      
      try {
        // For cTrader, we can set TP via modifyPosition
        // If multiple TPs, we might need to place limit orders instead
        // For now, set the first TP via modifyPosition, others as limit orders
        if (tpOrder.index === 1 && validTPOrders.length === 1) {
          // Single TP - use modifyPosition
          await ctraderClient.modifyPosition({
            positionId: positionId?.toString() || '',
            takeProfit: tpPrice
          });
          
          logger.info('cTrader take profit set via modifyPosition', {
            tradeId: trade.id,
            tpIndex: tpOrder.index,
            tpPrice,
            positionId: positionId?.toString(),
            exchange: 'ctrader'
          });
        } else {
          // Multiple TPs - place limit orders
          const orderId = await ctraderClient.placeLimitOrder({
            symbol,
            volume: tpVolume,
            tradeSide: tpSide,
            price: tpPrice
          });
          
          logger.info('cTrader take profit limit order placed', {
            tradeId: trade.id,
            tpIndex: tpOrder.index,
            tpPrice,
            tpVolume,
            tpSide,
            orderId,
            positionId: positionId?.toString(),
            exchange: 'ctrader'
          });
          
          // Store TP order in database
          await db.insertOrder({
            trade_id: trade.id,
            order_type: 'take_profit',
            order_id: orderId,
            price: tpPrice,
            quantity: tpVolume,
            tp_index: tpOrder.index,
            status: 'pending'
          });
        }
      } catch (error) {
        logger.error('Error placing cTrader take profit order', {
          tradeId: trade.id,
          tpIndex: tpOrder.index,
          tpPrice,
          tpVolume,
          error: error instanceof Error ? error.message : String(error),
          exchange: 'ctrader'
        });
      }
    }
  } catch (error) {
    logger.error('Error placing cTrader take profit orders', {
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error),
      exchange: 'ctrader'
    });
  }
};

/**
 * Place breakeven limit order for cTrader
 * Implements proper breakeven limit order placement (Gap #1)
 */
const placeBreakevenLimitOrder = async (
  trade: Trade,
  ctraderClient: CTraderClient,
  db: DatabaseManager,
  isLong: boolean
): Promise<void> => {
  try {
    const symbol = normalizeCTraderSymbol(trade.trading_pair);
    
    logger.debug('Getting position info for breakeven limit order', {
      tradeId: trade.id,
      symbol,
      positionId: trade.position_id,
      exchange: 'ctrader'
    });
    
    // Get position info with retry logic (Gap #4)
    let position: any = null;
    let positionResponse: any[] = [];
    const maxRetries = 3;
    const retryDelay = 1000;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        positionResponse = await ctraderClient.getOpenPositions();
        
        logger.debug('Position API response received for breakeven order', {
          tradeId: trade.id,
          symbol,
          positionsCount: positionResponse.length,
          attempt,
          maxRetries,
          exchange: 'ctrader'
        });

        // Find the position
        if (trade.position_id) {
          position = positionResponse.find((p: any) => {
            const positionId = p.positionId || p.id;
            const positionSymbol = p.symbolName || p.symbol;
            return positionSymbol === symbol && positionId?.toString() === trade.position_id;
          });
        }
        
        if (!position) {
          const positions = positionResponse.filter((p: any) => {
            const positionSymbol = p.symbolName || p.symbol;
            const volume = Math.abs(p.volume || p.quantity || 0);
            return positionSymbol === symbol && volume > 0;
          });
          if (positions.length > 0) {
            position = positions[0];
          }
        }

        if (position) {
          logger.debug('Position found for breakeven order', {
            tradeId: trade.id,
            symbol,
            positionId: (position.positionId || position.id)?.toString(),
            volume: position.volume || position.quantity,
            attempt,
            exchange: 'ctrader'
          });
          break; // Found position, exit retry loop
        }
      } catch (error) {
        logger.debug('Error getting positions for breakeven order, retrying', {
          tradeId: trade.id,
          symbol,
          attempt,
          maxRetries,
          error: error instanceof Error ? error.message : String(error),
          exchange: 'ctrader'
        });
      }
      
      // If this wasn't the last attempt, wait before retrying
      if (attempt < maxRetries && !position) {
        await sleep(retryDelay);
      }
    }

    if (!position) {
      logger.warn('No cTrader position found for breakeven limit order', {
        tradeId: trade.id,
        symbol,
        positionId: trade.position_id,
        attempts: maxRetries,
        exchange: 'ctrader'
      });
      return;
    }

    const positionVolume = Math.abs(position.volume || position.quantity || 0);
    if (positionVolume === 0) {
      logger.warn('Position size is zero, cannot place breakeven limit order', {
        tradeId: trade.id,
        symbol,
        exchange: 'ctrader'
      });
      return;
    }

    // Get symbol info for precision (Gap #3)
    let symbolInfo: any;
    try {
      symbolInfo = await ctraderClient.getSymbolInfo(symbol);
      logger.debug('Symbol info retrieved for breakeven order', {
        tradeId: trade.id,
        symbol,
        symbolInfo: {
          symbolId: symbolInfo.symbolId,
          digits: symbolInfo.digits,
          volumePrecision: symbolInfo.volumePrecision
        },
        exchange: 'ctrader'
      });
    } catch (error) {
      logger.warn('Failed to get symbol info for breakeven order, using defaults', {
        tradeId: trade.id,
        symbol,
        error: error instanceof Error ? error.message : String(error),
        exchange: 'ctrader'
      });
      symbolInfo = {};
    }

    // Extract precision from symbol info
    const pricePrecision = symbolInfo.digits !== undefined ? symbolInfo.digits : 5;
    const quantityPrecision = symbolInfo.volumePrecision !== undefined ? symbolInfo.volumePrecision : 2;

    // Round entry price (Gap #3)
    const entryPrice = roundPrice(trade.entry_price, pricePrecision, undefined);
    
    // Breakeven order side is opposite of position side (to close the position)
    // For Long (Buy) position, breakeven order is Sell
    // For Short (Sell) position, breakeven order is Buy
    const breakevenSide = isLong ? 'SELL' : 'BUY';

    // Round quantity (Gap #3)
    const quantity = roundQuantity(positionVolume, quantityPrecision, false);

    logger.info('Placing breakeven limit order', {
      tradeId: trade.id,
      symbol,
      entryPrice,
      quantity,
      side: breakevenSide,
      positionVolume,
      exchange: 'ctrader'
    });

    const orderId = await ctraderClient.placeLimitOrder({
      symbol,
      volume: quantity,
      tradeSide: breakevenSide,
      price: entryPrice
    });

    if (orderId) {
      // Store breakeven limit order in database
      await db.insertOrder({
        trade_id: trade.id,
        order_type: 'breakeven_limit',
        order_id: orderId,
        price: entryPrice,
        quantity: positionVolume,
        status: 'pending'
      });

      logger.info('Breakeven limit order placed successfully', {
        tradeId: trade.id,
        symbol,
        orderId,
        entryPrice,
        quantity,
        exchange: 'ctrader'
      });
    } else {
      logger.error('Failed to place breakeven limit order - no order ID returned', {
        tradeId: trade.id,
        symbol,
        entryPrice,
        quantity,
        exchange: 'ctrader'
      });
    }
  } catch (error) {
    logger.error('Failed to place breakeven limit order', {
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error),
      exchange: 'ctrader'
    });
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
  priceProvider: HistoricalPriceProvider | undefined,
  breakevenAfterTPs: number,
  useLimitOrderForBreakeven: boolean = true
): Promise<void> => {
  try {
    // Log trade status at start for debugging
    logger.debug('Monitoring cTrader trade', {
      tradeId: trade.id,
      status: trade.status,
      symbol: trade.trading_pair,
      orderId: trade.order_id,
      positionId: trade.position_id,
      entryFilledAt: trade.entry_filled_at,
      exchange: 'ctrader'
    });

    // Check if trade has expired
    if (await checkTradeExpired(trade, isSimulation, priceProvider)) {
      logger.info('cTrader trade expired - cancelling order', {
        tradeId: trade.id,
        channel: trade.channel,
        expiresAt: trade.expires_at,
        exchange: 'ctrader'
      });
      await cancelOrder(trade, ctraderClient);
      await cancelTrade(trade, db);
      return;
    }

    // For pending trades, check if position already exists
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
          
          logger.info('cTrader entry order filled', {
            tradeId: trade.id,
            tradingPair: trade.trading_pair,
            entryPrice: trade.entry_price,
            positionId: positionId?.toString(),
            channel: trade.channel,
            exchange: 'ctrader',
            note: 'Detected via position check - entry was filled but status not updated'
          });
          
          await db.updateTrade(trade.id, {
            status: 'active',
            entry_filled_at: fillTime,
            position_id: positionId?.toString()
          });
          trade.status = 'active';
          trade.entry_filled_at = fillTime;
          trade.position_id = positionId?.toString();

          await updateEntryOrderToFilled(trade, db, fillTime);
          await placeTakeProfitOrders(trade, ctraderClient, db);
        }
      } catch (error) {
        logger.debug('Error checking cTrader positions for pending trade', {
          tradeId: trade.id,
          exchange: 'ctrader',
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // Get current price
    const currentPrice = await getCurrentPrice(trade.trading_pair, ctraderClient, isSimulation, priceProvider);
    if (!currentPrice) {
      logger.warn('Could not get current price for cTrader trade', {
        tradeId: trade.id,
        tradingPair: trade.trading_pair,
        exchange: 'ctrader'
      });
      return;
    }

    // Check if entry price was hit before stop loss or take profit (for pending trades)
    if (trade.status === 'pending') {
      const isLong = getIsLong(trade);
      
      if (checkSLHitBeforeEntry(trade, currentPrice)) {
        logger.info('Price hit SL before entry - cancelling cTrader order', {
          tradeId: trade.id,
          currentPrice,
          stopLoss: trade.stop_loss,
          entryPrice: trade.entry_price,
          exchange: 'ctrader'
        });
        await cancelOrder(trade, ctraderClient);
        await cancelTrade(trade, db);
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
        logger.info('cTrader entry order filled', {
          tradeId: trade.id,
          tradingPair: trade.trading_pair,
          entryPrice: trade.entry_price,
          positionId: entryResult.positionId,
          channel: trade.channel,
          exchange: 'ctrader'
        });
        
        const fillTime = dayjs().toISOString();
        await db.updateTrade(trade.id, {
          status: 'active',
          entry_filled_at: fillTime,
          position_id: entryResult.positionId
        });
        trade.status = 'active';
        trade.entry_filled_at = fillTime;
        trade.position_id = entryResult.positionId;

        await updateEntryOrderToFilled(trade, db, fillTime);
        await placeTakeProfitOrders(trade, ctraderClient, db);
      }
    }

    // Monitor active trades
    if (trade.status === 'active' || trade.status === 'filled') {
      // Check SL/TP orders for fills
      const orders = await db.getOrdersByTradeId(trade.id);
      const pendingOrders = orders.filter(o => o.status === 'pending');

      for (const order of pendingOrders) {
        const orderResult = await checkOrderFilled(order, trade, ctraderClient, isSimulation, priceProvider);
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
          
          if (order.order_type === 'breakeven_limit') {
            await updateTradeOnBreakevenFilled(trade, db, orderResult.filledPrice || trade.entry_price);
          }
        }
      }
      
      // Check if position is closed
      const positionResult = await checkPositionClosed(trade, ctraderClient, isSimulation, priceProvider);
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
      
      const isLong = getIsLong(trade);
      const filledTPCount = await countFilledTakeProfits(trade, db);

      // Check if we've hit the required number of TPs to move to breakeven
      if (filledTPCount >= breakevenAfterTPs && !trade.stop_loss_breakeven) {
        const existingBreakevenOrder = await getBreakevenLimitOrder(trade, db);

        if (useLimitOrderForBreakeven) {
          // Create limit order at entry price instead of moving stop loss (Gap #1)
          if (!existingBreakevenOrder && ctraderClient) {
            logger.info('Required take profits hit - creating cTrader breakeven limit order at entry price', {
              tradeId: trade.id,
              filledTPCount,
              breakevenAfterTPs,
              entryPrice: trade.entry_price,
              exchange: 'ctrader'
            });
            
            await placeBreakevenLimitOrder(trade, ctraderClient, db, isLong);
            
            await db.updateTrade(trade.id, {
              stop_loss_breakeven: true
            });
          } else if (existingBreakevenOrder) {
            logger.debug('cTrader breakeven limit order already exists', {
              tradeId: trade.id,
              orderId: existingBreakevenOrder.order_id,
              exchange: 'ctrader'
            });
            await db.updateTrade(trade.id, {
              stop_loss_breakeven: true
            });
          }
        } else {
          // Move stop loss to entry price
          logger.info('Required take profits hit - moving cTrader stop loss to breakeven', {
            tradeId: trade.id,
            filledTPCount,
            breakevenAfterTPs,
            entryPrice: trade.entry_price,
            exchange: 'ctrader'
          });
          
          if (trade.position_id && ctraderClient) {
            await ctraderClient.modifyPosition({
              positionId: trade.position_id,
              stopLoss: trade.entry_price
            });
          }
          
          await db.updateTrade(trade.id, {
            stop_loss: trade.entry_price,
            stop_loss_breakeven: true
          });
        }
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
  const breakevenAfterTPs = monitorConfig.breakevenAfterTPs ?? 1;
  const useLimitOrderForBreakeven = monitorConfig.useLimitOrderForBreakeven ?? true;

  const monitorLoop = async (): Promise<void> => {
    const isMaxSpeed = speedMultiplier !== undefined && (speedMultiplier === 0 || speedMultiplier === Infinity || !isFinite(speedMultiplier));
    
    while (running) {
      try {
        const trades = (await db.getActiveTrades()).filter(t => t.channel === channel && t.exchange === 'ctrader');
        
        for (const trade of trades) {
          const accountCTraderClient = getCTraderClient
            ? await getCTraderClient(trade.account_name)
            : ctraderClient;
          await monitorTrade(
            channel,
            entryTimeoutMinutes,
            trade,
            db,
            accountCTraderClient,
            isSimulation,
            priceProvider,
            breakevenAfterTPs,
            useLimitOrderForBreakeven
          );
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

