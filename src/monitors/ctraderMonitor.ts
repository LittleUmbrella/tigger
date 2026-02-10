import { MonitorConfig } from '../types/config.js';
import { DatabaseManager, Trade, Order } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';
import { CTraderClient } from '../clients/ctraderClient.js';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
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
        orderId: trade.order_id
      });
      
      const positions = await ctraderClient.getOpenPositions();
      logger.debug('cTrader position API response', {
        tradeId: trade.id,
        symbol,
        positionsCount: positions.length
      });
      
      const position = positions.find((p: any) => {
        const positionSymbol = p.symbolName || p.symbol;
        const volume = Math.abs(p.volume || p.quantity || 0);
        return positionSymbol === symbol && volume > 0;
      });
      
      if (position) {
        const positionId = position.positionId || position.id;
        logger.debug('Found open cTrader position for trade, entry likely filled', {
          tradeId: trade.id,
          symbol,
          positionId: positionId?.toString(),
          volume: position.volume || position.quantity,
          orderId: trade.order_id
        });
        return { filled: true, positionId: positionId?.toString() };
      }
      
      // Check open orders if position not found
      if (trade.order_id) {
        try {
          const openOrders = await ctraderClient.getOpenOrders();
          const order = openOrders.find((o: any) => {
            const oId = o.orderId || o.id;
            return oId?.toString() === trade.order_id;
          });
          
          if (!order) {
            // Order not in open orders, might be filled
            logger.debug('cTrader order not found in open orders, checking if filled', {
              tradeId: trade.id,
              symbol,
              orderId: trade.order_id
            });
            // Try to find position again (might have been created)
            const positionsAgain = await ctraderClient.getOpenPositions();
            const positionAgain = positionsAgain.find((p: any) => {
              const positionSymbol = p.symbolName || p.symbol;
              const volume = Math.abs(p.volume || p.quantity || 0);
              return positionSymbol === symbol && volume > 0;
            });
            if (positionAgain) {
              const positionId = positionAgain.positionId || positionAgain.id;
              return { filled: true, positionId: positionId?.toString() };
            }
            // Order filled but position closed already
            return { filled: true };
          } else {
            // Order still open
            const orderStatus = order.orderStatus || order.status;
            logger.debug('cTrader order found in open orders', {
              tradeId: trade.id,
              symbol,
              orderId: trade.order_id,
              orderStatus
            });
            if (orderStatus === 'FILLED' || orderStatus === 'PARTIALLY_FILLED') {
              const positionId = order.positionId || order.positionId;
              return { filled: true, positionId: positionId?.toString() };
            }
          }
        } catch (error) {
          logger.debug('Error checking cTrader orders', {
            tradeId: trade.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
    return { filled: false };
  } catch (error) {
    logger.error('Error checking cTrader entry filled', {
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error)
    });
    return { filled: false };
  }
};

/**
 * Check if position is closed for cTrader
 */
const checkPositionClosed = async (
  trade: Trade,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider
): Promise<{ closed: boolean; exitPrice?: number; pnl?: number }> => {
  try {
    if (isSimulation && priceProvider && trade.entry_filled_at) {
      const currentPrice = await priceProvider.getCurrentPrice(trade.trading_pair);
      if (currentPrice === null) {
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

      if (stopLossHit || tpHit) {
        const exitPrice = currentPrice;
        const priceDiff = exitPrice - trade.entry_price;
        const pnl = isLong ? priceDiff : -priceDiff;
        const positionSize = (trade.entry_price * (trade.risk_percentage / 100)) / Math.abs(priceDiff / trade.entry_price);
        const actualPnl = (pnl / trade.entry_price) * positionSize * trade.leverage;
        
        return {
          closed: true,
          exitPrice,
          pnl: actualPnl
        };
      }
      
      return { closed: false };
    } else if (ctraderClient && trade.position_id) {
      const symbol = normalizeCTraderSymbol(trade.trading_pair);
      
      const positions = await ctraderClient.getOpenPositions();
      const position = positions.find((p: any) => {
        const positionId = p.positionId || p.id;
        const positionSymbol = p.symbolName || p.symbol;
        return positionSymbol === symbol && positionId?.toString() === trade.position_id;
      });
      
      // If position doesn't exist or volume is 0, it's closed
      if (!position || Math.abs(position.volume || position.quantity || 0) === 0) {
        // Try to get closed position info from deal history or similar
        // cTrader API might have a way to get closed positions
        // For now, return closed without exit price/PNL
        logger.info('cTrader position closed', {
          tradeId: trade.id,
          symbol,
          positionId: trade.position_id
        });
        return { closed: true };
      }
    }
    return { closed: false };
  } catch (error) {
    logger.error('Error checking cTrader position closed', {
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error)
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
 */
const checkOrderFilled = async (
  order: Order,
  trade: Trade,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider
): Promise<{ filled: boolean; filledPrice?: number }> => {
  try {
    if (isSimulation && priceProvider) {
      const currentPrice = await priceProvider.getCurrentPrice(trade.trading_pair);
      if (currentPrice === null) {
        return { filled: false };
      }

      const isLong = currentPrice > trade.entry_price;
      let filled = false;

      if (order.order_type === 'stop_loss') {
        filled = isLong
          ? currentPrice <= order.price
          : currentPrice >= order.price;
      } else if (order.order_type === 'take_profit' || order.order_type === 'breakeven_limit') {
        filled = isLong
          ? currentPrice >= order.price
          : currentPrice <= order.price;
      }

      if (filled) {
        return { filled: true, filledPrice: currentPrice };
      }
      return { filled: false };
    } else if (ctraderClient && order.order_id) {
      const openOrders = await ctraderClient.getOpenOrders();
      const foundOrder = openOrders.find((o: any) => {
        const oId = o.orderId || o.id;
        return oId?.toString() === order.order_id;
      });
      
      if (!foundOrder) {
        // Order not in open orders, likely filled
        return { filled: true, filledPrice: order.price };
      } else {
        const orderStatus = foundOrder.orderStatus || foundOrder.status;
        if (orderStatus === 'FILLED') {
          const filledPrice = foundOrder.filledPrice || foundOrder.executionPrice || order.price;
          return { filled: true, filledPrice: typeof filledPrice === 'number' ? filledPrice : parseFloat(filledPrice || order.price.toString()) };
        }
      }
    }
    return { filled: false };
  } catch (error) {
    logger.error('Error checking cTrader order filled', {
      orderId: order.id,
      tradeId: trade.id,
      exchange: 'ctrader',
      error: error instanceof Error ? error.message : String(error)
    });
    return { filled: false };
  }
};

/**
 * Place take profit orders for cTrader
 */
const placeTakeProfitOrders = async (
  trade: Trade,
  ctraderClient: CTraderClient | undefined,
  db: DatabaseManager
): Promise<void> => {
  try {
    if (!trade.entry_filled_at || !ctraderClient) {
      return;
    }

    // Check if TP orders already exist
    const existingOrders = await db.getOrdersByTradeId(trade.id);
    const existingTPOrders = existingOrders.filter(o => o.order_type === 'take_profit');
    if (existingTPOrders.length > 0) {
      logger.debug('Take profit orders already exist for cTrader trade, skipping placement', {
        tradeId: trade.id,
        existingTPCount: existingTPOrders.length
      });
      return;
    }

    const takeProfits = JSON.parse(trade.take_profits) as number[];
    if (!takeProfits || takeProfits.length === 0) {
      return;
    }

    const symbol = normalizeCTraderSymbol(trade.trading_pair);
    
    // Get position info
    const positions = await ctraderClient.getOpenPositions();
    const position = positions.find((p: any) => {
      const positionSymbol = p.symbolName || p.symbol;
      const volume = Math.abs(p.volume || p.quantity || 0);
      return positionSymbol === symbol && volume > 0;
    });

    if (!position) {
      logger.warn('No cTrader position found for TP order placement', {
        tradeId: trade.id,
        symbol
      });
      return;
    }

    const positionId = position.positionId || position.id;
    const positionVolume = Math.abs(position.volume || position.quantity || 0);
    const isLong = (position.tradeSide || position.side) === 'BUY' || positionVolume > 0;
    
    // Distribute volume across TPs
    const tpVolume = positionVolume / takeProfits.length;
    
    // Place TP orders via modifyPosition for each TP
    // Note: cTrader might support multiple TPs differently - this is a simplified approach
    for (let i = 0; i < takeProfits.length; i++) {
      const tpPrice = takeProfits[i];
      
      try {
        // For cTrader, we might need to set TPs differently
        // This is a placeholder - actual implementation depends on cTrader API
        await ctraderClient.modifyPosition({
          positionId: positionId?.toString() || '',
          takeProfit: tpPrice
        });
        
        // Store TP order in database
        const tpOrderId = `CTRADER-TP-${trade.id}-${i + 1}`;
        await db.insertOrder({
          trade_id: trade.id,
          order_type: 'take_profit',
          order_id: tpOrderId,
          price: tpPrice,
          quantity: tpVolume,
          tp_index: i + 1,
          status: 'pending'
        });
        
        logger.info('cTrader take profit order placed', {
          tradeId: trade.id,
          tpIndex: i + 1,
          tpPrice,
          tpVolume,
          positionId: positionId?.toString()
        });
      } catch (error) {
        logger.error('Error placing cTrader take profit order', {
          tradeId: trade.id,
          tpIndex: i + 1,
          tpPrice,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } catch (error) {
    logger.error('Error placing cTrader take profit orders', {
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error)
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
          // Create limit order at entry price instead of moving stop loss
          if (!existingBreakevenOrder && ctraderClient) {
            logger.info('Required take profits hit - creating cTrader breakeven limit order at entry price', {
              tradeId: trade.id,
              filledTPCount,
              breakevenAfterTPs,
              entryPrice: trade.entry_price,
              exchange: 'ctrader'
            });
            
            // TODO: Implement placeBreakevenLimitOrder for cTrader
            // For now, modify position stop loss to entry price
            if (trade.position_id) {
              await ctraderClient.modifyPosition({
                positionId: trade.position_id,
                stopLoss: trade.entry_price
              });
            }
            
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

