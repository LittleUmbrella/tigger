import { InitiatorConfig } from '../types/config.js';
import { ParsedOrder } from '../types/order.js';
import { DatabaseManager, Message } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';
import { RESTClient } from 'bybit-api';
import { parseMessage } from '../parsers/signalParser.js';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';

const initiateBybitTrade = async (
  channel: string,
  riskPercentage: number,
  entryTimeoutDays: number,
  message: Message,
  order: ParsedOrder,
  db: DatabaseManager,
  bybitClient: RESTClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider
): Promise<void> => {
  try {
    let balance = 10000; // Default simulation balance
    
    if (!isSimulation && bybitClient) {
      // Get account balance to calculate position size
      const accountInfo = await bybitClient.getWalletBalance({ coin: 'USDT' });
      balance = parseFloat(accountInfo.result?.USDT?.availableBalance || '0');
      
      if (balance === 0) {
        logger.warn('Zero balance available', { channel });
        return;
      }
    } else if (isSimulation) {
      logger.info('Simulation mode: Using default balance', { balance, channel });
    }

    // Calculate position size based on risk percentage
    const riskAmount = balance * (riskPercentage / 100);
    const priceDiff = Math.abs(order.entryPrice - order.stopLoss);
    const riskPerUnit = priceDiff / order.entryPrice;
    const positionSize = riskAmount / riskPerUnit;

    // Convert trading pair to Bybit format (e.g., BTCUSDT)
    const symbol = order.tradingPair.replace('/', '');
    
    // Determine side (Buy for long, Sell for short)
    const side = order.signalType === 'long' ? 'Buy' : 'Sell';
    
    // Calculate quantity (simplified - in production you'd need to handle lot size filters)
    const qty = Math.floor((positionSize / order.entryPrice) * 100) / 100;

    logger.info('Calculated trade parameters', {
      channel,
      symbol,
      side,
      qty,
      entryPrice: order.entryPrice,
      leverage: order.leverage
    });

    // Using Bybit Futures API (linear perpetuals)
    // Create a limit order at entry price
    const orderParams: any = {
      category: 'linear', // Bybit Futures category
      symbol: symbol,
      side: side,
      orderType: 'Limit',
      qty: qty.toString(),
      price: order.entryPrice.toString(),
      timeInForce: 'GTC',
      reduceOnly: false,
      closeOnTrigger: false,
      positionIdx: 0,
    };

    let orderId: string | null = null;

    if (isSimulation) {
      // In simulation mode, generate a fake order ID
      orderId = `SIM-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      logger.info('Simulation mode: Simulated order placement', {
        channel,
        orderId,
        symbol,
        side,
        qty,
        price: order.entryPrice
      });
    } else if (bybitClient) {
      // Set leverage first
      try {
        await bybitClient.setLeverage({
          category: 'linear',
          symbol: symbol,
          buyLeverage: order.leverage.toString(),
          sellLeverage: order.leverage.toString(),
        });
        logger.info('Leverage set', { symbol, leverage: order.leverage });
      } catch (error) {
        logger.warn('Failed to set leverage', {
          symbol,
          leverage: order.leverage,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      // Place the order
      const orderResponse = await bybitClient.submitOrder(orderParams);
      orderId = orderResponse.retCode === 0 
        ? orderResponse.result?.orderId || 'unknown'
        : null;

      if (!orderId) {
        throw new Error(`Order placement failed: ${JSON.stringify(orderResponse)}`);
      }
    } else {
      throw new Error('No Bybit client available and not in simulation mode');
    }

    logger.info('Order placed successfully', {
      channel,
      orderId,
      symbol,
      side
    });

    // Store trade in database
    const expiresAt = dayjs().add(entryTimeoutDays, 'days').toISOString();
    const tradeId = db.insertTrade({
      message_id: message.message_id,
      channel: channel,
      trading_pair: order.tradingPair,
      leverage: order.leverage,
      entry_price: order.entryPrice,
      stop_loss: order.stopLoss,
      take_profits: JSON.stringify(order.takeProfits),
      risk_percentage: riskPercentage,
      exchange: 'bybit',
      order_id: orderId,
      status: 'pending',
      stop_loss_breakeven: false,
      expires_at: expiresAt
    });

    // In simulation mode, pre-fetch price data for this trade
    if (isSimulation && priceProvider) {
      const messageTime = dayjs(message.date);
      const maxDuration = entryTimeoutDays + 1; // Add 1 day buffer
      priceProvider.prefetchPriceData(order.tradingPair, messageTime, maxDuration).catch(error => {
        logger.warn('Failed to pre-fetch price data', {
          tradingPair: order.tradingPair,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }

    logger.info('Trade stored in database', {
      channel,
      messageId: message.message_id,
      orderId
    });
  } catch (error) {
    logger.error('Error initiating Bybit trade', {
      channel,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

const initiateTrade = async (
  channel: string,
  exchange: 'bybit' | 'dex',
  riskPercentage: number,
  entryTimeoutDays: number,
  testnet: boolean,
  message: Message,
  order: ParsedOrder,
  db: DatabaseManager,
  bybitClient: RESTClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider
): Promise<void> => {
  try {
    logger.info('Initiating trade', {
      channel,
      messageId: message.message_id,
      tradingPair: order.tradingPair,
      signalType: order.signalType
    });

    if (exchange === 'bybit') {
      await initiateBybitTrade(channel, riskPercentage, entryTimeoutDays, message, order, db, bybitClient, isSimulation, priceProvider);
    } else if (exchange === 'dex') {
      logger.warn('DEX exchange not yet implemented', { channel });
      // Future implementation
    } else {
      logger.warn('Exchange not configured or client not initialized', {
        channel,
        exchange
      });
    }
  } catch (error) {
    logger.error('Failed to initiate trade', {
      channel,
      messageId: message.message_id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

export const processUnparsedMessages = async (
  initiatorConfig: InitiatorConfig,
  channel: string,
  entryTimeoutDays: number,
  db: DatabaseManager,
  isSimulation: boolean = false,
  priceProvider?: HistoricalPriceProvider,
  parserName?: string
): Promise<void> => {
  const messages = db.getUnparsedMessages(channel);
  
  let bybitClient: RESTClient | undefined;
  if (initiatorConfig.type === 'bybit') {
    // Read Bybit API credentials from environment variables
    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    
    if (!apiKey || !apiSecret) {
      logger.error('Bybit API credentials not found in environment variables', {
        channel,
        missing: !apiKey ? 'BYBIT_API_KEY' : 'BYBIT_API_SECRET'
      });
      return;
    }
    
    bybitClient = new RESTClient({
      key: apiKey,
      secret: apiSecret,
      testnet: initiatorConfig.testnet || false,
    });
    logger.info('Bybit client initialized', { 
      channel, 
      type: initiatorConfig.type,
      testnet: initiatorConfig.testnet 
    });
  }

  // In simulation mode, process messages in chronological order
  const sortedMessages = isSimulation
    ? [...messages].sort((a, b) => {
        const dateA = new Date(a.date).getTime();
        const dateB = new Date(b.date).getTime();
        return dateA - dateB;
      })
    : messages;

  for (const message of sortedMessages) {
    try {
      // In simulation mode, set price provider time to message time
      if (isSimulation && priceProvider) {
        const messageTime = dayjs(message.date);
        priceProvider.setCurrentTime(messageTime);
      }

      const parsed = parseMessage(message.content, parserName);
      if (parsed) {
        await initiateTrade(
          channel, 
          initiatorConfig.type, 
          initiatorConfig.riskPercentage, 
          entryTimeoutDays, 
          initiatorConfig.testnet || false, 
          message, 
          parsed, 
          db, 
          bybitClient,
          isSimulation,
          priceProvider
        );
        // Mark message as parsed after successful initiation
        db.markMessageParsed(message.id);
      }
    } catch (error) {
      logger.error('Error processing message for initiation', {
        channel,
        messageId: message.message_id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
};
