/**
 * Evaluation Initiator
 * 
 * Initiator for evaluation mode that only saves trades to the database
 * without creating actual orders on the exchange.
 */

import { InitiatorContext, InitiatorFunction } from './initiatorRegistry.js';
import { logger } from '../utils/logger.js';
import { serializeErrorForLog } from '../utils/errorUtils.js';
import { validateSymbolWithPriceProvider, getSymbolInfo, getCTraderSymbolInfo } from './symbolValidator.js';
import { getDecimalPrecision, roundPrice } from '../utils/positionSizing.js';
import { validateTradePrices } from '../utils/tradeValidation.js';
import { assertMinRiskReward } from '../utils/minRiskReward.js';
import {
  filterTakeProfitsAtMarketQuote,
  resolveEvalEntryMode,
} from '../evaluation/evalEntryResolution.js';
import dayjs from 'dayjs';


/**
 * Evaluation initiator - saves trades to database without exchange calls
 */
export const evaluationInitiator: InitiatorFunction = async (context: InitiatorContext): Promise<void> => {
  const {
    channel,
    riskPercentage,
    entryTimeoutMinutes,
    message,
    order,
    db,
    isSimulation,
    priceProvider,
    allowConcurrentSymbolTrades,
    useLimitOrderForEntry,
    useMarketRangeForEntry,
    maxSkippablePastTPs,
    minRiskReward,
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

  // Normalize trading pair based on price provider (Bybit vs cTrader)
  const isCTrader = typeof priceProvider?.getCTraderClient === 'function';
  let normalizedTradingPair = order.tradingPair.replace('/', '').toUpperCase();
  let tradingPairForPriceProvider: string;

  if (isCTrader) {
    // cTrader: EURUSD, XAUUSD - forex/CFD symbols
    if (!normalizedTradingPair.endsWith('USD')) {
      normalizedTradingPair = normalizedTradingPair.replace(/USDT$|USDC$/, '') + 'USD';
    }
    tradingPairForPriceProvider = `${normalizedTradingPair.slice(0, -3)}/${normalizedTradingPair.slice(-3)}`;
  } else {
    // Bybit: crypto, ensure USDT
    if (!normalizedTradingPair.endsWith('USDT') && !normalizedTradingPair.endsWith('USDC')) {
      normalizedTradingPair = normalizedTradingPair + 'USDT';
    }
    tradingPairForPriceProvider = normalizedTradingPair.slice(0, -4) + '/' + normalizedTradingPair.slice(-4);
  }

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

  // Block stacked same-symbol trades unless channel allows concurrent (mirrors live initiator).
  if (!allowConcurrentSymbolTrades) {
    const existingTrades = await db.getActiveTrades();
    const existingTradeForSymbol = existingTrades.find(
      (t) =>
        t.channel === channel &&
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
      await db.markMessageParsed(message.id);
      return;
    }
  }

  // Get price precision and pip size from price provider if available
  let pricePrecision: number | undefined = undefined;
  let pipSize: number | undefined = undefined;
  if (priceProvider) {
    try {
      const ctraderClient = priceProvider.getCTraderClient?.();
      if (ctraderClient) {
        const symbolInfo = await getCTraderSymbolInfo(ctraderClient, normalizedTradingPair);
        pricePrecision = symbolInfo?.pricePrecision;
        pipSize = symbolInfo?.tickSize;
      } else {
        const bybitClient = priceProvider.getBybitClient();
        if (bybitClient) {
          const symbolInfo = await getSymbolInfo(bybitClient, normalizedTradingPair, true);
          pricePrecision = symbolInfo?.pricePrecision;
        }
      }
    } catch (error) {
      pricePrecision = order.entryPrice ? getDecimalPrecision(order.entryPrice) : undefined;
    }
  }
  if (pricePrecision === undefined) {
    pricePrecision = order.entryPrice ? getDecimalPrecision(order.entryPrice) : 2;
  }

  const roundedStopLoss = order.stopLoss && order.stopLoss > 0
    ? roundPrice(order.stopLoss, pricePrecision)
    : order.stopLoss;
  let roundedTPPrices = order.takeProfits && order.takeProfits.length > 0
    ? order.takeProfits.map(tpPrice => roundPrice(tpPrice, pricePrecision))
    : order.takeProfits;

  const useLimitAtTouch = useLimitOrderForEntry !== false && !order.marketExecution;
  const needsQuotePrice = !useLimitAtTouch || !order.entryPrice || order.entryPrice <= 0;

  let quotePrice: number | undefined = order.entryPrice && order.entryPrice > 0
    ? order.entryPrice
    : undefined;

  if (needsQuotePrice && priceProvider) {
    try {
      const currentPrice = await priceProvider.getCurrentPrice(tradingPairForPriceProvider);
      if (currentPrice && currentPrice > 0) {
        quotePrice = currentPrice;
        logger.info('Using current price from price provider for entry', {
          tradingPair: order.tradingPair,
          normalizedTradingPair,
          quotePrice
        });
      }
    } catch (error) {
      logger.warn('Failed to get current price from price provider', {
        tradingPair: order.tradingPair,
        normalizedTradingPair,
        error: serializeErrorForLog(error)
      });
    }
  }

  const entryMode = resolveEvalEntryMode({
    order,
    useLimitOrderForEntry,
    useMarketRangeForEntry,
    maxSkippablePastTPs,
    currentPrice: quotePrice,
    pipSize,
  });

  let roundedEntryPrice: number;
  if (entryMode.entryOrderType === 'limit') {
    if (!order.entryPrice || order.entryPrice <= 0) {
      throw new Error(`Cannot calculate position size: entry price is required for ${normalizedTradingPair}`);
    }
    roundedEntryPrice = roundPrice(order.entryPrice, pricePrecision);
  } else {
    if (!quotePrice || quotePrice <= 0) {
      throw new Error(`Cannot calculate position size: entry price is required for ${normalizedTradingPair}`);
    }
    roundedEntryPrice = roundPrice(quotePrice, pricePrecision);

    const { activeTPs, skippedTPs } = filterTakeProfitsAtMarketQuote(
      order.signalType,
      roundedTPPrices ?? [],
      roundedEntryPrice,
      maxSkippablePastTPs ?? 0
    );
    if (skippedTPs.length > 0) {
      logger.info('Skipped TPs already past quote price for market entry', {
        channel,
        tradingPair: order.tradingPair,
        quotePrice: roundedEntryPrice,
        skippedTPs,
        activeTPs,
        maxSkippablePastTPs: maxSkippablePastTPs ?? 0,
      });
    }
    roundedTPPrices = activeTPs;
  }

  // Validate trade prices before proceeding (safety net - parsers should have validated already)
  if (!validateTradePrices(
    order.signalType,
    roundedEntryPrice,
    roundedStopLoss,
    roundedTPPrices,
    { channel, symbol: normalizedTradingPair, messageId: message.message_id }
  )) {
    throw new Error(`Trade validation failed for ${normalizedTradingPair}: Invalid price relationships detected`);
  }

  if (roundedStopLoss && roundedTPPrices && roundedTPPrices.length > 0) {
    assertMinRiskReward({
      minRiskReward,
      signalType: order.signalType,
      entryPrice: roundedEntryPrice,
      stopLoss: roundedStopLoss,
      takeProfits: roundedTPPrices,
      context: {
        channel,
        symbol: normalizedTradingPair,
        messageId: message.message_id,
      },
    });
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
    entryOrderType: entryMode.entryOrderType,
    useMarketRange: entryMode.useMarketRange,
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
  const expiresAt = messageDate.add(entryTimeoutMinutes, 'minutes').toISOString();
  const tradeId = await db.insertTrade({
    message_id: message.message_id,
    channel: channel,
    trading_pair: tradingPairForPriceProvider, // Use normalized format with slash
    leverage: effectiveLeverage,
    entry_price: roundedEntryPrice,
    entry_order_type: entryMode.entryOrderType,
    stop_loss: roundedStopLoss || order.stopLoss,
    take_profits: JSON.stringify(roundedTPPrices || order.takeProfits),
    risk_percentage: riskPercentage,
    quantity: qty,
    exchange: isCTrader ? 'ctrader' : 'bybit',
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
      error: serializeErrorForLog(error)
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
        error: serializeErrorForLog(error)
      });
    }
  }

  // Store take profit orders with quantity 0 (will be recalculated later, use rounded prices)
  if (roundedTPPrices && roundedTPPrices.length > 0) {
    // Get existing orders to check for duplicates
    const existingOrders = await db.getOrdersByTradeId(tradeId);
    const existingTPOrdersByIndex = new Set(
      existingOrders
        .filter(o => o.order_type === 'take_profit' && o.tp_index !== undefined)
        .map(o => o.tp_index!)
    );

    for (let i = 0; i < roundedTPPrices.length; i++) {
      const tpIndex = i; // Use 0-based TP index to match mockExchange and evaluationOrchestrator
      
      // Check if TP order with this index already exists
      if (existingTPOrdersByIndex.has(tpIndex)) {
        logger.warn('Skipping duplicate take profit order - order with same tp_index already exists', {
          tradeId,
          tpIndex,
          price: roundedTPPrices[i]
        });
        continue;
      }

      try {
        await db.insertOrder({
          trade_id: tradeId,
          order_type: 'take_profit',
          price: roundedTPPrices[i],
          tp_index: tpIndex,
          quantity: 0, // Will be recalculated later
          status: 'pending'
        });
        
        // Add to set to prevent duplicates within this batch
        existingTPOrdersByIndex.add(tpIndex);
      } catch (error) {
        logger.warn('Failed to store take profit order', {
          tradeId,
          tpIndex: i,
          error: serializeErrorForLog(error)
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

