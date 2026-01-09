import { MonitorConfig } from '../types/config.js';
import { DatabaseManager, Trade, Order } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';
import { RestClientV5 } from 'bybit-api';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { getSymbolInfo } from '../initiators/symbolValidator.js';
import { roundPrice, getDecimalPrecision, distributeQuantityAcrossTPs, validateAndRedistributeTPQuantities } from '../utils/positionSizing.js';
import { getBybitField } from '../utils/bybitFieldHelper.js';

// This monitor uses Bybit Futures API (category: 'linear' for perpetual futures)

/**
 * Get signal type (long/short) from trade's direction field
 * Falls back to inferring from price relationships if direction is not set (for backward compatibility)
 */
const getIsLong = (trade: Trade): boolean => {
  if (trade.direction) {
    return trade.direction === 'long';
  }
  
  // Fallback: infer from price relationships for old trades without direction
  // For long: TP > entry > SL, for short: SL > entry > TP
  const takeProfits = JSON.parse(trade.take_profits) as number[];
  const firstTP = takeProfits[0];
  const tpHigherThanEntry = firstTP > trade.entry_price;
  const slLowerThanEntry = trade.stop_loss < trade.entry_price;
  return tpHigherThanEntry && slLowerThanEntry;
};

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

/**
 * Normalize trading pair symbol for Bybit API calls
 * Converts "PAXG" or "PAXG/USDT" to "PAXGUSDT"
 */
const normalizeBybitSymbol = (tradingPair: string): string => {
  let normalized = tradingPair.replace('/', '').toUpperCase();
  
  // If symbol doesn't end with USDT or USDC, add USDT
  if (!normalized.endsWith('USDT') && !normalized.endsWith('USDC')) {
    normalized = `${normalized}USDT`;
  }
  
  return normalized;
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
        // Try linear category first (futures) - this matches where trades are placed
        try {
          const linearTicker = await bybitClient.getTickers({ category: 'linear', symbol: symbolToCheck });
          if (linearTicker.retCode === 0 && linearTicker.result && linearTicker.result.list && linearTicker.result.list.length > 0) {
            // Find the ticker that matches our symbol exactly (case-insensitive)
            const matchingTicker = linearTicker.result.list.find((t: any) => 
              t.symbol && t.symbol.toUpperCase() === symbolToCheck.toUpperCase()
            );
            
            if (matchingTicker?.lastPrice) {
              const price = parseFloat(matchingTicker.lastPrice);
              logger.debug('Got current price from Bybit linear', {
                tradingPair,
                symbolToCheck,
                category: 'linear',
                price,
                tickerSymbol: matchingTicker.symbol
              });
              return price;
            }
          }
        } catch (error) {
          logger.debug('Error getting linear ticker, trying spot', {
            symbolToCheck,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        
        // Try spot category as fallback (only if linear doesn't exist)
        try {
          const spotTicker = await bybitClient.getTickers({ category: 'spot', symbol: symbolToCheck });
          if (spotTicker.retCode === 0 && spotTicker.result && spotTicker.result.list && spotTicker.result.list.length > 0) {
            // Find the ticker that matches our symbol exactly (case-insensitive)
            const matchingTicker = spotTicker.result.list.find((t: any) => 
              t.symbol && t.symbol.toUpperCase() === symbolToCheck.toUpperCase()
            );
            
            if (matchingTicker?.lastPrice) {
              const price = parseFloat(matchingTicker.lastPrice);
              logger.debug('Got current price from Bybit spot (fallback)', {
                tradingPair,
                symbolToCheck,
                category: 'spot',
                price,
                tickerSymbol: matchingTicker.symbol,
                note: 'Using spot price as fallback - trade is on linear, price may differ'
              });
              return price;
            }
          }
        } catch (error) {
          // Continue to next symbol
          logger.debug('Error getting spot ticker', {
            symbolToCheck,
            error: error instanceof Error ? error.message : String(error)
          });
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
    } else if (trade.exchange === 'bybit' && bybitClient) {
      const symbol = normalizeBybitSymbol(trade.trading_pair);
      
      // First, check if we already have a position (trade might have been filled but not detected)
      logger.debug('Checking positions for entry fill', {
        tradeId: trade.id,
        symbol,
        orderId: trade.order_id
      });
      
      const positions = await bybitClient.getPositionInfo({ category: 'linear', symbol });
      logger.debug('Position API response', {
        tradeId: trade.id,
        symbol,
        retCode: positions.retCode,
        hasResult: !!positions.result,
        hasList: !!(positions.result && positions.result.list),
        listLength: positions.result?.list?.length || 0
      });
      
      if (positions.retCode === 0 && positions.result && positions.result.list) {
        // Log all positions for debugging
        logger.debug('All positions returned', {
          tradeId: trade.id,
          symbol,
          positions: positions.result.list.map((p: any) => ({
            symbol: p.symbol,
            size: getBybitField<string>(p, 'size'),
            positionIdx: getBybitField<string | number>(p, 'positionIdx', 'position_idx')
          }))
        });
        
        const position = positions.result.list.find((p: any) => {
          const pSize = parseFloat(getBybitField<string>(p, 'size') || '0');
          const symbolMatch = p.symbol === symbol;
          const hasSize = pSize !== 0;
          logger.debug('Checking position', {
            tradeId: trade.id,
            positionSymbol: p.symbol,
            expectedSymbol: symbol,
            symbolMatch,
            size: pSize,
            hasSize
          });
          return symbolMatch && hasSize;
        });
        
        if (position) {
          const positionIdx = getBybitField<string | number>(position, 'positionIdx', 'position_idx');
          logger.debug('Found open position for trade, entry likely filled', {
            tradeId: trade.id,
            symbol,
            positionIdx: positionIdx?.toString(),
            size: getBybitField<string>(position, 'size'),
            orderId: trade.order_id
          });
          return { filled: true, positionId: positionIdx?.toString() };
        } else {
          logger.debug('No matching position found', {
            tradeId: trade.id,
            symbol,
            checkedPositions: positions.result.list.length
          });
        }
      } else {
        logger.debug('Position API returned error or empty result', {
          tradeId: trade.id,
          symbol,
          retCode: positions.retCode,
          retMsg: positions.retMsg
        });
      }
      
      // If we have an order_id, query the order directly by ID first
      // Note: getHistoricOrders is more reliable for filled orders, so we try it first
      if (trade.order_id) {
        // Step 1: Query order history directly by orderId (works for both active and filled orders)
        logger.debug('Querying order directly by orderId (history endpoint)', {
          tradeId: trade.id,
          symbol,
          orderId: trade.order_id
        });
        
        try {
          const orderHistory = await bybitClient.getHistoricOrders({
            category: 'linear',
            symbol: symbol,
            orderId: trade.order_id,
            limit: 10
          });
          
          if (orderHistory.retCode === 0 && orderHistory.result && orderHistory.result.list && orderHistory.result.list.length > 0) {
            const historicalOrder = orderHistory.result.list.find((o: any) => {
              const oId = getBybitField<string>(o, 'orderId', 'order_id');
              return oId === trade.order_id;
            });
            
            if (historicalOrder) {
              const orderStatus = getBybitField<string>(historicalOrder, 'orderStatus', 'order_status');
              logger.debug('Order found in order history by orderId', {
                tradeId: trade.id,
                symbol,
                orderId: trade.order_id,
                orderStatus
              });
              
              if (orderStatus === 'Filled' || orderStatus === 'PartiallyFilled') {
                // Get position ID if available
                const positions = await bybitClient.getPositionInfo({ category: 'linear', symbol });
                if (positions.retCode === 0 && positions.result && positions.result.list) {
                  const position = positions.result.list.find((p: any) => 
                    p.symbol === symbol && parseFloat(getBybitField<string>(p, 'size') || '0') !== 0
                  );
                  if (position) {
                    const positionIdx = getBybitField<string | number>(position, 'positionIdx', 'position_idx');
                    return { filled: true, positionId: positionIdx?.toString() };
                  }
                }
                return { filled: true };
              }
              // Order found but not filled
              return { filled: false };
            }
          }
        } catch (error) {
          logger.debug('Error querying order history by orderId', {
            tradeId: trade.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        
        // Step 2: Try querying active orders (may include recently closed orders when querying by orderId)
        logger.debug('Order not found in history, trying active orders', {
          tradeId: trade.id,
          symbol,
          orderId: trade.order_id
        });
        
        try {
          const orderInfo = await bybitClient.getActiveOrders({
            category: 'linear',
            symbol: symbol,
            orderId: trade.order_id
          });
          
          if (orderInfo.retCode === 0 && orderInfo.result && orderInfo.result.list && orderInfo.result.list.length > 0) {
            const order = orderInfo.result.list.find((o: any) => {
              const oId = getBybitField<string>(o, 'orderId', 'order_id');
              return oId === trade.order_id;
            });
            
            if (order) {
              const orderStatus = getBybitField<string>(order, 'orderStatus', 'order_status');
              logger.debug('Order found in active orders', {
                tradeId: trade.id,
                symbol,
                orderId: trade.order_id,
                orderStatus
              });
              
              if (orderStatus === 'Filled') {
                // Get position ID if available
                const positions = await bybitClient.getPositionInfo({ category: 'linear', symbol });
                if (positions.retCode === 0 && positions.result && positions.result.list) {
                  const position = positions.result.list.find((p: any) => 
                    p.symbol === symbol && parseFloat(getBybitField<string>(p, 'size') || '0') !== 0
                  );
                  if (position) {
                    const positionIdx = getBybitField<string | number>(position, 'positionIdx', 'position_idx');
                    return { filled: true, positionId: positionIdx?.toString() };
                  }
                }
                return { filled: true };
              }
              // Order is active but not filled
              return { filled: false };
            }
          }
        } catch (error) {
          logger.debug('Error querying active orders', {
            tradeId: trade.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        
        // Step 3: Try querying order history by orderLinkId (in case stored ID is actually a link ID)
        logger.debug('Order not found by orderId, trying orderLinkId', {
          tradeId: trade.id,
          symbol,
          orderLinkId: trade.order_id
        });
        
        try {
          const orderHistoryByLink = await bybitClient.getHistoricOrders({
            category: 'linear',
            symbol: symbol,
            orderLinkId: trade.order_id,
            limit: 10
          });
          
          if (orderHistoryByLink.retCode === 0 && orderHistoryByLink.result && orderHistoryByLink.result.list && orderHistoryByLink.result.list.length > 0) {
            const historicalOrder = orderHistoryByLink.result.list.find((o: any) => {
              const oLinkId = getBybitField<string>(o, 'orderLinkId', 'order_link_id');
              return oLinkId === trade.order_id;
            });
            
            if (historicalOrder) {
              const orderStatus = getBybitField<string>(historicalOrder, 'orderStatus', 'order_status');
              logger.debug('Order found in order history by orderLinkId', {
                tradeId: trade.id,
                symbol,
                orderLinkId: trade.order_id,
                orderStatus
              });
              
              if (orderStatus === 'Filled' || orderStatus === 'PartiallyFilled') {
                // Get position ID if available
                const positions = await bybitClient.getPositionInfo({ category: 'linear', symbol });
                if (positions.retCode === 0 && positions.result && positions.result.list) {
                  const position = positions.result.list.find((p: any) => 
                    p.symbol === symbol && parseFloat(getBybitField<string>(p, 'size') || '0') !== 0
                  );
                  if (position) {
                    const positionIdx = getBybitField<string | number>(position, 'positionIdx', 'position_idx');
                    return { filled: true, positionId: positionIdx?.toString() };
                  }
                }
                return { filled: true };
              }
              // Order found but not filled
              return { filled: false };
            }
          }
        } catch (error) {
          logger.debug('Error querying order history by orderLinkId', {
            tradeId: trade.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        
        // Step 4: Fallback - query order history without filter and search (last resort)
        logger.debug('Order not found by orderId or orderLinkId, falling back to search', {
          tradeId: trade.id,
          symbol,
          orderId: trade.order_id
        });
        
        try {
          const orderHistory = await bybitClient.getHistoricOrders({
            category: 'linear',
            symbol: symbol,
            limit: 50
          });
          
          if (orderHistory.retCode === 0 && orderHistory.result && orderHistory.result.list) {
            const historicalOrder = orderHistory.result.list.find((o: any) => {
              const oId = getBybitField<string>(o, 'orderId', 'order_id');
              const oLinkId = getBybitField<string>(o, 'orderLinkId', 'order_link_id');
              return oId === trade.order_id || oLinkId === trade.order_id;
            });
            
            if (historicalOrder) {
              const orderStatus = getBybitField<string>(historicalOrder, 'orderStatus', 'order_status');
              logger.debug('Order found via fallback search', {
                tradeId: trade.id,
                symbol,
                orderId: trade.order_id,
                orderStatus
              });
              
              if (orderStatus === 'Filled' || orderStatus === 'PartiallyFilled') {
                const positions = await bybitClient.getPositionInfo({ category: 'linear', symbol });
                if (positions.retCode === 0 && positions.result && positions.result.list) {
                  const position = positions.result.list.find((p: any) => 
                    p.symbol === symbol && parseFloat(getBybitField<string>(p, 'size') || '0') !== 0
                  );
                  if (position) {
                    const positionIdx = getBybitField<string | number>(position, 'positionIdx', 'position_idx');
                    return { filled: true, positionId: positionIdx?.toString() };
                  }
                }
                return { filled: true };
              }
            }
          }
        } catch (error) {
          logger.debug('Error in fallback order search', {
            tradeId: trade.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      } else {
        logger.debug('No order_id for trade, checking positions only', {
          tradeId: trade.id,
          symbol
        });
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
      const symbol = normalizeBybitSymbol(trade.trading_pair);
      
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
      const symbol = normalizeBybitSymbol(trade.trading_pair);
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
      const symbol = normalizeBybitSymbol(trade.trading_pair);
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
    if (!trade.entry_filled_at) {
      return;
    }

    // Check if TP orders already exist first (before checking bybitClient)
    // This allows the function to work in simulation mode where orders are created by the initiator/mock exchange
    const existingOrders = await db.getOrdersByTradeId(trade.id);
    const existingTPOrders = existingOrders.filter(o => o.order_type === 'take_profit');
    if (existingTPOrders.length > 0) {
      logger.debug('Take profit orders already exist, skipping placement', {
        tradeId: trade.id,
        existingTPCount: existingTPOrders.length
      });
      return;
    }

    // Only proceed if we have a bybit client and exchange is bybit (for real exchange orders)
    if (!bybitClient || trade.exchange !== 'bybit') {
      logger.debug('Skipping take profit order placement - no bybit client or not bybit exchange', {
        tradeId: trade.id,
        exchange: trade.exchange,
        hasBybitClient: !!bybitClient
      });
      return;
    }

    const takeProfits = JSON.parse(trade.take_profits) as number[];
    if (!takeProfits || takeProfits.length === 0) {
      return;
    }

    const symbol = normalizeBybitSymbol(trade.trading_pair);
    
    // Get position info to determine side and quantity
    // Retry logic: position might not be immediately available after entry fills
    let position: any = null;
    let positionResponse: any = null;
    const maxRetries = 3;
    const retryDelay = 1000; // 1 second
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      positionResponse = await bybitClient.getPositionInfo({
        category: 'linear',
        symbol: symbol
      });

      if (positionResponse.retCode === 0 && positionResponse.result && positionResponse.result.list) {
        // If we have a position_id, try to find the specific position
        if (trade.position_id) {
          position = positionResponse.result.list.find((p: any) => {
            const positionIdx = getBybitField<string | number>(p, 'positionIdx', 'position_idx');
            return p.symbol === symbol && positionIdx?.toString() === trade.position_id;
          });
        }
        
        // If not found by position_id, find any position with non-zero size
        if (!position) {
          const positions = positionResponse.result.list.filter((p: any) => {
            const size = parseFloat(getBybitField<string>(p, 'size') || '0');
            return size !== 0 && p.symbol === symbol;
          });
          if (positions.length > 0) {
            position = positions[0];
          }
        }
        
        if (position) {
          break; // Found position, exit retry loop
        }
      }
      
      // If this wasn't the last attempt, wait before retrying
      if (attempt < maxRetries) {
        logger.debug('Position not found yet, retrying', {
          tradeId: trade.id,
          symbol,
          attempt,
          maxRetries
        });
        await sleep(retryDelay);
      }
    }

    if (!position) {
      logger.warn('No position found for TP order placement after retries', {
        tradeId: trade.id,
        symbol,
        positionId: trade.position_id,
        retCode: positionResponse?.retCode,
        attempts: maxRetries
      });
      return;
    }
    const positionSize = Math.abs(parseFloat(getBybitField<string>(position, 'size') || '0'));
    const positionSizeStr = getBybitField<string>(position, 'size') || '0';
    
    // Use Bybit's side field directly if available (authoritative source)
    // Fall back to inferring from size only if side field is not available
    let positionSide: 'Buy' | 'Sell';
    if (position.side && (position.side === 'Buy' || position.side === 'Sell')) {
      positionSide = position.side as 'Buy' | 'Sell';
    } else {
      // Fallback: infer from size (for backward compatibility)
      positionSide = parseFloat(positionSizeStr) > 0 ? 'Buy' : 'Sell';
      logger.debug('Position side not available, inferred from size', {
        tradeId: trade.id,
        inferredSide: positionSide,
        positionSize: positionSizeStr
      });
    }
    
    // TP side is always opposite of position side
    // For Long (Buy) position, TP is Sell
    // For Short (Sell) position, TP is Buy
    const tpSide = positionSide === 'Buy' ? 'Sell' : 'Buy';
    
    // Get positionIdx from position (use stored position_id if available, otherwise from position)
    const positionIdxFromPosition = getBybitField<string | number>(position, 'positionIdx', 'position_idx');
    let positionIdx: 0 | 1 | 2 = 0; // Default to 0
    if (trade.position_id) {
      // Use the position_id stored in trade (should match positionIdx)
      const storedIdx = parseInt(trade.position_id, 10);
      if (!isNaN(storedIdx) && (storedIdx === 0 || storedIdx === 1 || storedIdx === 2)) {
        positionIdx = storedIdx as 0 | 1 | 2;
      }
    } else if (positionIdxFromPosition !== undefined) {
      // Fallback to positionIdx from position
      const idx = typeof positionIdxFromPosition === 'string' 
        ? parseInt(positionIdxFromPosition, 10) 
        : positionIdxFromPosition;
      if (!isNaN(idx) && (idx === 0 || idx === 1 || idx === 2)) {
        positionIdx = idx as 0 | 1 | 2;
      }
    }

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

    // Validate and redistribute TP quantities (handles qtyStep rounding, minOrderQty, and redistribution)
    const minOrderQty = symbolInfo?.minOrderQty;
    const validTPOrders = validateAndRedistributeTPQuantities(
      tpQuantities,
      roundedTPPrices,
      positionSize,
      qtyStep,
      minOrderQty,
      decimalPrecision
    );

    // Log redistribution if fewer TPs than expected
    if (validTPOrders.length < takeProfits.length) {
      const skippedCount = takeProfits.length - validTPOrders.length;
      const skippedIndices: number[] = [];
      const validIndices = validTPOrders.map(tp => tp.index);
      for (let i = 1; i <= takeProfits.length; i++) {
        if (!validIndices.includes(i)) {
          skippedIndices.push(i);
        }
      }
      
      if (skippedIndices.length > 0 && validTPOrders.length > 0) {
        logger.info('Redistributed skipped TP quantities to remaining TPs', {
          tradeId: trade.id,
          symbol,
          skippedTPs: skippedIndices,
          redistributedTo: validIndices
        });
      }
      
      logger.warn('Placing fewer TP orders than expected due to quantity constraints', {
        tradeId: trade.id,
        symbol,
        expectedTPs: takeProfits.length,
        actualTPs: validTPOrders.length,
        skipped: skippedCount,
        note: 'Some portion of the position may not have TP orders'
      });
    }

    // Log fallback usage for any TP orders that used minOrderQty
    for (const tpOrder of validTPOrders) {
      const originalQty = tpQuantities[tpOrder.index - 1];
      const roundedQty = Math.floor(originalQty / (qtyStep !== undefined && qtyStep > 0 ? qtyStep : Math.pow(10, -decimalPrecision))) * (qtyStep !== undefined && qtyStep > 0 ? qtyStep : Math.pow(10, -decimalPrecision));
      if (tpOrder.quantity === minOrderQty && (roundedQty === 0 || (minOrderQty !== undefined && minOrderQty > 0 && roundedQty < minOrderQty))) {
        logger.warn('Using minimum order quantity as fallback for TP order', {
          tradeId: trade.id,
          tpIndex: tpOrder.index,
          tpPrice: tpOrder.price,
          originalQty: roundedQty,
          minOrderQty,
          note: 'Bybit will adjust quantity to available position size if needed'
        });
      }
    }

    if (validTPOrders.length === 0) {
      logger.error('No valid TP orders to place - all quantities are zero or below minimum', {
        tradeId: trade.id,
        symbol,
        positionSize,
        numTPs: takeProfits.length,
        minOrderQty
      });
      return;
    }

    // Place TP orders
    const tpOrderIds: Array<{ index: number; orderId: string; price: number; quantity: number }> = [];

    for (const tpOrder of validTPOrders) {
      try {
        const tpOrderParams = {
          category: 'linear' as const,
          symbol: symbol,
          side: tpSide as 'Buy' | 'Sell',
          orderType: 'Limit' as const,
          qty: formatQuantity(tpOrder.quantity, decimalPrecision),
          price: tpOrder.price.toString(),
          timeInForce: 'GTC' as const,
          reduceOnly: true,
          closeOnTrigger: false,
          positionIdx: positionIdx,
        };

        logger.debug('Placing take profit order from monitor', {
          tradeId: trade.id,
          symbol,
          tpIndex: tpOrder.index,
          tpPrice: tpOrder.price,
          tpQty: tpOrder.quantity,
          positionSide,
          tpSide,
          positionIdx,
          minOrderQty,
          positionSize: positionSizeStr,
          tradeDirection: trade.direction
        });

        const tpOrderResponse = await bybitClient.submitOrder(tpOrderParams);

        const tpOrderId = getBybitField<string>(tpOrderResponse.result, 'orderId', 'order_id');
        if (tpOrderResponse.retCode === 0 && tpOrderResponse.result && tpOrderId) {
          tpOrderIds.push({
            index: tpOrder.index,
            orderId: tpOrderId,
            price: tpOrder.price,
            quantity: tpOrder.quantity
          });

          // Store TP order in database
          await db.insertOrder({
            trade_id: trade.id,
            order_type: 'take_profit',
            order_id: tpOrderId,
            price: tpOrder.price,
            tp_index: tpOrder.index,
            quantity: tpOrder.quantity,
            status: 'pending'
          });

          logger.info('Take profit order placed by monitor', {
            tradeId: trade.id,
            tpIndex: tpOrder.index,
            tpPrice: tpOrder.price,
            tpQty: tpOrder.quantity,
            tpOrderId
          });
        } else {
          logger.warn('Failed to place take profit order from monitor', {
            tradeId: trade.id,
            tpIndex: tpOrder.index,
            error: JSON.stringify(tpOrderResponse)
          });
        }
      } catch (error) {
        logger.error('Error placing take profit order from monitor', {
          tradeId: trade.id,
          tpIndex: tpOrder.index,
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
      const symbol = normalizeBybitSymbol(trade.trading_pair);
      
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
    // Log trade status at start for debugging
    logger.debug('Monitoring trade', {
      tradeId: trade.id,
      status: trade.status,
      symbol: trade.trading_pair,
      orderId: trade.order_id,
      positionId: trade.position_id,
      entryFilledAt: trade.entry_filled_at
    });

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

    // For pending trades, check if position already exists (entry might have been filled but status not updated)
    if (trade.status === 'pending' && !isSimulation && trade.exchange === 'bybit' && bybitClient) {
      const symbol = normalizeBybitSymbol(trade.trading_pair);
      try {
        const positions = await bybitClient.getPositionInfo({ category: 'linear', symbol });
        if (positions.retCode === 0 && positions.result && positions.result.list) {
          const position = positions.result.list.find((p: any) => 
            p.symbol === symbol && parseFloat(getBybitField<string>(p, 'size') || '0') !== 0
          );
          if (position) {
            const positionIdx = getBybitField<string | number>(position, 'positionIdx', 'position_idx');
            // Update trade status to active
            const fillTime = trade.entry_filled_at || dayjs().toISOString();
            
            // Log the entry fill (same message as the normal flow for consistency)
            logger.info('Entry order filled', { 
              tradeId: trade.id,
              tradingPair: trade.trading_pair,
              entryPrice: trade.entry_price,
              positionId: positionIdx?.toString(),
              channel: trade.channel,
              note: 'Detected via position check - entry was filled but status not updated'
            });
            
            await db.updateTrade(trade.id, {
              status: 'active',
              entry_filled_at: fillTime,
              position_id: positionIdx?.toString()
            });
            trade.status = 'active';
            trade.entry_filled_at = fillTime;
            trade.position_id = positionIdx?.toString();

            // Update entry order to filled status if it exists
            const orders = await db.getOrdersByTradeId(trade.id);
            const entryOrder = orders.find(o => o.order_type === 'entry');
            if (entryOrder && entryOrder.status !== 'filled') {
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
            }

            // Place take profit orders now that entry has filled
            await placeTakeProfitOrders(trade, bybitClient, db);
            // Continue to monitor active trade below
          } else if (trade.order_id) {
            // No position found, but check order history to see if entry was filled
            logger.debug('No position found, checking order history for entry fill', {
              tradeId: trade.id,
              symbol,
              orderId: trade.order_id
            });
            
            try {
              // Try querying order history without orderId filter to search through results
              let orderHistory = await bybitClient.getHistoricOrders({
                category: 'linear',
                symbol: symbol,
                limit: 50
              });
              
              // Also try with orderId filter
              if (orderHistory.retCode === 0 && orderHistory.result && orderHistory.result.list && orderHistory.result.list.length === 0) {
                orderHistory = await bybitClient.getHistoricOrders({
                  category: 'linear',
                  symbol: symbol,
                  orderId: trade.order_id,
                  limit: 10
                });
              }
              
              if (orderHistory.retCode === 0 && orderHistory.result && orderHistory.result.list) {
                const historicalOrder = orderHistory.result.list.find((o: any) => {
                  const oId = getBybitField<string>(o, 'orderId', 'order_id');
                  const oLinkId = getBybitField<string>(o, 'orderLinkId', 'order_link_id');
                  return oId === trade.order_id || oLinkId === trade.order_id;
                });
                
                if (historicalOrder) {
                  const orderStatus = getBybitField<string>(historicalOrder, 'orderStatus', 'order_status');
                  if (orderStatus === 'Filled' || orderStatus === 'PartiallyFilled') {
                    logger.info('Entry order filled (found in order history but no position)', {
                      tradeId: trade.id,
                      symbol,
                      orderId: trade.order_id,
                      orderStatus,
                      note: 'Position may have been closed already'
                    });
                    
                    // Entry was filled but position is closed - update status but can't place TPs
                    const fillTime = trade.entry_filled_at || dayjs().toISOString();
                    await db.updateTrade(trade.id, {
                      status: 'active',
                      entry_filled_at: fillTime
                    });
                    trade.status = 'active';
                    trade.entry_filled_at = fillTime;

                    // Update entry order status
                    const orders = await db.getOrdersByTradeId(trade.id);
                    const entryOrder = orders.find(o => o.order_type === 'entry');
                    if (entryOrder && entryOrder.status !== 'filled') {
                      await db.updateOrder(entryOrder.id, {
                        status: 'filled',
                        filled_at: fillTime,
                        filled_price: trade.entry_price
                      });
                    }
                    
                    logger.warn('Entry was filled but position is closed - TP orders cannot be placed', {
                      tradeId: trade.id,
                      symbol
                    });
                  }
                }
              }
            } catch (historyError) {
              logger.debug('Error checking order history in early position check', {
                tradeId: trade.id,
                symbol,
                error: historyError instanceof Error ? historyError.message : String(historyError)
              });
            }
          }
        }
      } catch (error) {
        logger.debug('Error checking positions for pending trade', {
          tradeId: trade.id,
          symbol,
          error: error instanceof Error ? error.message : String(error)
        });
      }
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
      
      // Get signal type from trade's direction field
      // The buggy logic `currentPrice > trade.entry_price` incorrectly assumes
      // that if price is below entry, it's a short trade, which is wrong.
      const isLong = getIsLong(trade);
      
      if (!trade.direction) {
        logger.debug('Trade direction not set, inferred from price relationships', {
          tradeId: trade.id,
          inferredIsLong: isLong,
          entryPrice: trade.entry_price,
          stopLoss: trade.stop_loss,
          firstTP
        });
      }
      
      const hitSLBeforeEntry = isLong 
        ? currentPrice <= trade.stop_loss
        : currentPrice >= trade.stop_loss;
      const hitTPBeforeEntry = isLong
        ? currentPrice >= firstTP
        : currentPrice <= firstTP;

      // Only cancel if stop loss is hit before entry
      // If TP is hit before entry, that's fine - we'll book the profit when entry fills
      if (hitSLBeforeEntry) {
        logger.info('Price hit SL before entry - cancelling order', {
          tradeId: trade.id,
          currentPrice,
          stopLoss: trade.stop_loss,
          entryPrice: trade.entry_price
        });
        await cancelOrder(trade, bybitClient);
        await db.updateTrade(trade.id, { status: 'cancelled' });
        return;
      }

      // Log if TP is hit before entry, but don't cancel - let it fill and book profit
      if (hitTPBeforeEntry) {
        logger.info('Price hit TP before entry - TP orders will fill and book profit', {
          tradeId: trade.id,
          currentPrice,
          entryPrice: trade.entry_price,
          firstTP,
          note: 'Relevant TP Orders will fill at current price and profit will be booked immediately'
        });
      }

      // Check if entry is filled
      logger.debug('Checking if entry order is filled', {
        tradeId: trade.id,
        symbol: trade.trading_pair,
        orderId: trade.order_id,
        status: trade.status,
        entryPrice: trade.entry_price,
        currentPrice
      });
      const entryResult = await checkEntryFilled(trade, bybitClient, isSimulation, priceProvider);
      logger.debug('Entry fill check result', {
        tradeId: trade.id,
        filled: entryResult.filled,
        positionId: entryResult.positionId
      });
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
          // Adjust for long/short direction - get from trade's direction field
          const isLong = getIsLong(trade);
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
      // Get signal type from trade's direction field
      const isLong = getIsLong(trade);

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
            // Get signal type from trade's direction field to correctly calculate PNL
            const isLong = getIsLong(trade);
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
