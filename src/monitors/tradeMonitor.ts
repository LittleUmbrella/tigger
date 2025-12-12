import { MonitorConfig } from '../types/config.js';
import { DatabaseManager, Trade, Order } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';
// @ts-ignore - bybit-api types may not be complete
import { RESTClient } from 'bybit-api';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';

// This monitor uses Bybit Futures API (category: 'linear' for perpetual futures)

const sleep = (ms: number): Promise<void> => {
  return new Promise(resolve => {
    if (typeof setTimeout !== 'undefined') {
      setTimeout(resolve, ms);
    } else {
      const start = Date.now();
      while (Date.now() - start < ms) {
        // Busy wait fallback
      }
      resolve();
    }
  });
};

const getCurrentPrice = async (
  tradingPair: string,
  exchange: string,
  bybitClient: RESTClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider
): Promise<number | null> => {
  try {
    if (isSimulation && priceProvider) {
      // Use historical price data in simulation mode
      const price = priceProvider.getCurrentPrice(tradingPair);
      if (price === null) {
        logger.warn('No historical price data available', { tradingPair });
      }
      return price;
    } else if (exchange === 'bybit' && bybitClient) {
      const symbol = tradingPair.replace('/', '');
      const ticker = await bybitClient.getTickers({ category: 'linear', symbol });
      if (ticker.retCode === 0 && ticker.result?.list?.[0]?.lastPrice) {
        return parseFloat(ticker.result.list[0].lastPrice);
      }
    }
    return null;
  } catch (error) {
    logger.error('Error getting current price', {
      tradingPair,
      exchange,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
};

const checkEntryFilled = async (
  trade: Trade,
  bybitClient: RESTClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider
): Promise<{ filled: boolean; positionId?: string }> => {
  try {
    if (isSimulation) {
      // In simulation, check if current price has reached entry price
      if (priceProvider) {
        const currentPrice = await priceProvider.getCurrentPrice(trade.trading_pair);
        if (currentPrice !== null) {
          const isLong = currentPrice >= trade.entry_price;
          // Consider filled if price has moved past entry (with small tolerance)
          const tolerance = trade.entry_price * 0.001; // 0.1% tolerance
          const filled = Math.abs(currentPrice - trade.entry_price) <= tolerance || 
                 (isLong && currentPrice > trade.entry_price) ||
                 (!isLong && currentPrice < trade.entry_price);
          if (filled) {
            return { filled: true, positionId: `SIM-${trade.id}` };
          }
        }
      }
      return { filled: false };
    } else if (trade.exchange === 'bybit' && bybitClient && trade.order_id) {
      const symbol = trade.trading_pair.replace('/', '');
      const orderInfo = await bybitClient.getOpenOrders({
        category: 'linear',
        symbol: symbol,
        orderId: trade.order_id
      });
      
      if (orderInfo.retCode === 0) {
            const order = orderInfo.result?.list?.find((o: any) => o.orderId === trade.order_id);
        if (!order) {
          // Check if order was filled
          const filledOrders = await bybitClient.getOrderHistory({
            category: 'linear',
            symbol: symbol,
            orderId: trade.order_id
          });
            const filled = filledOrders.result?.list?.find((o: any) => o.orderId === trade.order_id);
          if (filled?.orderStatus === 'Filled') {
            // Get position ID from open positions
            const positions = await bybitClient.getPositionInfo({
              category: 'linear',
              symbol: symbol
            });
        const position = positions.result?.list?.find((p: any) => 
          p.symbol === symbol && parseFloat(p.size || '0') !== 0
        );
            return { filled: true, positionId: position?.positionIdx?.toString() };
          }
          return { filled: false };
        }
        return { filled: order.orderStatus === 'Filled' };
      }
    }
    return { filled: false };
  } catch (error) {
    logger.error('Error checking entry filled', {
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error)
    });
    return { filled: false };
  }
};

const checkPositionClosed = async (
  trade: Trade,
  bybitClient: RESTClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider
): Promise<{ closed: boolean; exitPrice?: number; pnl?: number }> => {
  try {
    if (isSimulation && priceProvider && trade.entry_filled_at) {
      // In simulation, check if price has hit stop loss or take profit
      const currentPrice = await priceProvider.getCurrentPrice(trade.trading_pair);
      if (currentPrice === null) {
        return { closed: false };
      }

      const takeProfits = JSON.parse(trade.take_profits) as number[];
      const isLong = currentPrice > trade.entry_price;
      
      // Check if stop loss hit
      const stopLossHit = isLong
        ? currentPrice <= trade.stop_loss
        : currentPrice >= trade.stop_loss;
      
      // Check if any take profit hit
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
        // Calculate PNL
        const priceDiff = exitPrice - trade.entry_price;
        const pnl = isLong ? priceDiff : -priceDiff;
        // Adjust for leverage and position size (simplified calculation)
        const positionSize = (trade.entry_price * (trade.risk_percentage / 100)) / Math.abs(priceDiff / trade.entry_price);
        const actualPnl = (pnl / trade.entry_price) * positionSize * trade.leverage;
        
        return {
          closed: true,
          exitPrice,
          pnl: actualPnl
        };
      }
      
      return { closed: false };
    } else if (trade.exchange === 'bybit' && bybitClient && trade.position_id) {
      const symbol = trade.trading_pair.replace('/', '');
      
      // Check current positions
      const positions = await bybitClient.getPositionInfo({
        category: 'linear',
        symbol: symbol
      });
      
      if (positions.retCode === 0 && positions.result?.list) {
        const position = positions.result.list.find((p: any) => 
          p.symbol === symbol && p.positionIdx?.toString() === trade.position_id
        );
        
        // If position doesn't exist or size is 0, it's closed
        if (!position || parseFloat(position.size || '0') === 0) {
          // Get closed PNL from position history
          const positionHistory = await bybitClient.getClosedPnL({
            category: 'linear',
            symbol: symbol,
            limit: 10
          });
          
          if (positionHistory.retCode === 0 && positionHistory.result?.list) {
            // Find the most recent closed position for this symbol
            const closedPosition = positionHistory.result.list.find((p: any) => 
              p.symbol === symbol
            );
            
            if (closedPosition) {
              const exitPrice = parseFloat(closedPosition.avgExitPrice || '0');
              const pnl = parseFloat(closedPosition.closedPnl || '0');
              return { closed: true, exitPrice, pnl };
            }
          }
          
          // Fallback: try to get from execution/trade history
          const tradeHistory = await bybitClient.getExecutionList({
            category: 'linear',
            symbol: symbol,
            limit: 50
          });
          
          if (tradeHistory.retCode === 0 && tradeHistory.result?.list) {
            // Find trades that closed the position (opposite side trades)
            // For a long position, we look for sell trades
            // For a short position, we look for buy trades
            const closingTrades = tradeHistory.result.list.filter((t: any) => {
              const tradeTime = parseFloat(t.execTime || '0');
              const entryTime = trade.entry_filled_at ? new Date(trade.entry_filled_at).getTime() : 0;
              return tradeTime > entryTime;
            });
            
            if (closingTrades.length > 0) {
              // Get average exit price from closing trades
              const totalQty = closingTrades.reduce((sum: number, t: any) => sum + parseFloat(t.execQty || '0'), 0);
              const weightedPrice = closingTrades.reduce((sum: number, t: any) => {
                const qty = parseFloat(t.execQty || '0');
                const price = parseFloat(t.execPrice || '0');
                return sum + (price * qty);
              }, 0);
              const exitPrice = totalQty > 0 ? weightedPrice / totalQty : parseFloat(closingTrades[0].execPrice || '0');
              
              // Try to get actual PNL from position history one more time with more parameters
              const detailedHistory = await bybitClient.getClosedPnL({
                category: 'linear',
                symbol: symbol,
                limit: 20
              });
              
              if (detailedHistory.retCode === 0 && detailedHistory.result?.list) {
            const recentClosed = detailedHistory.result.list.find((p: any) => 
              p.symbol === symbol && parseFloat(p.closedPnl || '0') !== 0
            );
                if (recentClosed) {
                  return { 
                    closed: true, 
                    exitPrice: parseFloat(recentClosed.avgExitPrice || exitPrice.toString()),
                    pnl: parseFloat(recentClosed.closedPnl || '0')
                  };
                }
              }
              
              // If we can't get actual PNL, calculate approximate based on price difference
              // This is a fallback - actual PNL should come from Bybit API
              return { closed: true, exitPrice };
            }
          }
          
          return { closed: true };
        }
      }
    }
    return { closed: false };
  } catch (error) {
    logger.error('Error checking position closed', {
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error)
    });
    return { closed: false };
  }
};

const cancelOrder = async (
  trade: Trade,
  bybitClient?: RESTClient
): Promise<void> => {
  try {
    if (trade.exchange === 'bybit' && bybitClient && trade.order_id) {
      const symbol = trade.trading_pair.replace('/', '');
      await bybitClient.cancelOrder({
        category: 'linear',
        symbol: symbol,
        orderId: trade.order_id
      });
      logger.info('Order cancelled', { tradeId: trade.id, orderId: trade.order_id });
    }
  } catch (error) {
    logger.error('Error cancelling order', {
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

const updateStopLoss = async (
  trade: Trade,
  newStopLoss: number,
  bybitClient?: RESTClient
): Promise<void> => {
  try {
    if (trade.exchange === 'bybit' && bybitClient) {
      const symbol = trade.trading_pair.replace('/', '');
      await bybitClient.setTradingStop({
        category: 'linear',
        symbol: symbol,
        stopLoss: newStopLoss.toString(),
        positionIdx: 0
      });
      logger.info('Stop loss updated', {
        tradeId: trade.id,
        newStopLoss
      });
    }
  } catch (error) {
    logger.error('Error updating stop loss', {
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

const checkOrderFilled = async (
  order: Order,
  trade: Trade,
  bybitClient: RESTClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider
): Promise<{ filled: boolean; filledPrice?: number }> => {
  try {
    if (isSimulation && priceProvider) {
      // In simulation, check if current price has reached order price
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
      } else if (order.order_type === 'take_profit') {
        filled = isLong
          ? currentPrice >= order.price
          : currentPrice <= order.price;
      }

      if (filled) {
        return { filled: true, filledPrice: currentPrice };
      }
      return { filled: false };
    } else if (trade.exchange === 'bybit' && bybitClient && order.order_id) {
      const symbol = trade.trading_pair.replace('/', '');
      
      // Check if order is still open
      const openOrders = await bybitClient.getOpenOrders({
        category: 'linear',
        symbol: symbol,
        orderId: order.order_id
      });

      if (openOrders.retCode === 0) {
        const foundOrder = openOrders.result?.list?.find((o: any) => o.orderId === order.order_id);
        if (!foundOrder) {
          // Order not in open orders, check history
          const orderHistory = await bybitClient.getOrderHistory({
            category: 'linear',
            symbol: symbol,
            orderId: order.order_id
          });

          if (orderHistory.retCode === 0 && orderHistory.result?.list) {
            const filledOrder = orderHistory.result.list.find((o: any) => 
              o.orderId === order.order_id && o.orderStatus === 'Filled'
            );

            if (filledOrder) {
              const filledPrice = parseFloat(filledOrder.avgPrice || filledOrder.price || '0');
              return { filled: true, filledPrice };
            }
          }
        } else if (foundOrder.orderStatus === 'Filled') {
          const filledPrice = parseFloat(foundOrder.avgPrice || foundOrder.price || '0');
          return { filled: true, filledPrice };
        }
      }
    }
    return { filled: false };
  } catch (error) {
    logger.error('Error checking order filled', {
      orderId: order.id,
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error)
    });
    return { filled: false };
  }
};

const monitorTrade = async (
  channel: string,
  monitorType: 'bybit' | 'dex',
  entryTimeoutDays: number,
  trade: Trade,
  db: DatabaseManager,
  bybitClient: RESTClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider
): Promise<void> => {
  try {
    // In simulation mode, use price provider's current time; otherwise use real time
    const currentSimTime = isSimulation && priceProvider 
      ? await priceProvider.getCurrentTime() 
      : dayjs();
    
    // Check if trade has expired (entry not filled in time)
    const expiresAt = dayjs(trade.expires_at);
    if (currentSimTime.isAfter(expiresAt) && trade.status === 'pending') {
      logger.info('Trade expired - cancelling order', {
        tradeId: trade.id,
        channel: trade.channel,
        expiresAt: trade.expires_at
      });
      await cancelOrder(trade, bybitClient);
      await db.updateTrade(trade.id, { status: 'cancelled' });
      return;
    }

    // Get current price from exchange or historical data
    const currentPrice = await getCurrentPrice(trade.trading_pair, trade.exchange, bybitClient, isSimulation, priceProvider);
    if (!currentPrice) {
      logger.warn('Could not get current price', {
        tradeId: trade.id,
        tradingPair: trade.trading_pair
      });
      return;
    }

    // Check if entry price was hit before stop loss or take profit
    if (trade.status === 'pending') {
      const takeProfits = JSON.parse(trade.take_profits) as number[];
      const firstTP = takeProfits[0];
      
      const isLong = currentPrice > trade.entry_price;
      const hitSLBeforeEntry = isLong 
        ? currentPrice <= trade.stop_loss
        : currentPrice >= trade.stop_loss;
      const hitTPBeforeEntry = isLong
        ? currentPrice >= firstTP
        : currentPrice <= firstTP;

      if (hitSLBeforeEntry || hitTPBeforeEntry) {
        logger.info('Price hit SL or TP before entry - cancelling order', {
          tradeId: trade.id,
          currentPrice,
          stopLoss: trade.stop_loss,
          firstTP,
          hitSL: hitSLBeforeEntry,
          hitTP: hitTPBeforeEntry
        });
        await cancelOrder(trade, bybitClient);
        await db.updateTrade(trade.id, { status: 'cancelled' });
        return;
      }

      // Check if entry is filled
      const entryResult = await checkEntryFilled(trade, bybitClient, isSimulation, priceProvider);
      if (entryResult.filled) {
        logger.info('Entry filled', { 
          tradeId: trade.id,
          positionId: entryResult.positionId
        });
        await db.updateTrade(trade.id, {
          status: 'active',
          entry_filled_at: dayjs().toISOString(),
          position_id: entryResult.positionId
        });
        trade.status = 'active';
        trade.entry_filled_at = dayjs().toISOString();
        trade.position_id = entryResult.positionId;
      }
    }

    // Monitor active trades
    if (trade.status === 'active' || trade.status === 'filled') {
      // Check SL/TP orders for fills
      const orders = await db.getOrdersByTradeId(trade.id);
      const pendingOrders = orders.filter(o => o.status === 'pending');

      for (const order of pendingOrders) {
        const orderResult = await checkOrderFilled(order, trade, bybitClient, isSimulation, priceProvider);
        if (orderResult.filled) {
          logger.info('Order filled', {
            tradeId: trade.id,
            orderId: order.id,
            orderType: order.order_type,
            tpIndex: order.tp_index,
            filledPrice: orderResult.filledPrice
          });

          await db.updateOrder(order.id, {
            status: 'filled',
            filled_at: dayjs().toISOString(),
            filled_price: orderResult.filledPrice
          });

          // If stop loss was filled, mark trade as stopped
          if (order.order_type === 'stop_loss') {
            await db.updateTrade(trade.id, {
              status: 'stopped',
              exit_price: orderResult.filledPrice,
              exit_filled_at: dayjs().toISOString()
            });
          }
        }
      }
      // First, check if position is closed
      const positionResult = await checkPositionClosed(trade, bybitClient, isSimulation, priceProvider);
      if (positionResult.closed) {
        logger.info('Position closed', {
          tradeId: trade.id,
          exitPrice: positionResult.exitPrice,
          pnl: positionResult.pnl
        });
        
          // Calculate PNL percentage if we have PNL
        let pnlPercentage: number | undefined;
        if (positionResult.pnl !== undefined && positionResult.exitPrice && trade.entry_price) {
          // PNL percentage based on entry price movement
          const priceDiff = positionResult.exitPrice - trade.entry_price;
          const priceChangePercent = (priceDiff / trade.entry_price) * 100;
          // For futures, PNL percentage is price change * leverage
          // Adjust for long/short direction
          const isLong = positionResult.exitPrice > trade.entry_price;
          pnlPercentage = isLong 
            ? priceChangePercent * trade.leverage
            : -priceChangePercent * trade.leverage;
        }
        
        await db.updateTrade(trade.id, {
          status: 'closed',
          exit_price: positionResult.exitPrice,
          exit_filled_at: dayjs().toISOString(),
          pnl: positionResult.pnl,
          pnl_percentage: pnlPercentage
        });
        return; // Position is closed, no need to check other conditions
      }
      
      const takeProfits = JSON.parse(trade.take_profits) as number[];
      const firstTP = takeProfits[0];
      const isLong = currentPrice > trade.entry_price;

      // Check if first take profit is hit
      const firstTPHit = isLong
        ? currentPrice >= firstTP
        : currentPrice <= firstTP;

      if (firstTPHit && !trade.stop_loss_breakeven) {
        logger.info('First take profit hit - moving stop loss to breakeven', {
          tradeId: trade.id,
          currentPrice,
          firstTP,
          entryPrice: trade.entry_price
        });
        
        await updateStopLoss(trade, trade.entry_price, bybitClient);
        await db.updateTrade(trade.id, {
          stop_loss: trade.entry_price,
          stop_loss_breakeven: true
        });
      }

      // Check if stop loss is hit
      const stopLossHit = isLong
        ? currentPrice <= trade.stop_loss
        : currentPrice >= trade.stop_loss;

      if (stopLossHit) {
        logger.info('Stop loss hit', {
          tradeId: trade.id,
          currentPrice,
          stopLoss: trade.stop_loss
        });
        // When stop loss is hit, position should be closed - check for actual closure
        const stopLossResult = await checkPositionClosed(trade, bybitClient, isSimulation, priceProvider);
        if (stopLossResult.closed) {
          let pnlPercentage: number | undefined;
          if (stopLossResult.pnl !== undefined && stopLossResult.exitPrice && trade.entry_price) {
            const priceDiff = stopLossResult.exitPrice - trade.entry_price;
            const priceChangePercent = (priceDiff / trade.entry_price) * 100;
            const isLong = stopLossResult.exitPrice > trade.entry_price;
            pnlPercentage = isLong 
              ? priceChangePercent * trade.leverage
              : -priceChangePercent * trade.leverage;
          }
          await db.updateTrade(trade.id, {
            status: 'stopped',
            exit_price: stopLossResult.exitPrice,
            exit_filled_at: dayjs().toISOString(),
            pnl: stopLossResult.pnl,
            pnl_percentage: pnlPercentage
          });
        } else {
          await db.updateTrade(trade.id, { status: 'stopped' });
        }
      }
    }
  } catch (error) {
    logger.error('Error monitoring trade', {
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

export const startTradeMonitor = async (
  monitorConfig: MonitorConfig,
  channel: string,
  db: DatabaseManager,
  isSimulation: boolean = false,
  priceProvider?: HistoricalPriceProvider,
  speedMultiplier?: number,
  getBybitClient?: (accountName?: string) => RESTClient | undefined
): Promise<() => Promise<void>> => {
  logger.info('Starting trade monitor', { type: monitorConfig.type, channel });

  // Legacy support: create a single client if getBybitClient not provided
  let bybitClient: RESTClient | undefined;
  if (!getBybitClient && monitorConfig.type === 'bybit') {
    // Read Bybit API credentials from environment variables
    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      logger.error('Bybit API credentials not found in environment variables', {
        channel,
        missing: !apiKey ? 'BYBIT_API_KEY' : 'BYBIT_API_SECRET'
      });
      throw new Error('Bybit API credentials required for bybit monitor');
    }
    
    bybitClient = new RESTClient({
      key: apiKey,
      secret: apiSecret,
      testnet: monitorConfig.testnet || false,
    });
    logger.info('Bybit monitor client initialized', { 
      channel,
      type: monitorConfig.type,
      testnet: monitorConfig.testnet || false
    });
  }

  let running = true;
  const pollInterval = monitorConfig.pollInterval || 10000;
  const entryTimeoutDays = monitorConfig.entryTimeoutDays || 2;

  const monitorLoop = async (): Promise<void> => {
    // Check if we're in maximum speed mode (no delays)
    const isMaxSpeed = speedMultiplier !== undefined && (speedMultiplier === 0 || speedMultiplier === Infinity || !isFinite(speedMultiplier));
    
    while (running) {
      try {
        const trades = (await db.getActiveTrades()).filter(t => t.channel === channel);
        
        for (const trade of trades) {
          // Get account-specific client for this trade
          const accountClient = getBybitClient 
            ? getBybitClient(trade.account_name)
            : bybitClient; // Fallback to legacy client
          await monitorTrade(channel, monitorConfig.type, entryTimeoutDays, trade, db, accountClient, isSimulation, priceProvider);
        }

        // Skip sleep in maximum speed mode
        if (!isMaxSpeed) {
          await sleep(pollInterval);
        } else {
          // In max speed, just yield to event loop but don't delay
          await new Promise(resolve => setImmediate(resolve));
        }
      } catch (error) {
        logger.error('Error in monitor loop', {
          channel,
          error: error instanceof Error ? error.message : String(error)
        });
        if (!isMaxSpeed) {
          await sleep(pollInterval * 2);
        }
      }
    }
  };

  // Start the monitor loop in the background
  monitorLoop().catch(error => {
    logger.error('Fatal error in monitor loop', {
      channel,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  // Return stop function
  return async (): Promise<void> => {
    logger.info('Stopping trade monitor', { type: monitorConfig.type, channel });
    running = false;
  };
};
