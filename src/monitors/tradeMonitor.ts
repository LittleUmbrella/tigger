import { MonitorConfig } from '../types/config.js';
import { DatabaseManager, Trade, Order } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';
import { RestClientV5 } from 'bybit-api';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { getSymbolInfo } from '../initiators/symbolValidator.js';
import { roundPrice, getDecimalPrecision } from '../utils/positionSizing.js';
import { getBybitField } from '../utils/bybitFieldHelper.js';

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
  bybitClient: RestClientV5 | undefined,
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
      // Normalize symbol similar to validateBybitSymbol
      let normalizedSymbol = tradingPair.replace('/', '').toUpperCase();
      
      // Ensure symbol ends with USDT or USDC
      const baseSymbol = normalizedSymbol.replace(/USDT$|USDC$/, '');
      const quoteCurrency = normalizedSymbol.endsWith('USDC') ? 'USDC' : 'USDT';
      
      // Try USDT first (most common), then USDC as fallback
      const symbolsToTry = quoteCurrency === 'USDC' 
        ? [`${baseSymbol}USDC`, `${baseSymbol}USDT`]
        : [`${baseSymbol}USDT`, `${baseSymbol}USDC`];
      
      for (const symbolToCheck of symbolsToTry) {
        // Try linear category first (futures)
        try {
          const linearTicker = await bybitClient.getTickers({ category: 'linear', symbol: symbolToCheck });
          if (linearTicker.retCode === 0 && linearTicker.result && linearTicker.result.list && linearTicker.result.list.length > 0 && linearTicker.result.list[0]?.lastPrice) {
            return parseFloat(linearTicker.result.list[0].lastPrice);
          }
        } catch (error) {
          // Continue to spot
        }
        
        // Try spot category
        try {
          const spotTicker = await bybitClient.getTickers({ category: 'spot', symbol: symbolToCheck });
          if (spotTicker.retCode === 0 && spotTicker.result && spotTicker.result.list && spotTicker.result.list.length > 0 && spotTicker.result.list[0]?.lastPrice) {
            return parseFloat(spotTicker.result.list[0].lastPrice);
          }
        } catch (error) {
          // Continue to next symbol
          continue;
        }
      }
      
      // If we get here, no price was found
      logger.warn('Could not get current price from Bybit', {
        tradingPair,
        normalizedSymbol,
        symbolsTried: symbolsToTry
      });
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
  bybitClient: RestClientV5 | undefined,
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
      const orderInfo = await bybitClient.getActiveOrders({
        category: 'linear',
        symbol: symbol,
        orderId: trade.order_id
      });
      
      if (orderInfo.retCode === 0 && orderInfo.result && orderInfo.result.list) {
            const order = orderInfo.result.list.find((o: any) => 
              getBybitField<string>(o, 'orderId', 'order_id') === trade.order_id
            );
        if (!order) {
          // Order not found in active orders, likely filled
          // Get position ID from open positions
          const positions = await bybitClient.getPositionInfo({ category: 'linear', symbol });
        const position = positions.retCode === 0 && positions.result && positions.result.list 
          ? positions.result.list.find((p: any) => 
          p.symbol === symbol && parseFloat(getBybitField<string>(p, 'size') || '0') !== 0
        ) : null;
            if (position) {
              const positionIdx = getBybitField<string | number>(position, 'positionIdx', 'position_idx');
              return { filled: true, positionId: positionIdx?.toString() };
            }
          return { filled: false };
        }
        const orderStatus = getBybitField<string>(order, 'orderStatus', 'order_status');
        return { filled: orderStatus === 'Filled' };
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
  bybitClient: RestClientV5 | undefined,
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
      const positions = await bybitClient.getPositionInfo({ category: 'linear', symbol });
      
      if (positions.retCode === 0 && positions.result && positions.result.list) {
        const position = positions.result.list.find((p: any) => {
          const positionIdx = getBybitField<string | number>(p, 'positionIdx', 'position_idx');
          return p.symbol === symbol && positionIdx?.toString() === trade.position_id;
        });
        
        // If position doesn't exist or size is 0, it's closed
        if (!position || parseFloat(getBybitField<string>(position, 'size') || '0') === 0) {
          // Get closed PNL from position history
          const positionHistory = await bybitClient.getClosedPnL({
            category: 'linear',
            symbol: symbol,
            limit: 10
          });
          
          if (positionHistory.retCode === 0 && positionHistory.result && positionHistory.result.list) {
            // Find the most recent closed position for this symbol
            const closedPosition = positionHistory.result.list.find((p: any) => 
              p.symbol === symbol
            );
            
            if (closedPosition) {
              const exitPrice = parseFloat(getBybitField<string>(closedPosition, 'avgExitPrice', 'avg_exit_price') || '0');
              const pnl = parseFloat(getBybitField<string>(closedPosition, 'closedPnl', 'closed_pnl') || '0');
              return { closed: true, exitPrice, pnl };
            }
          }
          
          // Fallback: try to get from execution/trade history
          const tradeHistory = await bybitClient.getExecutionList({
            category: 'linear',
            symbol: symbol,
            limit: 50
          });
          
          if (tradeHistory.retCode === 0 && tradeHistory.result && tradeHistory.result.list) {
            // Find trades that closed the position (opposite side trades)
            // For a long position, we look for sell trades
            // For a short position, we look for buy trades
            const closingTrades = tradeHistory.result.list.filter((t: any) => {
              const tradeTime = parseFloat(getBybitField<string>(t, 'execTime', 'exec_time') || '0');
              const entryTime = trade.entry_filled_at ? new Date(trade.entry_filled_at).getTime() : 0;
              return tradeTime > entryTime;
            });
            
            if (closingTrades.length > 0) {
              // Get average exit price from closing trades
              const totalQty = closingTrades.reduce((sum: number, t: any) => 
                sum + parseFloat(getBybitField<string>(t, 'execQty', 'exec_qty') || '0'), 0);
              const weightedPrice = closingTrades.reduce((sum: number, t: any) => {
                const qty = parseFloat(getBybitField<string>(t, 'execQty', 'exec_qty') || '0');
                const price = parseFloat(getBybitField<string>(t, 'execPrice', 'exec_price') || '0');
                return sum + (price * qty);
              }, 0);
              const firstExecPrice = getBybitField<string>(closingTrades[0], 'execPrice', 'exec_price');
              const exitPrice = totalQty > 0 ? weightedPrice / totalQty : parseFloat(firstExecPrice || '0');
              
              // Try to get actual PNL from position history one more time with more parameters
              const detailedHistory = await bybitClient.getClosedPnL({
                category: 'linear',
                symbol: symbol,
                limit: 20
              });
              
              if (detailedHistory.retCode === 0 && detailedHistory.result && detailedHistory.result.list) {
            const recentClosed = detailedHistory.result.list.find((p: any) => 
              p.symbol === symbol && parseFloat(getBybitField<string>(p, 'closedPnl', 'closed_pnl') || '0') !== 0
            );
                if (recentClosed) {
                  return { 
                    closed: true, 
                    exitPrice: parseFloat(getBybitField<string>(recentClosed, 'avgExitPrice', 'avg_exit_price') || exitPrice.toString()),
                    pnl: parseFloat(getBybitField<string>(recentClosed, 'closedPnl', 'closed_pnl') || '0')
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
  bybitClient?: RestClientV5
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
  bybitClient?: RestClientV5
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

/**
 * Distribute quantity evenly across take profit orders
 */
const distributeQuantityAcrossTPs = (
  totalQty: number,
  numTPs: number,
  decimalPrecision: number
): number[] => {
  if (numTPs === 0) return [];
  if (numTPs === 1) return [Math.round(totalQty * Math.pow(10, decimalPrecision)) / Math.pow(10, decimalPrecision)];
  
  const baseQty = totalQty / numTPs;
  const roundedQuantities: number[] = [];
  
  for (let i = 0; i < numTPs - 1; i++) {
    roundedQuantities.push(Math.floor(baseQty * Math.pow(10, decimalPrecision)) / Math.pow(10, decimalPrecision));
  }
  
  const allocatedQty = roundedQuantities.reduce((sum, qty) => sum + qty, 0);
  const remainingQty = totalQty - allocatedQty;
  roundedQuantities.push(Math.ceil(remainingQty * Math.pow(10, decimalPrecision)) / Math.pow(10, decimalPrecision));
  
  return roundedQuantities;
};

/**
 * Format quantity string with proper precision (remove trailing zeros)
 */
const formatQuantity = (quantity: number, precision: number): string => {
  const formatted = quantity.toFixed(precision);
  return formatted.replace(/\.?0+$/, '');
};

/**
 * Place take profit orders after entry fills
 */
const placeTakeProfitOrders = async (
  trade: Trade,
  bybitClient: RestClientV5 | undefined,
  db: DatabaseManager
): Promise<void> => {
  try {
    if (!bybitClient || trade.exchange !== 'bybit' || !trade.entry_filled_at) {
      return;
    }

    // Check if TP orders already exist
    const existingOrders = await db.getOrdersByTradeId(trade.id);
    const existingTPOrders = existingOrders.filter(o => o.order_type === 'take_profit');
    if (existingTPOrders.length > 0) {
      logger.debug('Take profit orders already exist, skipping placement', {
        tradeId: trade.id,
        existingTPCount: existingTPOrders.length
      });
      return;
    }

    const takeProfits = JSON.parse(trade.take_profits) as number[];
    if (!takeProfits || takeProfits.length === 0) {
      return;
    }

    const symbol = trade.trading_pair.replace('/', '');
    
    // Get position info to determine side and quantity
    const positionResponse = await bybitClient.getPositionInfo({
      category: 'linear',
      symbol: symbol
    });

    if (positionResponse.retCode !== 0 || !positionResponse.result || !positionResponse.result.list) {
      logger.warn('Could not get position info for TP order placement', {
        tradeId: trade.id,
        symbol
      });
      return;
    }

    const positions = positionResponse.result.list.filter((p: any) => {
      const size = parseFloat(getBybitField<string>(p, 'size') || '0');
      return size !== 0 && p.symbol === symbol;
    });

    if (positions.length === 0) {
      logger.warn('No position found for TP order placement', {
        tradeId: trade.id,
        symbol
      });
      return;
    }

    const position = positions[0];
    const positionSize = Math.abs(parseFloat(getBybitField<string>(position, 'size') || '0'));
    const positionSizeStr = getBybitField<string>(position, 'size') || '0';
    const positionSide = parseFloat(positionSizeStr) > 0 ? 'Buy' : 'Sell';
    const tpSide = positionSide === 'Buy' ? 'Sell' : 'Buy';

    // Get symbol info for precision and qtyStep
    const symbolInfo = await getSymbolInfo(bybitClient, symbol);
    let decimalPrecision = 2;
    let pricePrecision: number | undefined = undefined;
    let qtyStep: number | undefined = undefined;

    if (symbolInfo) {
      decimalPrecision = symbolInfo.qtyPrecision ?? 2;
      pricePrecision = symbolInfo.pricePrecision;
      qtyStep = symbolInfo.qtyStep;
    }

    // Round TP prices
    const roundedTPPrices = takeProfits.map(tpPrice => 
      roundPrice(tpPrice, pricePrecision, undefined)
    );

    // Distribute quantity across TPs
    const tpQuantities = distributeQuantityAcrossTPs(
      positionSize,
      takeProfits.length,
      decimalPrecision
    );

    // Round quantities to qtyStep if specified
    const effectiveQtyStep = qtyStep !== undefined && qtyStep > 0 ? qtyStep : Math.pow(10, -decimalPrecision);
    const roundedTPQuantities = tpQuantities.map(qty => {
      if (effectiveQtyStep > 0) {
        return Math.floor(qty / effectiveQtyStep) * effectiveQtyStep;
      }
      return qty;
    });

    // Place TP orders
    const tpOrderIds: Array<{ index: number; orderId: string; price: number; quantity: number }> = [];

    for (let i = 0; i < roundedTPPrices.length; i++) {
      try {
        const tpOrderParams = {
          category: 'linear' as const,
          symbol: symbol,
          side: tpSide as 'Buy' | 'Sell',
          orderType: 'Limit' as const,
          qty: formatQuantity(roundedTPQuantities[i], decimalPrecision),
          price: roundedTPPrices[i].toString(),
          timeInForce: 'GTC' as const,
          reduceOnly: true,
          closeOnTrigger: false,
          positionIdx: 0 as 0 | 1 | 2,
        };

        logger.debug('Placing take profit order from monitor', {
          tradeId: trade.id,
          symbol,
          tpIndex: i + 1,
          tpPrice: roundedTPPrices[i],
          tpQty: roundedTPQuantities[i],
          positionSide,
          tpSide
        });

        const tpOrderResponse = await bybitClient.submitOrder(tpOrderParams);

        const tpOrderId = getBybitField<string>(tpOrderResponse.result, 'orderId', 'order_id');
        if (tpOrderResponse.retCode === 0 && tpOrderResponse.result && tpOrderId) {
          tpOrderIds.push({
            index: i + 1,
            orderId: tpOrderId,
            price: roundedTPPrices[i],
            quantity: roundedTPQuantities[i]
          });

          // Store TP order in database
          await db.insertOrder({
            trade_id: trade.id,
            order_type: 'take_profit',
            order_id: tpOrderId,
            price: roundedTPPrices[i],
            tp_index: i + 1,
            quantity: roundedTPQuantities[i],
            status: 'pending'
          });

          logger.info('Take profit order placed by monitor', {
            tradeId: trade.id,
            tpIndex: i + 1,
            tpPrice: roundedTPPrices[i],
            tpQty: roundedTPQuantities[i],
            tpOrderId
          });
        } else {
          logger.warn('Failed to place take profit order from monitor', {
            tradeId: trade.id,
            tpIndex: i + 1,
            error: JSON.stringify(tpOrderResponse)
          });
        }
      } catch (error) {
        logger.error('Error placing take profit order from monitor', {
          tradeId: trade.id,
          tpIndex: i + 1,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (tpOrderIds.length > 0) {
      logger.info('Take profit orders placed by monitor', {
        tradeId: trade.id,
        symbol,
        numTPs: tpOrderIds.length,
        totalTPs: takeProfits.length
      });
    }
  } catch (error) {
    logger.error('Error placing take profit orders from monitor', {
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

const checkOrderFilled = async (
  order: Order,
  trade: Trade,
  bybitClient: RestClientV5 | undefined,
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
      const openOrders = await bybitClient.getActiveOrders({
        category: 'linear',
        symbol: symbol,
        orderId: order.order_id
      });

      if (openOrders.retCode === 0 && openOrders.result && openOrders.result.list) {
        const foundOrder = openOrders.result.list.find((o: any) => 
          getBybitField<string>(o, 'orderId', 'order_id') === order.order_id
        );
        if (!foundOrder) {
          // Order not in open orders, likely filled
          return { filled: true, filledPrice: order.price };
        } else {
          const orderStatus = getBybitField<string>(foundOrder, 'orderStatus', 'order_status');
          if (orderStatus === 'Filled') {
            const filledPrice = parseFloat(
              getBybitField<string>(foundOrder, 'avgPrice', 'avg_price') || 
              getBybitField<string>(foundOrder, 'price') || 
              '0'
            );
            return { filled: true, filledPrice };
          }
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
  bybitClient: RestClientV5 | undefined,
  isSimulation: boolean,
  priceProvider: HistoricalPriceProvider | undefined,
  breakevenAfterTPs: number
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
        logger.info('Entry order filled', { 
          tradeId: trade.id,
          tradingPair: trade.trading_pair,
          entryPrice: trade.entry_price,
          positionId: entryResult.positionId,
          channel: trade.channel
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

        // Update entry order to filled status
        const orders = await db.getOrdersByTradeId(trade.id);
        const entryOrder = orders.find(o => o.order_type === 'entry');
        if (entryOrder) {
          await db.updateOrder(entryOrder.id, {
            status: 'filled',
            filled_at: fillTime,
            filled_price: trade.entry_price
          });
          logger.debug('Entry order updated to filled', {
            tradeId: trade.id,
            orderId: entryOrder.id,
            fillPrice: trade.entry_price
          });
        } else {
          logger.warn('Entry order not found when filling entry', {
            tradeId: trade.id
          });
        }

        // Place take profit orders now that entry has filled
        await placeTakeProfitOrders(trade, bybitClient, db);
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
          if (order.order_type === 'take_profit') {
            logger.info('Take profit order filled', {
              tradeId: trade.id,
              tradingPair: trade.trading_pair,
              orderId: order.id,
              tpIndex: order.tp_index,
              tpPrice: order.price,
              filledPrice: orderResult.filledPrice,
              channel: trade.channel
            });
          } else if (order.order_type === 'stop_loss') {
            logger.info('Stop loss order filled', {
              tradeId: trade.id,
              tradingPair: trade.trading_pair,
              orderId: order.id,
              slPrice: order.price,
              filledPrice: orderResult.filledPrice,
              channel: trade.channel
            });
          } else {
            logger.info('Order filled', {
              tradeId: trade.id,
              orderId: order.id,
              orderType: order.order_type,
              filledPrice: orderResult.filledPrice
            });
          }

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
      const isLong = currentPrice > trade.entry_price;

      // Count how many take profits have been filled
      const tradeOrders = await db.getOrdersByTradeId(trade.id);
      const filledTPCount = tradeOrders.filter(
        o => o.order_type === 'take_profit' && o.status === 'filled'
      ).length;

      // Check if we've hit the required number of TPs to move to breakeven
      if (filledTPCount >= breakevenAfterTPs && !trade.stop_loss_breakeven) {
        logger.info('Required take profits hit - moving stop loss to breakeven', {
          tradeId: trade.id,
          filledTPCount,
          breakevenAfterTPs,
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
  getBybitClient?: (accountName?: string) => RestClientV5 | undefined
): Promise<() => Promise<void>> => {
  logger.info('Starting trade monitor', { type: monitorConfig.type, channel });

  // Legacy support: create a single client if getBybitClient not provided
  let bybitClient: RestClientV5 | undefined;
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
    
    bybitClient = new RestClientV5({ key: apiKey, secret: apiSecret, testnet: monitorConfig.testnet || false });
    logger.info('Bybit monitor client initialized', { 
      channel,
      type: monitorConfig.type,
      testnet: monitorConfig.testnet || false
    });
  }

  let running = true;
  const pollInterval = monitorConfig.pollInterval || 10000;
  const entryTimeoutDays = monitorConfig.entryTimeoutDays || 2;
  const breakevenAfterTPs = monitorConfig.breakevenAfterTPs ?? 1; // Default to 1 for backward compatibility

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
          await monitorTrade(channel, monitorConfig.type, entryTimeoutDays, trade, db, accountClient, isSimulation, priceProvider, breakevenAfterTPs);
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
