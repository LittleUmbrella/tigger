/**
 * Evaluation Initiator
 * 
 * Initiator for evaluation mode that only saves trades to the database
 * without creating actual orders on the exchange.
 */

import { InitiatorContext, InitiatorFunction } from './initiatorRegistry.js';
import { logger } from '../utils/logger.js';
import { validateSymbolWithPriceProvider, getSymbolInfo } from './symbolValidator.js';
import { getDecimalPrecision, roundPrice } from '../utils/positionSizing.js';
import { validateTradePrices } from '../utils/tradeValidation.js';
import dayjs from 'dayjs';


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

  // Check for existing open positions for the same symbol to prevent multiple positions
  // This ensures stop loss always applies to 100% of the position
  const existingTrades = await db.getActiveTrades();
  const existingTradeForSymbol = existingTrades.find(t => 
    t.trading_pair === tradingPairForPriceProvider && 
    (t.status === 'pending' || t.status === 'active' || t.status === 'filled')
  );
  
  if (existingTradeForSymbol) {
    logger.info('Skipping trade - existing open position for symbol', {
      channel,
      tradingPair: order.tradingPair,
      normalizedTradingPair: tradingPairForPriceProvider,
      existingTradeId: existingTradeForSymbol.id,
      existingTradeStatus: existingTradeForSymbol.status,
      existingTradeCreatedAt: existingTradeForSymbol.created_at,
      messageId: message.message_id
    });
    // Mark message as parsed to avoid reprocessing
    await db.markMessageParsed(message.id);
    return;
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

  // Get price precision from price provider if available
  let pricePrecision: number | undefined = undefined;
  if (priceProvider) {
    try {
      const bybitClient = priceProvider.getBybitClient();
      if (bybitClient) {
        const symbolInfo = await getSymbolInfo(bybitClient, normalizedTradingPair);
        pricePrecision = symbolInfo?.pricePrecision;
      }
    } catch (error) {
      // Fallback to inferring from entry price
      pricePrecision = getDecimalPrecision(entryPrice);
    }
  } else {
    pricePrecision = getDecimalPrecision(entryPrice);
  }

  // Round prices to exchange precision
  const roundedEntryPrice = roundPrice(entryPrice, pricePrecision);
  const roundedStopLoss = order.stopLoss && order.stopLoss > 0 
    ? roundPrice(order.stopLoss, pricePrecision)
    : order.stopLoss;
  const roundedTPPrices = order.takeProfits && order.takeProfits.length > 0
    ? order.takeProfits.map(tpPrice => roundPrice(tpPrice, pricePrecision))
    : order.takeProfits;

  // Validate trade prices before proceeding (safety net - parsers should have validated already)
  // This is especially important for market orders where entry price is fetched from price provider
  if (!validateTradePrices(
    order.signalType,
    roundedEntryPrice,
    roundedStopLoss,
    roundedTPPrices,
    { channel, symbol: normalizedTradingPair, messageId: message.message_id }
  )) {
    throw new Error(`Trade validation failed for ${normalizedTradingPair}: Invalid price relationships detected`);
  }

  // In evaluation mode, set quantity to 0 initially
  // Quantities will be recalculated after mock exchanges process trades
  // This allows parallel trade creation while maintaining accurate balance-based position sizing
  const qty = 0;

  // Use baseLeverage as default if leverage is not specified in order
  const baseLeverage = context.config.baseLeverage;
  const effectiveLeverage = order.leverage > 0 ? order.leverage : (baseLeverage || 1);
  
  logger.info('Creating trade with placeholder quantity (will be recalculated after processing)', {
    channel,
    tradingPair: order.tradingPair,
    entryPrice: roundedEntryPrice,
    originalEntryPrice: entryPrice,
    stopLoss: roundedStopLoss,
    leverage: effectiveLeverage,
    baseLeverage,
    pricePrecision
  });

  // Generate a simulation order ID
  const orderId = `EVAL-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  logger.info('Evaluation mode: Simulated order placement', {
    channel,
    orderId,
    tradingPair: order.tradingPair,
    qty,
    price: roundedEntryPrice
  });

  // Store trade in database (use normalized trading pair and rounded prices)
  // Use message date for created_at in evaluation mode to ensure proper historical simulation
  const messageDate = dayjs(message.date);
  const expiresAt = messageDate.add(entryTimeoutDays, 'days').toISOString();
  const tradeId = await db.insertTrade({
    message_id: message.message_id,
    channel: channel,
    trading_pair: tradingPairForPriceProvider, // Use normalized format with slash
    leverage: effectiveLeverage,
    entry_price: roundedEntryPrice,
    stop_loss: roundedStopLoss || order.stopLoss,
    take_profits: JSON.stringify(roundedTPPrices || order.takeProfits),
    risk_percentage: riskPercentage,
    quantity: qty,
    exchange: 'bybit', // Keep as bybit for compatibility
    order_id: orderId,
    direction: order.signalType, // Store direction: 'long' or 'short'
    status: 'pending',
    stop_loss_breakeven: false,
    expires_at: expiresAt,
    created_at: messageDate.toISOString()
  });

  // Store entry order with quantity 0 (will be recalculated later, use rounded price)
  try {
    await db.insertOrder({
      trade_id: tradeId,
      order_type: 'entry',
      order_id: orderId,
      price: roundedEntryPrice,
      quantity: qty, // Will be 0 initially
      status: 'pending'
    });
  } catch (error) {
    logger.warn('Failed to store entry order', {
      tradeId,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  // Store stop loss order (quantity will be updated when trade quantity is calculated)
  // Set quantity to trade quantity if available, otherwise 0 (will be updated later)
  if (roundedStopLoss && roundedStopLoss > 0) {
    try {
      await db.insertOrder({
        trade_id: tradeId,
        order_type: 'stop_loss',
        price: roundedStopLoss,
        quantity: qty, // Will be 0 initially, updated when trade quantity is calculated
        status: 'pending'
      });
    } catch (error) {
      logger.warn('Failed to store stop loss order', {
        tradeId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // Store take profit orders with quantity 0 (will be recalculated later, use rounded prices)
  if (roundedTPPrices && roundedTPPrices.length > 0) {
    for (let i = 0; i < roundedTPPrices.length; i++) {
      try {
        await db.insertOrder({
          trade_id: tradeId,
          order_type: 'take_profit',
          price: roundedTPPrices[i],
          tp_index: i,
          quantity: 0, // Will be recalculated later
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

