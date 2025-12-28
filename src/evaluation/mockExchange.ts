/**
 * Mock Exchange
 * 
 * Simulates trade execution using historical price data.
 * Processes price changes chronologically to fill orders accurately.
 */

import { DatabaseManager, Trade, Order } from '../db/schema.js';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';

interface PriceDataPoint {
  timestamp: number;
  price: number;
}

interface MockExchangeState {
  trade: Trade;
  priceHistory: PriceDataPoint[];
  entryFilled: boolean;
  entryFillTime?: dayjs.Dayjs;
  entryFillPrice?: number;
  stopLossFilled: boolean;
  filledTakeProfits: Set<number>;
  currentStopLoss: number;
  takeProfits: number[];
  isLong: boolean;
  remainingQuantity: number; // Track remaining quantity after TP fills
  totalPnL: number; // Accumulated PNL from filled TPs
}

export interface MockExchange {
  initialize: (maxDurationDays?: number) => Promise<void>;
  process: () => Promise<boolean>;
}

/**
 * Create a mock exchange that simulates trade execution using historical price data
 */
export function createMockExchange(
  trade: Trade,
  db: DatabaseManager,
  priceProvider: HistoricalPriceProvider,
  breakevenAfterTPs: number = 1 // Number of TPs to hit before moving to breakeven (default: 1)
): MockExchange {
  const takeProfits = JSON.parse(trade.take_profits) as number[];
  const isLong = trade.entry_price > trade.stop_loss;

  // Initialize state
  const state: MockExchangeState = {
    trade,
    priceHistory: [],
    entryFilled: false,
    stopLossFilled: false,
    filledTakeProfits: new Set(),
    currentStopLoss: trade.stop_loss,
    takeProfits,
    isLong,
    remainingQuantity: trade.quantity || 0, // Start with full quantity
    totalPnL: 0 // Accumulated PNL from filled TPs
  };

  const ensureOrdersExist = async (): Promise<void> => {
    const existingOrders = await db.getOrdersByTradeId(state.trade.id);
    
    // Create stop loss order if missing
    const hasStopLoss = existingOrders.some(o => o.order_type === 'stop_loss');
    if (!hasStopLoss && state.trade.stop_loss) {
      try {
        await db.insertOrder({
          trade_id: state.trade.id,
          order_type: 'stop_loss',
          price: state.trade.stop_loss,
          status: 'pending'
        });
      } catch (error) {
        logger.warn('Failed to create stop loss order', {
          tradeId: state.trade.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // Create take profit orders if missing
    for (let tpIndex = 0; tpIndex < state.takeProfits.length; tpIndex++) {
      const hasTP = existingOrders.some(o => 
        o.order_type === 'take_profit' && o.tp_index === tpIndex
      );
      
      if (!hasTP) {
        try {
          await db.insertOrder({
            trade_id: state.trade.id,
            order_type: 'take_profit',
            price: state.takeProfits[tpIndex],
            tp_index: tpIndex,
            status: 'pending'
          });
        } catch (error) {
          logger.warn('Failed to create take profit order', {
            tradeId: state.trade.id,
            tpIndex,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  };

  const shouldFillEntry = (price: number): boolean => {
    const tolerance = state.trade.entry_price * 0.001; // 0.1% tolerance
    
    if (state.isLong) {
      return price >= state.trade.entry_price - tolerance;
    } else {
      return price <= state.trade.entry_price + tolerance;
    }
  };

  const fillEntry = async (price: number, fillTime: dayjs.Dayjs): Promise<void> => {
    state.entryFilled = true;
    state.entryFillTime = fillTime;
    state.entryFillPrice = price;

    logger.info('Mock exchange: Entry filled', {
      tradeId: state.trade.id,
      entryPrice: state.trade.entry_price,
      fillPrice: price,
      fillTime: fillTime.toISOString()
    });

    // Update trade
    await db.updateTrade(state.trade.id, {
      status: 'active',
      entry_filled_at: fillTime.toISOString(),
      entry_price: price, // Update to actual fill price
      position_id: `SIM-${state.trade.id}`
    });

    // Update entry order to filled status
    const orders = await db.getOrdersByTradeId(state.trade.id);
    const entryOrder = orders.find(o => o.order_type === 'entry');
    if (entryOrder) {
      await db.updateOrder(entryOrder.id, {
        status: 'filled',
        filled_at: fillTime.toISOString(),
        filled_price: price
      });
      logger.debug('Entry order updated to filled', {
        tradeId: state.trade.id,
        orderId: entryOrder.id,
        fillPrice: price
      });
    } else {
      logger.warn('Entry order not found when filling entry', {
        tradeId: state.trade.id
      });
    }
  };

  const shouldFillStopLoss = (price: number): boolean => {
    if (state.isLong) {
      return price <= state.currentStopLoss;
    } else {
      return price >= state.currentStopLoss;
    }
  };

  const calculatePnL = (exitPrice: number, quantity: number): number => {
    if (!state.entryFillPrice || quantity <= 0) return 0;

    const priceDiff = state.isLong
      ? exitPrice - state.entryFillPrice
      : state.entryFillPrice - exitPrice;

    const positionSize = quantity * state.entryFillPrice;
    
    return priceDiff * (positionSize / state.entryFillPrice) * state.trade.leverage;
  };

  const calculatePnLPercentage = (exitPrice: number, quantity: number, totalQuantity: number): number => {
    if (!state.entryFillPrice || totalQuantity <= 0) return 0;

    const priceDiff = state.isLong
      ? exitPrice - state.entryFillPrice
      : state.entryFillPrice - exitPrice;

    const priceChangePercent = (priceDiff / state.entryFillPrice) * 100;
    // Weight by quantity proportion
    const quantityWeight = quantity / totalQuantity;
    return priceChangePercent * state.trade.leverage * quantityWeight;
  };

  const fillStopLoss = async (price: number, fillTime: dayjs.Dayjs): Promise<void> => {
    state.stopLossFilled = true;

    // Calculate PNL only on remaining quantity (after TPs have been filled)
    const pnlFromSL = calculatePnL(price, state.remainingQuantity);
    const totalPnL = state.totalPnL + pnlFromSL; // Add PNL from stop loss to accumulated TP PNL
    const pnlPercentage = state.trade.quantity && state.trade.quantity > 0
      ? (totalPnL / (state.trade.quantity * state.entryFillPrice!)) * 100 * state.trade.leverage
      : 0;

    logger.info('Mock exchange: Stop loss filled', {
      tradeId: state.trade.id,
      stopLoss: state.currentStopLoss,
      fillPrice: price,
      fillTime: fillTime.toISOString(),
      remainingQuantity: state.remainingQuantity,
      pnlFromSL,
      accumulatedTPPnL: state.totalPnL,
      totalPnL,
      pnlPercentage
    });

    const orders = await db.getOrdersByTradeId(state.trade.id);
    const slOrder = orders.find(o => o.order_type === 'stop_loss' && o.status === 'pending');
    if (slOrder) {
      await db.updateOrder(slOrder.id, {
        status: 'filled',
        filled_at: fillTime.toISOString(),
        filled_price: price
      });
    }

    await db.updateTrade(state.trade.id, {
      status: 'stopped',
      exit_price: price,
      exit_filled_at: fillTime.toISOString(),
      pnl: totalPnL,
      pnl_percentage: pnlPercentage
    });
  };

  const shouldFillTakeProfit = (tpIndex: number, price: number): boolean => {
    const tpPrice = state.takeProfits[tpIndex];
    
    if (state.isLong) {
      return price >= tpPrice;
    } else {
      return price <= tpPrice;
    }
  };

  const fillTakeProfit = async (tpIndex: number, price: number, fillTime: dayjs.Dayjs): Promise<void> => {
    state.filledTakeProfits.add(tpIndex);

    // Get TP order to find its quantity
    const orders = await db.getOrdersByTradeId(state.trade.id);
    const tpOrder = orders.find(o => 
      o.order_type === 'take_profit' && 
      o.tp_index === tpIndex && 
      o.status === 'pending'
    );

    if (!tpOrder) {
      logger.warn('Take profit order not found', {
        tradeId: state.trade.id,
        tpIndex
      });
      return;
    }

    // Get quantity for this TP (use order quantity if available, otherwise distribute evenly)
    const tpQuantity = tpOrder.quantity || (state.trade.quantity || 0) / state.takeProfits.length;
    
    // Calculate PNL for this TP
    const tpPnL = calculatePnL(price, tpQuantity);
    state.totalPnL += tpPnL; // Accumulate PNL
    state.remainingQuantity -= tpQuantity; // Reduce remaining quantity

    logger.info('Mock exchange: Take profit filled', {
      tradeId: state.trade.id,
      tpIndex,
      tpPrice: state.takeProfits[tpIndex],
      fillPrice: price,
      fillTime: fillTime.toISOString(),
      tpQuantity,
      tpPnL,
      accumulatedPnL: state.totalPnL,
      remainingQuantity: state.remainingQuantity
    });
    
    await db.updateOrder(tpOrder.id, {
      status: 'filled',
      filled_at: fillTime.toISOString(),
      filled_price: price
    });
  };

  const moveStopLossToBreakeven = async (): Promise<void> => {
    // Use the actual entry fill price for breakeven, not the original order price
    // This ensures PnL is 0 when breakeven stop loss is hit
    const breakevenPrice = state.entryFillPrice || state.trade.entry_price;
    state.currentStopLoss = breakevenPrice;

    logger.info('Mock exchange: Moving stop loss to breakeven', {
      tradeId: state.trade.id,
      newStopLoss: state.currentStopLoss,
      entryFillPrice: state.entryFillPrice,
      originalEntryPrice: state.trade.entry_price
    });

    await db.updateTrade(state.trade.id, {
      stop_loss: state.currentStopLoss,
      stop_loss_breakeven: true
    });
  };

  const closeTrade = async (price: number, fillTime: dayjs.Dayjs): Promise<void> => {
    // All TPs are filled, so totalPnL already contains the sum of all TP PNLs
    const totalPnL = state.totalPnL;
    const pnlPercentage = state.trade.quantity && state.trade.quantity > 0 && state.entryFillPrice
      ? (totalPnL / (state.trade.quantity * state.entryFillPrice)) * 100 * state.trade.leverage
      : 0;

    logger.info('Mock exchange: Trade closed (all TPs filled)', {
      tradeId: state.trade.id,
      exitPrice: price,
      fillTime: fillTime.toISOString(),
      totalPnL,
      pnlPercentage,
      filledTPs: state.filledTakeProfits.size,
      remainingQuantity: state.remainingQuantity
    });

    await db.updateTrade(state.trade.id, {
      status: 'closed',
      exit_price: price,
      exit_filled_at: fillTime.toISOString(),
      pnl: totalPnL,
      pnl_percentage: pnlPercentage
    });
  };

  const cancelTrade = async (): Promise<void> => {
    logger.info('Mock exchange: Trade cancelled (expired)', {
      tradeId: state.trade.id,
      expiresAt: state.trade.expires_at
    });

    await db.updateTrade(state.trade.id, {
      status: 'cancelled'
    });
  };

  const initialize = async (maxDurationDays: number = 7): Promise<void> => {
    // Reload trade to get latest state
    const trades = await db.getTradesByStatus('pending');
    const activeTrades = await db.getTradesByStatus('active');
    const allTrades = [...trades, ...activeTrades];
    const updatedTrade = allTrades.find(t => t.id === state.trade.id);
    
    if (updatedTrade) {
      state.trade = updatedTrade;
    }

    // If trade is already closed/cancelled, skip
    if (state.trade.status === 'closed' || state.trade.status === 'stopped' || state.trade.status === 'cancelled') {
      logger.debug('Trade already completed, skipping simulation', {
        tradeId: state.trade.id,
        status: state.trade.status
      });
      return;
    }

    const tradeStartTime = dayjs(state.trade.created_at);
    const tradeEndTime = tradeStartTime.add(maxDurationDays, 'day');
    const now = dayjs();
    
    // Check if trade is in the future
    if (tradeStartTime.isAfter(now)) {
      logger.warn('Trade is in the future, skipping price history fetch', {
        tradeId: state.trade.id,
        tradingPair: state.trade.trading_pair,
        tradeCreatedAt: tradeStartTime.toISOString(),
        currentTime: now.toISOString(),
        daysInFuture: tradeStartTime.diff(now, 'day', true).toFixed(2)
      });
      state.priceHistory = [];
      return;
    }
    
    // Cap end time to current time if it's in the future
    const cappedEndTime = tradeEndTime.isAfter(now) ? now : tradeEndTime;
    
    logger.debug('Initializing mock exchange price history', {
      tradeId: state.trade.id,
      tradingPair: state.trade.trading_pair,
      startTime: tradeStartTime.toISOString(),
      requestedEndTime: tradeEndTime.toISOString(),
      cappedEndTime: cappedEndTime.toISOString(),
      isFuture: tradeEndTime.isAfter(now)
    });

    // Fetch price history
    const fetchStartTime = Date.now();
    state.priceHistory = await priceProvider.getPriceHistory(
      state.trade.trading_pair,
      tradeStartTime,
      cappedEndTime
    );
    const fetchElapsed = Date.now() - fetchStartTime;

    if (state.priceHistory.length === 0) {
      logger.warn('No price history available for trade', {
        tradeId: state.trade.id,
        tradingPair: state.trade.trading_pair,
        startTime: tradeStartTime.toISOString(),
        endTime: cappedEndTime.toISOString(),
        fetchTimeMs: fetchElapsed
      });
    } else {
      logger.debug('Price history loaded', {
        tradeId: state.trade.id,
        pricePoints: state.priceHistory.length,
        firstPrice: state.priceHistory[0]?.price,
        lastPrice: state.priceHistory[state.priceHistory.length - 1]?.price,
        firstTimestamp: new Date(state.priceHistory[0]?.timestamp || 0).toISOString(),
        lastTimestamp: new Date(state.priceHistory[state.priceHistory.length - 1]?.timestamp || 0).toISOString(),
        fetchTimeMs: fetchElapsed
      });
    }

    // Initialize state from existing trade
    const orders = await db.getOrdersByTradeId(state.trade.id);
    
    if (state.trade.entry_filled_at) {
      state.entryFilled = true;
      state.entryFillTime = dayjs(state.trade.entry_filled_at);
      // Use entry_filled_price if available, otherwise fall back to entry_price
      // Check orders to find the actual fill price
      const entryOrder = orders.find(o => o.order_type === 'entry' && o.filled_at);
      state.entryFillPrice = entryOrder?.filled_price || state.trade.entry_price;
    }

    if (state.trade.stop_loss_breakeven) {
      // Use the actual entry fill price for breakeven stop loss
      const breakevenPrice = state.entryFillPrice || state.trade.entry_price;
      state.currentStopLoss = breakevenPrice;
    }

    // Check which TPs are already filled and calculate accumulated PNL
    let remainingQty = state.trade.quantity || 0;
    let accumulatedPnL = 0;

    for (const order of orders) {
      if (order.order_type === 'take_profit' && order.status === 'filled' && order.tp_index !== undefined) {
        state.filledTakeProfits.add(order.tp_index);
        
        // Calculate PNL for this filled TP
        if (order.filled_price && state.entryFillPrice) {
          const tpQuantity = order.quantity || (state.trade.quantity || 0) / state.takeProfits.length;
          const tpPnL = calculatePnL(order.filled_price, tpQuantity);
          accumulatedPnL += tpPnL;
          remainingQty -= tpQuantity;
        }
      }
      if (order.order_type === 'stop_loss' && order.status === 'filled') {
        state.stopLossFilled = true;
      }
    }

    // Update state with restored values
    state.remainingQuantity = Math.max(0, remainingQty); // Ensure non-negative
    state.totalPnL = accumulatedPnL;
  };

  const process = async (): Promise<boolean> => {
    if (state.priceHistory.length === 0) {
      logger.warn('Cannot process trade - no price history', {
        tradeId: state.trade.id,
        tradingPair: state.trade.trading_pair,
        tradeCreatedAt: state.trade.created_at,
        tradeStatus: state.trade.status
      });
      
      // If trade hasn't been filled and we have no price data, mark as cancelled
      if (!state.entryFilled && state.trade.status === 'pending') {
        await cancelTrade();
      }
      
      return true; // Consider trade done if no data
    }
    
    logger.debug('Processing trade with price history', {
      tradeId: state.trade.id,
      tradingPair: state.trade.trading_pair,
      pricePoints: state.priceHistory.length,
      entryFilled: state.entryFilled,
      stopLossFilled: state.stopLossFilled,
      filledTakeProfits: Array.from(state.filledTakeProfits).length,
      totalTakeProfits: state.takeProfits.length,
      entryPrice: state.trade.entry_price,
      stopLoss: state.trade.stop_loss,
      isLong,
      tradeCreatedAt: state.trade.created_at,
      expiresAt: state.trade.expires_at,
      firstPrice: state.priceHistory[0]?.price,
      lastPrice: state.priceHistory[state.priceHistory.length - 1]?.price,
      firstTimestamp: state.priceHistory[0] ? new Date(state.priceHistory[0].timestamp).toISOString() : null,
      lastTimestamp: state.priceHistory[state.priceHistory.length - 1] ? new Date(state.priceHistory[state.priceHistory.length - 1].timestamp).toISOString() : null
    });

    // Ensure orders exist (they might not be created in simulation mode)
    await ensureOrdersExist();

    // Track entry fill attempts for debugging
    let entryCheckCount = 0;
    let closestPriceToEntry = state.isLong ? Infinity : -Infinity;
    let closestPriceDiff = Infinity;

    // Process each price point chronologically
    for (let i = 0; i < state.priceHistory.length; i++) {
      const pricePoint = state.priceHistory[i];
      const priceTime = dayjs(pricePoint.timestamp);
      const price = pricePoint.price;

      // Check if entry should fill
      if (!state.entryFilled) {
        entryCheckCount++;
        const tolerance = state.trade.entry_price * 0.001;
        const priceDiff = Math.abs(price - state.trade.entry_price);
        
        // Track closest price to entry
        if (priceDiff < closestPriceDiff) {
          closestPriceDiff = priceDiff;
          closestPriceToEntry = price;
        }
        
        if (shouldFillEntry(price)) {
          logger.info('Entry fill condition met', {
            tradeId: state.trade.id,
            tradingPair: state.trade.trading_pair,
            entryPrice: state.trade.entry_price,
            fillPrice: price,
            priceDiff,
            tolerance,
            isLong,
            priceTime: priceTime.toISOString()
          });
          await fillEntry(price, priceTime);
        }
      }

      // Only check stop loss and take profits after entry is filled
      if (state.entryFilled && !state.stopLossFilled) {
        // Check if stop loss should fill
        if (shouldFillStopLoss(price)) {
          await fillStopLoss(price, priceTime);
          return true; // Trade is done
        }

        // Check if take profits should fill
        for (let tpIndex = 0; tpIndex < state.takeProfits.length; tpIndex++) {
          if (!state.filledTakeProfits.has(tpIndex) && shouldFillTakeProfit(tpIndex, price)) {
            await fillTakeProfit(tpIndex, price, priceTime);
            
            // Move stop loss to breakeven after N TPs are filled
            // Count filled TPs (including the one we just filled)
            const filledTPCount = state.filledTakeProfits.size;
            if (filledTPCount >= breakevenAfterTPs && !state.trade.stop_loss_breakeven) {
              await moveStopLossToBreakeven();
            }
          }
        }

        // Check if all take profits are filled
        if (state.filledTakeProfits.size === state.takeProfits.length) {
          await closeTrade(price, priceTime);
          return true; // Trade is done
        }
      }

      // Check if trade expired before entry
      if (!state.entryFilled) {
        const expiresAt = dayjs(state.trade.expires_at);
        if (priceTime.isAfter(expiresAt)) {
          await cancelTrade();
          return true; // Trade expired
        }
      }
    }

    // If we've processed all price points but trade isn't complete,
    // check if we should mark it as expired or still pending
    if (!state.entryFilled) {
      const lastPriceTime = dayjs(state.priceHistory[state.priceHistory.length - 1].timestamp);
      const expiresAt = dayjs(state.trade.expires_at);
      
      // Log why entry didn't fill
      logger.warn('Entry never filled after processing all price points', {
        tradeId: state.trade.id,
        tradingPair: state.trade.trading_pair,
        entryPrice: state.trade.entry_price,
        stopLoss: state.trade.stop_loss,
        isLong,
        entryChecks: entryCheckCount,
        closestPriceToEntry,
        closestPriceDiff,
        closestPriceDiffPercent: ((closestPriceDiff / state.trade.entry_price) * 100).toFixed(2) + '%',
        tolerance: (state.trade.entry_price * 0.001).toFixed(6),
        tolerancePercent: '0.1%',
        firstPrice: state.priceHistory[0]?.price,
        lastPrice: state.priceHistory[state.priceHistory.length - 1]?.price,
        priceRange: state.isLong 
          ? `${state.priceHistory[0]?.price} - ${state.priceHistory[state.priceHistory.length - 1]?.price}`
          : `${state.priceHistory[state.priceHistory.length - 1]?.price} - ${state.priceHistory[0]?.price}`,
        lastPriceTime: lastPriceTime.toISOString(),
        expiresAt: expiresAt.toISOString(),
        expired: lastPriceTime.isAfter(expiresAt)
      });
      
      if (lastPriceTime.isAfter(expiresAt)) {
        await cancelTrade();
        return true;
      }
    }

    // Trade is still active (price history ended but trade didn't complete)
    return false;
  };

  return {
    initialize,
    process
  };
}
