/**
 * Evaluation Initiator
 * 
 * Initiator for evaluation mode that only saves trades to the database
 * without creating actual orders on the exchange.
 */

import { InitiatorContext, InitiatorFunction } from './initiatorRegistry.js';
import { logger } from '../utils/logger.js';
import { validateSymbolWithPriceProvider } from './symbolValidator.js';
import dayjs from 'dayjs';

/**
 * Get decimal precision from a price value
 */
const getDecimalPrecision = (price: number): number => {
  if (!isFinite(price)) return 2;
  const priceStr = price.toString();
  if (priceStr.includes('.')) {
    return priceStr.split('.')[1].length;
  }
  return 0;
};

/**
 * Distribute quantity evenly across take profit levels
 */
const distributeQuantityAcrossTPs = (
  totalQty: number,
  numTPs: number,
  decimalPrecision: number
): number[] => {
  if (numTPs === 0) return [];
  
  const qtyPerTP = totalQty / numTPs;
  const roundedQty = Math.floor(qtyPerTP * Math.pow(10, decimalPrecision)) / Math.pow(10, decimalPrecision);
  
  // Distribute remainder to first TP
  const quantities = Array(numTPs).fill(roundedQty);
  const totalDistributed = roundedQty * numTPs;
  const remainder = totalQty - totalDistributed;
  
  if (remainder > 0 && quantities.length > 0) {
    quantities[0] = Math.floor((quantities[0] + remainder) * Math.pow(10, decimalPrecision)) / Math.pow(10, decimalPrecision);
  }
  
  return quantities;
};

/**
 * Evaluation initiator - saves trades to database without exchange calls
 */
export const evaluationInitiator: InitiatorFunction = async (context: InitiatorContext): Promise<void> => {
  const {
    channel,
    riskPercentage,
    entryTimeoutDays,
    message,
    order,
    db,
    isSimulation,
    priceProvider
  } = context;

  // In evaluation mode, we should always be in simulation
  if (!isSimulation) {
    logger.warn('Evaluation initiator should only be used in simulation mode', { channel });
  }

  logger.info('Evaluation initiator: Creating trade', {
    channel,
    tradingPair: order.tradingPair,
    signalType: order.signalType
  });

  // Normalize trading pair to ensure it includes USDT
  // Some parsers return just the symbol (e.g., "BTC") instead of "BTC/USDT" or "BTCUSDT"
  let normalizedTradingPair = order.tradingPair.replace('/', '').toUpperCase();
  if (!normalizedTradingPair.endsWith('USDT')) {
    normalizedTradingPair = normalizedTradingPair + 'USDT';
  }
  // Convert back to format with slash for price provider (e.g., "BTC/USDT")
  const tradingPairForPriceProvider = normalizedTradingPair.slice(0, -4) + '/' + normalizedTradingPair.slice(-4);

  // Validate symbol exists before creating trade
  if (priceProvider) {
    const validation = await validateSymbolWithPriceProvider(priceProvider, tradingPairForPriceProvider);
    if (!validation.valid) {
      logger.error('Invalid symbol, skipping trade', {
        channel,
        tradingPair: order.tradingPair,
        normalizedTradingPair,
        error: validation.error
      });
      throw new Error(`Invalid symbol: ${validation.error}`);
    }
    logger.debug('Symbol validated', { tradingPair: order.tradingPair, normalizedTradingPair });
  }

  // Get current price from price provider if entry price is not provided
  let entryPrice = order.entryPrice;
  if (!entryPrice || entryPrice <= 0) {
    if (priceProvider) {
      try {
        const currentPrice = await priceProvider.getCurrentPrice(tradingPairForPriceProvider);
        if (currentPrice && currentPrice > 0) {
          entryPrice = currentPrice;
          logger.info('Using current price from price provider for entry', {
            tradingPair: order.tradingPair,
            normalizedTradingPair,
            entryPrice
          });
        }
      } catch (error) {
        logger.warn('Failed to get current price from price provider', {
          tradingPair: order.tradingPair,
          normalizedTradingPair,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    
    if (!entryPrice || entryPrice <= 0) {
      throw new Error(`Cannot calculate position size: entry price is required for ${normalizedTradingPair}`);
    }
  }

  // Use a default balance for evaluation (can be configured later)
  const defaultBalance = 10000; // Default evaluation balance
  const balance = defaultBalance;

  // Calculate position size based on risk percentage
  const riskAmount = balance * (riskPercentage / 100);
  const priceDiff = Math.abs(entryPrice - order.stopLoss);
  const riskPerUnit = priceDiff / entryPrice;
  const positionSize = riskAmount / riskPerUnit;
  
  // Calculate quantity
  const decimalPrecision = getDecimalPrecision(entryPrice);
  const qty = Math.floor((positionSize / entryPrice) * Math.pow(10, decimalPrecision)) / Math.pow(10, decimalPrecision);

  logger.info('Calculated trade parameters for evaluation', {
    channel,
    tradingPair: order.tradingPair,
    qty,
    entryPrice,
    leverage: order.leverage,
    decimalPrecision,
    balance
  });

  // Generate a simulation order ID
  const orderId = `EVAL-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  logger.info('Evaluation mode: Simulated order placement', {
    channel,
    orderId,
    tradingPair: order.tradingPair,
    qty,
    price: entryPrice
  });

  // Store trade in database (use normalized trading pair)
  // Use message date for created_at in evaluation mode to ensure proper historical simulation
  const messageDate = dayjs(message.date);
  const expiresAt = messageDate.add(entryTimeoutDays, 'days').toISOString();
  const tradeId = await db.insertTrade({
    message_id: message.message_id,
    channel: channel,
    trading_pair: tradingPairForPriceProvider, // Use normalized format with slash
    leverage: order.leverage,
    entry_price: entryPrice,
    stop_loss: order.stopLoss,
    take_profits: JSON.stringify(order.takeProfits),
    risk_percentage: riskPercentage,
    quantity: qty,
    exchange: 'bybit', // Keep as bybit for compatibility
    order_id: orderId,
    status: 'pending',
    stop_loss_breakeven: false,
    expires_at: expiresAt,
    created_at: messageDate.toISOString()
  });

  // Store entry order
  try {
    await db.insertOrder({
      trade_id: tradeId,
      order_type: 'entry',
      order_id: orderId,
      price: entryPrice,
      quantity: qty,
      status: 'pending'
    });
  } catch (error) {
    logger.warn('Failed to store entry order', {
      tradeId,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  // Store stop loss order
  if (order.stopLoss && order.stopLoss > 0) {
    try {
      await db.insertOrder({
        trade_id: tradeId,
        order_type: 'stop_loss',
        price: order.stopLoss,
        status: 'pending'
      });
    } catch (error) {
      logger.warn('Failed to store stop loss order', {
        tradeId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // Store take profit orders
  if (order.takeProfits && order.takeProfits.length > 0) {
    const tpQuantities = distributeQuantityAcrossTPs(
      qty,
      order.takeProfits.length,
      decimalPrecision
    );

    for (let i = 0; i < order.takeProfits.length; i++) {
      try {
        await db.insertOrder({
          trade_id: tradeId,
          order_type: 'take_profit',
          price: order.takeProfits[i],
          tp_index: i,
          quantity: tpQuantities[i],
          status: 'pending'
        });
      } catch (error) {
        logger.warn('Failed to store take profit order', {
          tradeId,
          tpIndex: i,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  logger.info('Evaluation trade created successfully', {
    channel,
    tradeId,
    orderId,
    tradingPair: order.tradingPair
  });
};

