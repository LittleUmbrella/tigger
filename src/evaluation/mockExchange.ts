/**
 * Mock Exchange
 * 
 * Simulates trade execution using historical price data.
 * Processes price changes chronologically to fill orders accurately.
 */

import { DatabaseManager, Trade, Order } from '../db/schema.js';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { logger } from '../utils/logger.js';
import { getDecimalPrecision } from '../utils/positionSizing.js';
import { computeDynamicBreakevenAfterTPs } from '../utils/breakevenAfterTPs.js';
import {
  computeDirectionalPnL,
  selectCanonicalEntryOrder,
  selectCanonicalStopLossOrder,
} from './mockExchangeOrderHelpers.js';
import { clampMarketRangeFillPrice } from './evalEntryResolution.js';
import {
  canSimulatePricePointAtSignal,
  M1_BAR_PERIOD_MS,
} from './mockExchangeBarTiming.js';
import { getRangeBoundaryTpPrice } from '../utils/ctraderMarketRange.js';
import dayjs from 'dayjs';

interface PriceDataPoint {
  timestamp: number;
  price: number; // Close price (for backward compatibility)
  high?: number; // High price of the candle (for TP/SL checks)
  low?: number; // Low price of the candle (for TP/SL checks)
  pointKind?: 'tick' | 'm1';
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

export interface MockExchangeEntryOptions {
  useMarketRangeForEntry?: boolean;
  maxSkippablePastTPs?: number;
  /** M1 width in ms; 0 = tick/point data (only timestamps strictly after signal). */
  barPeriodMs?: number;
  /** cTrader M1: ticks from signal+12s minute, then M1 bars (no look-ahead). */
  useHybridTickM1?: boolean;
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
  breakevenAfterTPs: number = 1, // Ignored when dynamicBreakevenAfterTPs is true
  dynamicBreakevenAfterTPs: boolean = false,
  entryOptions?: MockExchangeEntryOptions
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
    // Set quantity to trade quantity to ensure 100% coverage
    const hasStopLoss = selectCanonicalStopLossOrder(existingOrders) != null;
    if (!hasStopLoss && state.trade.stop_loss) {
      try {
        const stopLossQuantity = state.trade.quantity || 0;
        await db.insertOrder({
          trade_id: state.trade.id,
          order_type: 'stop_loss',
          price: state.trade.stop_loss,
          quantity: stopLossQuantity, // Set to trade quantity for 100% coverage
          status: 'pending'
        });
        logger.debug('Created stop loss order with quantity', {
          tradeId: state.trade.id,
          quantity: stopLossQuantity
        });
      } catch (error) {
        logger.warn('Failed to create stop loss order', {
          tradeId: state.trade.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    } else if (hasStopLoss) {
      // Update existing stop loss order quantity to match trade quantity (ensure 100% coverage)
      const stopLossOrder = selectCanonicalStopLossOrder(existingOrders);
      if (stopLossOrder && state.trade.quantity && state.trade.quantity > 0) {
        // Only update if quantity is missing or doesn't match trade quantity
        if (!stopLossOrder.quantity || stopLossOrder.quantity !== state.trade.quantity) {
          try {
            await db.updateOrder(stopLossOrder.id, {
              quantity: state.trade.quantity
            });
            logger.debug('Updated stop loss order quantity to match trade quantity', {
              tradeId: state.trade.id,
              orderId: stopLossOrder.id,
              quantity: state.trade.quantity
            });
          } catch (error) {
            logger.warn('Failed to update stop loss order quantity', {
              tradeId: state.trade.id,
              orderId: stopLossOrder.id,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
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

  const shouldFillEntry = (pricePoint: PriceDataPoint): boolean => {
    const tolerance = state.trade.entry_price * 0.001; // 0.1% tolerance
    
    if (state.isLong) {
      // For LONG: fill when candle LOW is at or below entry (buy low)
      // Use low if available, otherwise fall back to close price
      const checkPrice = pricePoint.low ?? pricePoint.price;
      return checkPrice <= state.trade.entry_price + tolerance;
    } else {
      // For SHORT: fill when candle HIGH is at or above entry (sell high)
      // Use high if available, otherwise fall back to close price
      const checkPrice = pricePoint.high ?? pricePoint.price;
      return checkPrice >= state.trade.entry_price - tolerance;
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

    // Update entry order to filled status (skip duplicate zero-qty rows from re-eval)
    const orders = await db.getOrdersByTradeId(state.trade.id);
    const entryOrder =
      orders.find((o) => o.order_type === 'entry' && o.status === 'pending') ??
      selectCanonicalEntryOrder(orders);
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

    // If entry filled at a different price, recalculate TP quantities to maintain same position size
    // Position size = quantity * price, so if price changes, quantity must change inversely
    if (Math.abs(price - state.trade.entry_price) > 0.0001 && state.trade.quantity) {
      const originalPositionSize = state.trade.quantity * state.trade.entry_price;
      const adjustedQuantity = originalPositionSize / price;
      
      // Distribute adjusted quantity across TPs
      const distributeQuantityAcrossTPs = (
        totalQty: number,
        numTPs: number,
        decimalPrecision: number
      ): number[] => {
        if (numTPs === 0) return [];
        const qtyPerTP = totalQty / numTPs;
        const roundedQty = Math.floor(qtyPerTP * Math.pow(10, decimalPrecision)) / Math.pow(10, decimalPrecision);
        const quantities = Array(numTPs).fill(roundedQty);
        const totalDistributed = roundedQty * numTPs;
        const remainder = totalQty - totalDistributed;
        if (remainder > 0 && quantities.length > 0) {
          quantities[0] = Math.floor((quantities[0] + remainder) * Math.pow(10, decimalPrecision)) / Math.pow(10, decimalPrecision);
        }
        return quantities;
      };

      const decimalPrecision = getDecimalPrecision(price);
      const tpQuantities = distributeQuantityAcrossTPs(
        adjustedQuantity,
        state.takeProfits.length,
        decimalPrecision
      );

      // Update TP order quantities
      const tpOrders = orders.filter(o => o.order_type === 'take_profit' && o.status === 'pending');
      for (let i = 0; i < tpOrders.length && i < tpQuantities.length; i++) {
        await db.updateOrder(tpOrders[i].id, {
          quantity: tpQuantities[i]
        });
      }

      // Update trade quantity to match actual fill
      await db.updateTrade(state.trade.id, {
        quantity: adjustedQuantity
      });

      // Update stop loss order quantity to match trade quantity (ensure 100% coverage)
      const stopLossOrder = selectCanonicalStopLossOrder(orders);
      if (stopLossOrder) {
        try {
          await db.updateOrder(stopLossOrder.id, {
            quantity: adjustedQuantity
          });
          logger.debug('Updated stop loss order quantity after entry fill', {
            tradeId: state.trade.id,
            orderId: stopLossOrder.id,
            quantity: adjustedQuantity
          });
        } catch (error) {
          logger.warn('Failed to update stop loss order quantity after entry fill', {
            tradeId: state.trade.id,
            orderId: stopLossOrder.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      // Update state
      state.trade.quantity = adjustedQuantity;
      state.remainingQuantity = adjustedQuantity;

      logger.info('Recalculated TP quantities after entry fill at different price', {
        tradeId: state.trade.id,
        originalEntryPrice: state.trade.entry_price,
        fillPrice: price,
        originalQuantity: state.trade.quantity,
        adjustedQuantity,
        originalPositionSize,
        adjustedPositionSize: adjustedQuantity * price,
        tpQuantities
      });
    }

    await recomputePnLFromFilledOrders();
  };

  const shouldFillStopLoss = (pricePoint: PriceDataPoint): boolean => {
    if (state.isLong) {
      // LONG: trigger when price trades at or through SL; fill happens at stop level
      const checkPrice = pricePoint.low ?? pricePoint.price;
      return checkPrice <= state.currentStopLoss;
    } else {
      // SHORT: trigger when price trades at or through SL; fill happens at stop level
      const checkPrice = pricePoint.high ?? pricePoint.price;
      return checkPrice >= state.currentStopLoss;
    }
  };

  const calculatePnL = (exitPrice: number, quantity: number): number => {
    if (!state.entryFillPrice) return 0;
    
    // Quantity must be positive - if negative or zero, this indicates a bug
    if (quantity <= 0) {
      logger.error('calculatePnL called with non-positive quantity - this indicates a bug', {
        tradeId: state.trade.id,
        quantity,
        exitPrice,
        entryFillPrice: state.entryFillPrice,
        remainingQuantity: state.remainingQuantity,
        totalQuantity: state.trade.quantity
      });
      return 0; // Return 0 to avoid incorrect calculations, but log the error
    }

    return computeDirectionalPnL(state.isLong, state.entryFillPrice, exitPrice, quantity);
  };

  const recomputePnLFromFilledOrders = async (): Promise<void> => {
    if (!state.entryFillPrice) return;

    const orders = await db.getOrdersByTradeId(state.trade.id);
    let accumulatedPnL = 0;
    let remainingQty =
      state.trade.quantity || selectCanonicalEntryOrder(orders)?.quantity || 0;
    state.filledTakeProfits.clear();

    for (const order of orders) {
      if (
        order.order_type === 'take_profit' &&
        order.status === 'filled' &&
        order.tp_index !== undefined &&
        order.filled_price
      ) {
        state.filledTakeProfits.add(order.tp_index);
        const tpQuantity =
          order.quantity || (state.trade.quantity || 0) / state.takeProfits.length;
        accumulatedPnL += calculatePnL(order.filled_price, tpQuantity);
        remainingQty -= tpQuantity;
      }
    }

    state.totalPnL = accumulatedPnL;
    state.remainingQuantity = Math.max(0, remainingQty);
  };

  const clearFilledOrder = async (order: Order): Promise<void> => {
    await db.updateOrder(order.id, {
      status: 'pending',
      filled_at: null as unknown as string,
      filled_price: null as unknown as number,
    });
  };

  /** Orphaned fills from prior eval runs (FK was off) must not block this simulation. */
  const resetStaleFilledOrders = async (orders: Order[]): Promise<Order[]> => {
    if (state.trade.exit_filled_at) {
      return orders;
    }

    let resetCount = 0;

    if (state.trade.status === 'pending' && !state.trade.entry_filled_at) {
      for (const order of orders) {
        if (
          (order.order_type === 'take_profit' ||
            order.order_type === 'entry' ||
            order.order_type === 'stop_loss') &&
          order.status === 'filled'
        ) {
          await clearFilledOrder(order);
          resetCount++;
        }
      }
    }

    if (resetCount > 0) {
      logger.warn('Reset stale filled orders on pending trade (orphaned from prior eval run)', {
        tradeId: state.trade.id,
        resetCount,
      });
      return db.getOrdersByTradeId(state.trade.id);
    }

    return orders;
  };

  /** Filled SL rows without a trade exit block TP/SL checks for the rest of the sim. */
  const resetOrphanedStopLossFills = async (): Promise<void> => {
    if (state.trade.exit_filled_at) {
      return;
    }

    const orders = await db.getOrdersByTradeId(state.trade.id);
    const orphanedSl = orders.filter(
      (o) => o.order_type === 'stop_loss' && o.status === 'filled'
    );
    if (orphanedSl.length === 0) {
      return;
    }

    for (const order of orphanedSl) {
      await clearFilledOrder(order);
    }
    state.stopLossFilled = false;

    logger.warn('Reset orphaned filled stop loss orders (trade has no exit)', {
      tradeId: state.trade.id,
      count: orphanedSl.length,
    });
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

    // If stop loss is at breakeven, PNL should be 0 (we moved it to protect profits)
    // Check if current stop loss equals entry fill price (breakeven)
    const isBreakeven = state.entryFillPrice && 
      Math.abs(state.currentStopLoss - state.entryFillPrice) < 0.0001;
    
    let pnlFromSL = 0;
    if (isBreakeven) {
      // Stop loss is at breakeven - PNL should be 0 regardless of actual fill price
      // This protects the profits from TPs that were already filled
      pnlFromSL = 0;
      logger.info('Stop loss hit at breakeven - PNL set to 0 to protect TP profits', {
        tradeId: state.trade.id,
        breakevenPrice: state.currentStopLoss,
        entryFillPrice: state.entryFillPrice,
        fillPrice: price,
        remainingQuantity: state.remainingQuantity
      });
    } else {
      // Calculate PNL only on remaining quantity (after TPs have been filled)
      // If remainingQuantity is 0 but no TPs were filled, use trade quantity instead
      // This handles the case where trade.quantity is null/undefined and remainingQuantity was initialized to 0
      let quantityForPnL = state.remainingQuantity;
      if (quantityForPnL <= 0 && state.filledTakeProfits.size === 0 && state.totalPnL === 0) {
        // No TPs were filled, so we should use the full trade quantity
        // If trade.quantity is still null/undefined, we can't calculate PnL accurately
        quantityForPnL = state.trade.quantity || 0;
        if (quantityForPnL <= 0) {
          logger.warn('Cannot calculate PnL for stop loss - trade quantity is missing', {
            tradeId: state.trade.id,
            tradeQuantity: state.trade.quantity,
            remainingQuantity: state.remainingQuantity,
            filledTPs: state.filledTakeProfits.size
          });
        }
      }
      pnlFromSL = calculatePnL(price, quantityForPnL);
    }
    
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
    const slOrder =
      orders.find((o) => o.order_type === 'stop_loss' && o.status === 'pending') ??
      selectCanonicalStopLossOrder(orders);
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

  const shouldFillTakeProfit = (tpIndex: number, pricePoint: PriceDataPoint): boolean => {
    const tpPrice = state.takeProfits[tpIndex];

    if (state.isLong) {
      // LONG: trigger when high trades at or through TP; fill at TP level (limit TP)
      const checkPrice = pricePoint.high ?? pricePoint.price;
      return checkPrice >= tpPrice;
    } else {
      // SHORT: trigger when low trades at or through TP; fill at TP level (limit TP)
      const checkPrice = pricePoint.low ?? pricePoint.price;
      return checkPrice <= tpPrice;
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
    
    // Track remaining quantity before subtraction for error detection
    const remainingBefore = state.remainingQuantity;
    state.remainingQuantity -= tpQuantity; // Reduce remaining quantity
    
    // Ensure remainingQuantity doesn't go negative (indicates a bug)
    if (state.remainingQuantity < 0) {
      logger.error('remainingQuantity became negative after TP fill', {
        tradeId: state.trade.id,
        tpIndex,
        tpQuantity,
        remainingQuantityBefore: remainingBefore,
        remainingQuantityAfter: state.remainingQuantity,
        totalQuantity: state.trade.quantity
      });
      // Set to 0 to prevent further issues, but this indicates a bug
      state.remainingQuantity = 0;
    }

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
    
    // Update trade PNL after each TP is filled
    const pnlPercentage = state.trade.quantity && state.trade.quantity > 0 && state.entryFillPrice
      ? (state.totalPnL / (state.trade.quantity * state.entryFillPrice)) * 100 * state.trade.leverage
      : 0;
    
    await db.updateTrade(state.trade.id, {
      pnl: state.totalPnL,
      pnl_percentage: pnlPercentage
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
      originalEntryPrice: state.trade.entry_price,
      remainingQuantity: state.remainingQuantity
    });

    await db.updateTrade(state.trade.id, {
      stop_loss: state.currentStopLoss,
      stop_loss_breakeven: true
    });

    // Update stop loss order quantity to match remaining quantity (after TPs filled)
    // This ensures stop loss covers 100% of remaining position
    const orders = await db.getOrdersByTradeId(state.trade.id);
    const stopLossOrder = selectCanonicalStopLossOrder(orders);
    if (stopLossOrder && state.remainingQuantity > 0) {
      try {
        await db.updateOrder(stopLossOrder.id, {
          quantity: state.remainingQuantity
        });
        logger.debug('Updated stop loss order quantity to remaining quantity at breakeven', {
          tradeId: state.trade.id,
          orderId: stopLossOrder.id,
          quantity: state.remainingQuantity
        });
      } catch (error) {
        logger.warn('Failed to update stop loss order quantity at breakeven', {
          tradeId: state.trade.id,
          orderId: stopLossOrder.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  const closeTrade = async (price: number, fillTime: dayjs.Dayjs): Promise<void> => {
    await recomputePnLFromFilledOrders();
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

    // Fetch price history (hybrid tick-then-M1 for cTrader eval when enabled)
    const fetchStartTime = Date.now();
    const useHybridTickM1 =
      entryOptions?.useHybridTickM1 === true && priceProvider.getHybridEvalPriceHistory != null;
    state.priceHistory = useHybridTickM1
      ? await priceProvider.getHybridEvalPriceHistory!(
          state.trade.trading_pair,
          tradeStartTime,
          cappedEndTime
        )
      : await priceProvider.getPriceHistory(
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
        useHybridTickM1,
        tickPoints: useHybridTickM1
          ? state.priceHistory.filter((p) => p.pointKind === 'tick').length
          : undefined,
        m1Points: useHybridTickM1
          ? state.priceHistory.filter((p) => p.pointKind === 'm1').length
          : undefined,
        firstPrice: state.priceHistory[0]?.price,
        lastPrice: state.priceHistory[state.priceHistory.length - 1]?.price,
        firstTimestamp: new Date(state.priceHistory[0]?.timestamp || 0).toISOString(),
        lastTimestamp: new Date(state.priceHistory[state.priceHistory.length - 1]?.timestamp || 0).toISOString(),
        fetchTimeMs: fetchElapsed
      });
    }

    // Initialize state from existing trade (clear orphaned fills when re-simulating pending trades)
    let orders = await resetStaleFilledOrders(await db.getOrdersByTradeId(state.trade.id));

    const filledEntryOrder = selectCanonicalEntryOrder(
      orders.filter((o) => o.order_type === 'entry' && o.status === 'filled' && o.filled_at)
    );
    if (filledEntryOrder) {
      state.entryFilled = true;
      state.entryFillTime = dayjs(filledEntryOrder.filled_at!);
      state.entryFillPrice = filledEntryOrder.filled_price || state.trade.entry_price;
      if (!state.trade.quantity && filledEntryOrder.quantity) {
        state.trade.quantity = filledEntryOrder.quantity;
      }
    } else if (state.trade.entry_filled_at) {
      state.entryFilled = true;
      state.entryFillTime = dayjs(state.trade.entry_filled_at);
      const entryOrder = selectCanonicalEntryOrder(orders);
      state.entryFillPrice = entryOrder?.filled_price || state.trade.entry_price;

      if (!state.trade.quantity && entryOrder?.quantity) {
        state.trade.quantity = entryOrder.quantity;
        logger.info('Using quantity from entry order', {
          tradeId: state.trade.id,
          quantity: entryOrder.quantity
        });
      }
    }

    if (state.trade.stop_loss_breakeven) {
      // Use the actual entry fill price for breakeven stop loss
      const breakevenPrice = state.entryFillPrice || state.trade.entry_price;
      state.currentStopLoss = breakevenPrice;
    }

    if (state.entryFillPrice) {
      await recomputePnLFromFilledOrders();
    } else {
      state.filledTakeProfits.clear();
      state.totalPnL = 0;
      const entryOrder = selectCanonicalEntryOrder(orders);
      state.remainingQuantity = state.trade.quantity || entryOrder?.quantity || 0;
    }
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
    await resetOrphanedStopLossFills();

    // Track entry fill attempts for debugging
    let entryCheckCount = 0;
    let closestPriceToEntry = state.isLong ? Infinity : -Infinity;
    let closestPriceDiff = Infinity;
    
    // Track best price within tolerance for entry fill
    // For LONG: want lowest price (best buy)
    // For SHORT: want highest price (best sell)
    let bestEntryPrice: number | null = null;
    let bestEntryTime: dayjs.Dayjs | null = null;
    let bestEntryIndex: number | null = null;
    const tolerance = state.trade.entry_price * 0.001;
    const isMarketEntry = state.trade.entry_order_type === 'market';
    const tradeStartMs = dayjs(state.trade.created_at).valueOf();
    const barPeriodMs = entryOptions?.barPeriodMs ?? M1_BAR_PERIOD_MS;
    const useHybridTickM1 =
      entryOptions?.useHybridTickM1 === true && priceProvider.getHybridEvalPriceHistory != null;
    const marketRangeBoundaryTp = entryOptions?.useMarketRangeForEntry
      ? getRangeBoundaryTpPrice(state.takeProfits, entryOptions.maxSkippablePastTPs)
      : undefined;
    const resolveMarketFillPrice = (barPrice: number): number => {
      if (marketRangeBoundaryTp == null) {
        return barPrice;
      }
      return clampMarketRangeFillPrice(
        state.isLong ? 'long' : 'short',
        barPrice,
        marketRangeBoundaryTp
      );
    };

    // Process each price point chronologically
    for (let i = 0; i < state.priceHistory.length; i++) {
      const pricePoint = state.priceHistory[i];
      if (
        !useHybridTickM1 &&
        !canSimulatePricePointAtSignal(pricePoint.timestamp, tradeStartMs, barPeriodMs)
      ) {
        continue;
      }
      const priceTime = dayjs(pricePoint.timestamp);
      const price = pricePoint.price;

      // Check if entry should fill
      if (!state.entryFilled) {
        if (isMarketEntry) {
          const fillPrice = resolveMarketFillPrice(price);
          logger.info('Mock exchange: Market entry filled on first price after eval delay', {
            tradeId: state.trade.id,
            tradingPair: state.trade.trading_pair,
            quotePrice: state.trade.entry_price,
            fillPrice,
            useMarketRange: marketRangeBoundaryTp != null,
            boundaryTp: marketRangeBoundaryTp,
            priceTime: priceTime.toISOString(),
          });
          await fillEntry(fillPrice, priceTime);
        } else {
          entryCheckCount++;
          const priceDiff = Math.abs(price - state.trade.entry_price);
          
          // Track closest price to entry (for debugging)
          if (priceDiff < closestPriceDiff) {
            closestPriceDiff = priceDiff;
            closestPriceToEntry = price;
          }
          
          // Check if price is within tolerance for entry fill
          if (shouldFillEntry(pricePoint)) {
            // Track best price within tolerance window
            // For LONG: best = lowest price (best buy) - use low if available
            // For SHORT: best = highest price (best sell) - use high if available
            const entryCheckPrice = state.isLong 
              ? (pricePoint.low ?? pricePoint.price)
              : (pricePoint.high ?? pricePoint.price);
            
            if (bestEntryPrice === null) {
              bestEntryPrice = entryCheckPrice;
              bestEntryTime = priceTime;
              bestEntryIndex = i;
            } else {
              const isBetter = state.isLong 
                ? entryCheckPrice < bestEntryPrice  // LONG: lower is better
                : entryCheckPrice > bestEntryPrice; // SHORT: higher is better
              
              if (isBetter) {
                bestEntryPrice = entryCheckPrice;
                bestEntryTime = priceTime;
                bestEntryIndex = i;
              }
            }
          } else if (bestEntryPrice !== null && bestEntryTime !== null && bestEntryIndex !== null) {
            // Price moved outside tolerance window - fill at best price we found
            // Fill at the best price we encountered while within tolerance
            logger.info('Entry fill condition met (best price within tolerance)', {
              tradeId: state.trade.id,
              tradingPair: state.trade.trading_pair,
              entryPrice: state.trade.entry_price,
              fillPrice: bestEntryPrice,
              priceDiff: Math.abs(bestEntryPrice - state.trade.entry_price),
              tolerance,
              isLong,
              priceTime: bestEntryTime.toISOString()
            });
            await fillEntry(bestEntryPrice, bestEntryTime);
            // Reset tracking variables
            bestEntryPrice = null;
            bestEntryTime = null;
            bestEntryIndex = null;
          }
        }
      }

      // Only check stop loss and take profits after entry is filled
      if (state.entryFilled && !state.stopLossFilled) {
        // Check if stop loss should fill (use high/low from candle)
        if (shouldFillStopLoss(pricePoint)) {
          // Position stop (cTrader setTradingStop): fill at stop level, not bar/tick extreme
          await fillStopLoss(state.currentStopLoss, priceTime);
          return true; // Trade is done
        }

        // Check if take profits should fill (use high/low from candle)
        for (let tpIndex = 0; tpIndex < state.takeProfits.length; tpIndex++) {
          if (!state.filledTakeProfits.has(tpIndex) && shouldFillTakeProfit(tpIndex, pricePoint)) {
            // Limit TP: fill at declared TP price, not bar extreme
            await fillTakeProfit(tpIndex, state.takeProfits[tpIndex], priceTime);
            
            // Move stop loss to breakeven after N TPs are filled
            // Count filled TPs (including the one we just filled)
            const filledTPCount = state.filledTakeProfits.size;
            const breakevenThreshold = dynamicBreakevenAfterTPs
              ? computeDynamicBreakevenAfterTPs(state.takeProfits.length)
              : breakevenAfterTPs;
            if (filledTPCount >= breakevenThreshold && !state.trade.stop_loss_breakeven) {
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

    // If we've processed all price points but entry hasn't filled,
    // check if we found a best price within tolerance and fill it
    if (!state.entryFilled && bestEntryPrice !== null && bestEntryTime !== null) {
      logger.info('Filling entry at best price found within tolerance (end of price history)', {
        tradeId: state.trade.id,
        tradingPair: state.trade.trading_pair,
        entryPrice: state.trade.entry_price,
        fillPrice: bestEntryPrice,
        priceDiff: Math.abs(bestEntryPrice - state.trade.entry_price),
        tolerance,
        isLong,
        priceTime: bestEntryTime.toISOString()
      });
      await fillEntry(bestEntryPrice, bestEntryTime);
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

    return false;
  };

  return {
    initialize,
    process
  };
}
