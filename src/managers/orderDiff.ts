import { ParsedOrder } from '../types/order.js';
import { Trade } from '../db/schema.js';

/**
 * Differences detected between old and new parsed orders
 */
export interface OrderDiff {
  entryPriceChanged: boolean;
  stopLossChanged: boolean;
  takeProfitsChanged: boolean;
  leverageChanged: boolean;
  tradingPairChanged: boolean;
  signalTypeChanged: boolean;
  oldOrder: ParsedOrder | null;
  newOrder: ParsedOrder | null;
}

/**
 * Compare a parsed order with an existing trade to detect changes
 */
export function diffOrderWithTrade(
  newOrder: ParsedOrder,
  trade: Trade
): OrderDiff {
  const oldTakeProfits = JSON.parse(trade.take_profits) as number[];
  
  // Normalize entry price - use first entry target if available, otherwise entryPrice
  const newEntryPrice = newOrder.entryTargets?.[0] || newOrder.entryPrice;
  const oldEntryPrice = trade.entry_price;
  
  // Compare take profits arrays
  const takeProfitsEqual = 
    oldTakeProfits.length === newOrder.takeProfits.length &&
    oldTakeProfits.every((tp, i) => Math.abs(tp - newOrder.takeProfits[i]) < 0.0001);

  // Handle undefined entry price (market orders)
  const entryPriceChanged = newEntryPrice !== undefined && oldEntryPrice !== null
    ? Math.abs(newEntryPrice - oldEntryPrice) > 0.0001
    : newEntryPrice !== oldEntryPrice; // Changed if one is undefined and other isn't

  return {
    entryPriceChanged,
    stopLossChanged: Math.abs(newOrder.stopLoss - trade.stop_loss) > 0.0001,
    takeProfitsChanged: !takeProfitsEqual,
    leverageChanged: newOrder.leverage !== trade.leverage,
    tradingPairChanged: newOrder.tradingPair !== trade.trading_pair,
    signalTypeChanged: false, // We don't store signalType in trade, so can't compare
    oldOrder: null, // We don't have the old parsed order, only the trade
    newOrder: newOrder
  };
}

/**
 * Compare two parsed orders to detect changes
 */
export function diffOrders(
  oldOrder: ParsedOrder,
  newOrder: ParsedOrder
): OrderDiff {
  // Normalize entry prices
  const oldEntryPrice = oldOrder.entryTargets?.[0] || oldOrder.entryPrice;
  const newEntryPrice = newOrder.entryTargets?.[0] || newOrder.entryPrice;
  
  // Compare take profits arrays
  const takeProfitsEqual = 
    oldOrder.takeProfits.length === newOrder.takeProfits.length &&
    oldOrder.takeProfits.every((tp, i) => Math.abs(tp - newOrder.takeProfits[i]) < 0.0001);

  // Handle undefined entry price (market orders)
  const entryPriceChanged = newEntryPrice !== undefined && oldEntryPrice !== undefined
    ? Math.abs(newEntryPrice - oldEntryPrice) > 0.0001
    : newEntryPrice !== oldEntryPrice; // Changed if one is undefined and other isn't

  return {
    entryPriceChanged,
    stopLossChanged: Math.abs(newOrder.stopLoss - oldOrder.stopLoss) > 0.0001,
    takeProfitsChanged: !takeProfitsEqual,
    leverageChanged: newOrder.leverage !== oldOrder.leverage,
    tradingPairChanged: newOrder.tradingPair !== oldOrder.tradingPair,
    signalTypeChanged: newOrder.signalType !== oldOrder.signalType,
    oldOrder: oldOrder,
    newOrder: newOrder
  };
}

